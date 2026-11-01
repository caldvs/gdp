import * as cdk from 'aws-cdk-lib';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import type { Construct } from 'constructs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tableSchema } from './tableSchema.js';
import { GithubDeployStack, deployRoleName } from './githubDeploy.js';
import { CostReportStack } from './costReport.js';
import { ALLOWED_ORIGINS } from '../src/config/allowedOrigins.js';

// apps/api lives inside the Group Dine Pay monorepo; the npm lockfile is
// at the repo root, which is what NodejsFunction treats as the project.
const API_DIR = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = path.resolve(API_DIR, '../..');
const API_DIR_FROM_REPO_ROOT = path.relative(REPO_ROOT, API_DIR) || '.';

type EnvName = 'dev' | 'prod';

interface GdpStackProps extends cdk.StackProps {
  envName: EnvName;
}

class GdpBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GdpStackProps) {
    super(scope, id, props);
    const { envName } = props;
    // Browser origins for the API and the bills bucket (src/config/allowedOrigins.ts).
    const allowedOrigins = ALLOWED_ORIGINS[envName];

    cdk.Tags.of(this).add('project', 'gdp-backend');
    cdk.Tags.of(this).add('env', envName);

    const removalPolicy = envName === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    const table = new ddb.Table(this, 'Table', {
      tableName: `gdp-${envName}`,
      partitionKey: { name: tableSchema.partitionKey, type: ddb.AttributeType.STRING },
      sortKey: { name: tableSchema.sortKey, type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: tableSchema.ttlAttribute,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: envName === 'prod' },
      removalPolicy,
    });

    for (const gsi of tableSchema.globalSecondaryIndexes) {
      table.addGlobalSecondaryIndex({
        indexName: gsi.indexName,
        partitionKey: { name: gsi.partitionKey, type: ddb.AttributeType.STRING },
        ...('sortKey' in gsi && gsi.sortKey
          ? { sortKey: { name: gsi.sortKey, type: ddb.AttributeType.STRING } }
          : {}),
      });
    }

    const billsBucket = new s3.Bucket(this, 'BillsBucket', {
      bucketName: `gdp-bills-raw-${envName}-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Browser clients PUT directly to presigned URLs from the web app's
      // origin. Same list as the API's CORS.
      cors: [
        {
          allowedOrigins,
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 600,
        },
      ],
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
          expiration: cdk.Duration.days(365),
        },
      ],
      removalPolicy,
      autoDeleteObjects: envName !== 'prod',
    });

    // Public-ish config — SSM Parameter Store, resolved at deploy time.
    // Verified SES sender address. Set once via:
    //   aws ssm put-parameter --name /gdp-{env}/ses-from-email --type String ...
    //   aws ses verify-email-identity --email-address <same address>
    // When unset the runtime ConsoleEmailSender takes over and logs would-
    // be emails instead of sending. We keep this required at the SSM level
    // for deployed envs so missing config fails the deploy, not at runtime.
    const sesFromEmail = ssm.StringParameter.valueForStringParameter(
      this,
      `/gdp-${envName}/ses-from-email`,
    );

    // Secrets — Secrets Manager, read by the Lambda at cold start
    // (src/config/runtimeSecrets.ts). The function's configuration holds only
    // their names (SECRET_SOURCES), so no value is visible in the Lambda
    // console or the CloudFormation template, and a rotated secret is picked
    // up by the next cold start without a redeploy. A missing secret shows up
    // in the post-deploy smoke test and dependency check, not at deploy time.
    const secretSources: Record<string, string> = {
      SESSION_JWT_SECRET: `gdp-${envName}/session-jwt-secret`,
    };
    // TrueLayer (pay-by-bank) is off: PAYMENT_PROVIDER is `manual`. Its
    // settings are only used with TRUELAYER_ENABLED=true (a GitHub
    // environment variable, or `-c truelayer=true` locally), so a new
    // environment doesn't need placeholder TrueLayer secrets to deploy.
    const trueLayerEnabled =
      process.env.TRUELAYER_ENABLED === 'true' || this.node.tryGetContext('truelayer') === 'true';
    const trueLayerEnv: Record<string, string> = trueLayerEnabled
      ? {
          TRUELAYER_CLIENT_ID: ssm.StringParameter.valueForStringParameter(
            this,
            `/gdp-${envName}/truelayer-client-id`,
          ),
          TRUELAYER_SIGNING_KID: ssm.StringParameter.valueForStringParameter(
            this,
            `/gdp-${envName}/truelayer-signing-kid`,
          ),
          TRUELAYER_ENVIRONMENT: 'sandbox',
        }
      : {};
    if (trueLayerEnabled) {
      Object.assign(secretSources, {
        TRUELAYER_CLIENT_SECRET: `gdp-${envName}/truelayer-client-secret`,
        TRUELAYER_WEBHOOK_SECRET: `gdp-${envName}/truelayer-webhook-secret`,
        TRUELAYER_SIGNING_PRIVATE_KEY_PEM: `gdp-${envName}/truelayer-signing-private-key`,
      });
    }

    // Stripe (the lead's table fee) is off until its secrets exist. Turn it on with
    // STRIPE_ENABLED=true (a GitHub environment variable the deploy
    // workflow passes through, or `-c stripe=true` locally) once
    // gdp-<env>/stripe-secret-key and gdp-<env>/stripe-webhook-secret
    // are in Secrets Manager. APP_BASE_URL is where Stripe sends the lead
    // back after paying.
    const stripeEnabled =
      process.env.STRIPE_ENABLED === 'true' || this.node.tryGetContext('stripe') === 'true';
    const appBaseUrl: string | undefined =
      process.env.APP_BASE_URL || (this.node.tryGetContext('appBaseUrl') as string | undefined);
    if (stripeEnabled) {
      Object.assign(secretSources, {
        STRIPE_SECRET_KEY: `gdp-${envName}/stripe-secret-key`,
        STRIPE_WEBHOOK_SECRET: `gdp-${envName}/stripe-webhook-secret`,
      });
    }

    // The bill reader: Claude Haiku on Bedrock through the EU cross-region
    // inference profile (requests stay in EU regions). Override with
    // `-c bedrockModelId=…`.
    const bedrockModelId =
      (this.node.tryGetContext('bedrockModelId') as string | undefined) ??
      'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

    const apiLogs = new logs.LogGroup(this, 'ApiHandlerLogs', {
      retention: envName === 'prod' ? logs.RetentionDays.SIX_MONTHS : logs.RetentionDays.ONE_MONTH,
      removalPolicy,
    });

    const fn = new nodejs.NodejsFunction(this, 'ApiHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(API_DIR, 'src/lambda.ts'),
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, 'package-lock.json'),
      handler: 'handler',
      memorySize: 1024,
      // API Gateway gives up on a request at 30s whatever this says, and the
      // synchronous /v1/bills/parse budgets itself under that. 60s is for
      // background bill reads (POST /v1/bills/reads), which this function
      // runs by invoking itself, outside API Gateway, with a 45s budget.
      timeout: cdk.Duration.seconds(60),
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        // Node and libraries run in production mode everywhere deployed;
        // APP_ENV says which environment (env.ts).
        NODE_ENV: 'production',
        APP_ENV: envName,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
        DDB_TABLE_NAME: table.tableName,
        S3_BUCKET_BILLS: billsBucket.bucketName,
        LOG_LEVEL: envName === 'prod' ? 'info' : 'debug',
        // Test accounts (@test.invalid, no code) on dev only.
        AUTH_TEST_ACCOUNTS: envName === 'dev' ? 'true' : 'false',

        SECRET_SOURCES: JSON.stringify(secretSources),

        BEDROCK_MODEL_ID: bedrockModelId,
        VENUE_LOOKUP: 'amazon-location',
        SES_FROM_EMAIL: sesFromEmail,

        ...trueLayerEnv,
        // `manual` = guests pay the lead via their own banking app (Monzo/
        // Revolut deep links if available, raw sort+account otherwise),
        // lead confirms receipt manually. Free of TrueLayer fees. Switch
        // to `truelayer` once TL Live commercial onboarding is in place.
        PAYMENT_PROVIDER: 'manual',
        ...(appBaseUrl ? { APP_BASE_URL: appBaseUrl } : {}),
        ALLOWED_ORIGINS: allowedOrigins.join(','),
      },
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: 'node22',
        minify: envName === 'prod',
        sourceMap: true,
        // The AWS SDK clients the Lambda runtime already ships. The Amazon
        // Location Places client is bundled instead: it's newer than the
        // runtime's pinned SDK may be.
        externalModules: [
          '@aws-sdk/client-bedrock-runtime',
          '@aws-sdk/client-dynamodb',
          '@aws-sdk/client-s3',
          '@aws-sdk/client-secrets-manager',
          '@aws-sdk/client-sesv2',
          '@aws-sdk/lib-dynamodb',
          '@aws-sdk/s3-request-presigner',
        ],
        // pino + some transitive deps still use `require()` even when
        // bundled as ESM. Provide a CJS-compatible require so the bundle
        // can resolve them at module load.
        banner:
          "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
        // Ship openapi.yaml alongside the bundled lambda.js so the
        // /docs and /openapi.yaml routes can resolve it at runtime
        // (routes/docs.ts already looks for it next to import.meta.url).
        //
        // In the monorepo the lockfile (and so CDK's projectRoot /
        // inputDir) is the repo root, so resolve apps/api relative to it.
        // Relative rather than absolute keeps Docker bundling working.
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp ${inputDir}/${API_DIR_FROM_REPO_ROOT}/openapi.yaml ${outputDir}/openapi.yaml`,
          ],
        },
      },
      logGroup: apiLogs,
    });

    table.grantReadWriteData(fn);

    // Only this environment's secrets (names under gdp-<env>/; Secrets
    // Manager adds a random suffix to each ARN). Read at cold start.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:gdp-${envName}/*`,
        ],
      }),
    );

    // Bedrock: the inference profile and the models it routes to, in any EU
    // region the profile picks.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
          'arn:aws:bedrock:*::foundation-model/*',
        ],
      }),
    );
    // Anthropic models on Bedrock are sold through AWS Marketplace. The first
    // call in each region the EU profile routes to completes the account's
    // subscription, and fails with AccessDeniedException unless the caller
    // may view and accept it.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['aws-marketplace:ViewSubscriptions', 'aws-marketplace:Subscribe'],
        resources: ['*'],
      }),
    );
    billsBucket.grantReadWrite(fn);

    // Venue lookup (src/services/bills/locationVenueResolver.ts): Amazon
    // Location Service Places, which has no resources of its own.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['geo-places:SearchText'],
        resources: [`arn:aws:geo-places:${this.region}::provider/default`],
      }),
    );

    // SES send permission for the EmailSender. Scoped to the verified-
    // identity ARN pattern we provisioned out-of-band; covers SendEmail
    // (templated + simple) and SendRawEmail. Cheap, no resource refs in
    // the IAM policy because the verified identity is account-wide.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: ['*'],
      }),
    );
    // Read-only, for the post-deploy dependency check (src/ops/selfCheck.ts):
    // is the sender verified, and is the account out of the SES sandbox.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:GetAccount', 'ses:GetEmailIdentity'],
        resources: ['*'],
      }),
    );
    // Background bill reads: the function invokes itself asynchronously.
    // Named by pattern rather than fn.functionArn, which would make the
    // role's policy depend on the function that depends on the role.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [
          `arn:aws:lambda:${this.region}:${this.account}:function:${this.stackName}-ApiHandler*`,
        ],
      }),
    );
    // A read records its own failure, so Lambda shouldn't retry it, and one
    // that waited minutes in the queue is no use to someone at the table.
    fn.configureAsyncInvoke({ retryAttempts: 0, maxEventAge: cdk.Duration.minutes(2) });

    // Lets this environment's GitHub deploy role (infra/githubDeploy.ts)
    // invoke the function directly for that check. Granted here rather than
    // in that stack so the normal CI deploy keeps it in step with the function.
    fn.grantInvoke(
      iam.Role.fromRoleName(this, 'GithubDeployRole', deployRoleName(envName), { mutable: true }),
    );

    // Custom API domain (api.paymeback.dev / api.test.paymeback.dev). DNS is
    // on Vercel, so the ACM certificate is requested and validated by hand and
    // its ARN comes from the GitHub environment (API_DOMAIN, API_CERT_ARN).
    // Without both, the API stays on its execute-api URL only.
    const apiDomain =
      process.env.API_DOMAIN || (this.node.tryGetContext('apiDomain') as string | undefined);
    const apiCertArn =
      process.env.API_CERT_ARN || (this.node.tryGetContext('apiCertArn') as string | undefined);
    const domainName =
      apiDomain && apiCertArn
        ? new apigw.DomainName(this, 'ApiDomain', {
            domainName: apiDomain,
            certificate: acm.Certificate.fromCertificateArn(this, 'ApiCert', apiCertArn),
          })
        : undefined;

    const httpApi = new apigw.HttpApi(this, 'HttpApi', {
      apiName: `gdp-${envName}`,
      defaultIntegration: new integrations.HttpLambdaIntegration('LambdaIntegration', fn),
      ...(domainName ? { defaultDomainMapping: { domainName } } : {}),
    });
    if (domainName) {
      // The CNAME to add in Vercel DNS: <api name> → this value.
      new cdk.CfnOutput(this, 'ApiDomainTargetOutput', { value: domainName.regionalDomainName });
      new cdk.CfnOutput(this, 'ApiDomainUrlOutput', { value: `https://${apiDomain}` });
    }

    // The TrueLayer return URL has to match what's registered in the Console.
    // We resolve it from the API endpoint so a stack re-create still produces
    // a coherent value in the Lambda env — but the Console-side URL must be
    // updated by hand if the API endpoint ever changes.
    if (trueLayerEnabled) {
      fn.addEnvironment('TRUELAYER_RETURN_URI', `${httpApi.apiEndpoint}/v1/payments/return`);
    }

    // ---------------- Observability: alarms ----------------

    // SNS topic for alarm notifications. Email subscribers are added
    // post-deploy via the AWS console (or `aws sns subscribe` from the
    // CLI) so the email address isn't baked into source / version
    // control. See RUNBOOK.md for the one-click subscription steps.
    const alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: `gdp-${envName}-alerts`,
      displayName: `Group Dine Pay (${envName}) alerts`,
    });

    const snsAction = new cwActions.SnsAction(alertTopic);
    const period5m = cdk.Duration.minutes(5);

    const lambdaErrorsAlarm = new cw.Alarm(this, 'LambdaErrorsAlarm', {
      alarmName: `gdp-${envName}-lambda-errors`,
      alarmDescription: 'Lambda has thrown errors. See RUNBOOK.md "lambda-errors" for diagnosis.',
      metric: fn.metricErrors({ period: period5m, statistic: 'Sum' }),
      threshold: 3,
      evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
    lambdaErrorsAlarm.addAlarmAction(snsAction);
    lambdaErrorsAlarm.addOkAction(snsAction);

    const lambdaP99Alarm = new cw.Alarm(this, 'LambdaDurationP99Alarm', {
      alarmName: `gdp-${envName}-lambda-duration-p99`,
      alarmDescription: 'Lambda p99 duration > 10s for 5m. See RUNBOOK.md "lambda-duration".',
      metric: fn.metricDuration({ period: period5m, statistic: 'p99' }),
      threshold: 10_000,
      evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
    lambdaP99Alarm.addAlarmAction(snsAction);

    const api5xxAlarm = new cw.Alarm(this, 'Api5xxAlarm', {
      alarmName: `gdp-${envName}-api-5xx`,
      alarmDescription: 'API Gateway saw >5 5xx responses in 5m. See RUNBOOK.md "api-5xx".',
      metric: new cw.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '5xx',
        dimensionsMap: { ApiId: httpApi.apiId, Stage: '$default' },
        period: period5m,
        statistic: 'Sum',
      }),
      threshold: 5,
      evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
    api5xxAlarm.addAlarmAction(snsAction);
    api5xxAlarm.addOkAction(snsAction);

    const ddbThrottleAlarm = new cw.Alarm(this, 'DdbThrottleAlarm', {
      alarmName: `gdp-${envName}-ddb-throttles`,
      alarmDescription: 'DynamoDB throttled at least one request. See RUNBOOK.md "ddb-throttle".',
      metric: new cw.Metric({
        namespace: 'AWS/DynamoDB',
        metricName: 'ThrottledRequests',
        dimensionsMap: { TableName: table.tableName },
        period: period5m,
        statistic: 'Sum',
      }),
      threshold: 0,
      evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
    ddbThrottleAlarm.addAlarmAction(snsAction);

    // ---------------- Observability: dashboard ----------------

    const dashboard = new cw.Dashboard(this, 'Dashboard', {
      dashboardName: `gdp-${envName}`,
      defaultInterval: cdk.Duration.hours(3),
    });

    const apiDimensions = { ApiId: httpApi.apiId, Stage: '$default' };
    const tableDimensions = { TableName: table.tableName };
    const sumP5m = { period: period5m, statistic: 'Sum' as const };

    const apiCount = new cw.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: 'Count',
      dimensionsMap: apiDimensions,
      ...sumP5m,
    });
    const api4xx = new cw.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: '4xx',
      dimensionsMap: apiDimensions,
      ...sumP5m,
    });
    const api5xx = new cw.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: '5xx',
      dimensionsMap: apiDimensions,
      ...sumP5m,
    });

    dashboard.addWidgets(
      new cw.GraphWidget({
        title: 'API requests / 5min',
        width: 8,
        height: 6,
        left: [apiCount],
      }),
      new cw.GraphWidget({
        title: 'API 4xx / 5min',
        width: 8,
        height: 6,
        left: [api4xx],
      }),
      new cw.GraphWidget({
        title: 'API 5xx / 5min',
        width: 8,
        height: 6,
        left: [api5xx],
      }),
    );

    dashboard.addWidgets(
      new cw.GraphWidget({
        title: 'Lambda invocations + errors / 5min',
        width: 8,
        height: 6,
        left: [
          fn.metricInvocations({ ...sumP5m, label: 'Invocations' }),
          fn.metricErrors({ ...sumP5m, label: 'Errors' }),
        ],
      }),
      new cw.GraphWidget({
        title: 'Lambda duration p50 / p99 (ms)',
        width: 8,
        height: 6,
        left: [
          fn.metricDuration({ period: period5m, statistic: 'p50', label: 'p50' }),
          fn.metricDuration({ period: period5m, statistic: 'p99', label: 'p99' }),
        ],
      }),
      new cw.GraphWidget({
        title: 'Lambda throttles + concurrency',
        width: 8,
        height: 6,
        left: [fn.metricThrottles({ ...sumP5m, label: 'Throttles' })],
        right: [
          new cw.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'ConcurrentExecutions',
            dimensionsMap: { FunctionName: fn.functionName },
            period: period5m,
            statistic: 'Maximum',
            label: 'Concurrent (max)',
          }),
        ],
      }),
    );

    dashboard.addWidgets(
      new cw.GraphWidget({
        title: 'DDB consumed read units / 5min',
        width: 8,
        height: 6,
        left: [
          new cw.Metric({
            namespace: 'AWS/DynamoDB',
            metricName: 'ConsumedReadCapacityUnits',
            dimensionsMap: tableDimensions,
            ...sumP5m,
          }),
        ],
      }),
      new cw.GraphWidget({
        title: 'DDB consumed write units / 5min',
        width: 8,
        height: 6,
        left: [
          new cw.Metric({
            namespace: 'AWS/DynamoDB',
            metricName: 'ConsumedWriteCapacityUnits',
            dimensionsMap: tableDimensions,
            ...sumP5m,
          }),
        ],
      }),
      new cw.GraphWidget({
        title: 'DDB throttles + system errors / 5min',
        width: 8,
        height: 6,
        left: [
          new cw.Metric({
            namespace: 'AWS/DynamoDB',
            metricName: 'ThrottledRequests',
            dimensionsMap: tableDimensions,
            ...sumP5m,
            label: 'Throttled',
          }),
          new cw.Metric({
            namespace: 'AWS/DynamoDB',
            metricName: 'SystemErrors',
            dimensionsMap: tableDimensions,
            ...sumP5m,
            label: 'System errors',
          }),
        ],
      }),
    );

    // ---------------- Dashboard: logs ----------------
    // Logs Insights queries over the API's JSON logs (pino: level, msg,
    // event, path, status, latencyMs, requestId). Each panel shows the
    // dashboard's time range.

    const logsWidget = (title: string, width: number, height: number, lines: string[]) =>
      new cw.LogQueryWidget({
        title,
        width,
        height,
        logGroupNames: [apiLogs.logGroupName],
        view: cw.LogQueryVisualizationType.TABLE,
        queryLines: lines,
      });

    dashboard.addWidgets(
      logsWidget('Errors and warnings', 24, 8, [
        'fields @timestamp, level, msg, method, path, status, err.message, requestId',
        "filter level in ['error', 'fatal', 'warn']",
        'sort @timestamp desc',
        'limit 100',
      ]),
    );

    dashboard.addWidgets(
      logsWidget('Recent requests', 12, 8, [
        'fields @timestamp, method, path, status, latencyMs, requestId',
        "filter msg = 'request'",
        'sort @timestamp desc',
        'limit 100',
      ]),
      logsWidget('Requests by route and status', 12, 8, [
        "filter msg = 'request'",
        'stats count(*) as requests, avg(latencyMs) as avgMs, max(latencyMs) as maxMs by method, path, status',
        'sort requests desc',
        'limit 50',
      ]),
    );

    dashboard.addWidgets(
      logsWidget('Bill reading (scan, Bedrock)', 12, 8, [
        'fields @timestamp, level, event, msg, path, status, latencyMs, err.message, requestId',
        'filter event like /^bill\\./ or path like /bills\\/(parse|uploads)/',
        'sort @timestamp desc',
        'limit 100',
      ]),
      logsWidget('Emails, sign-in and payments', 12, 8, [
        'fields @timestamp, level, event, msg, path, status, requestId',
        'filter event like /^(email|report|otp|auth)\\./ or path like /webhooks|billing|payments/',
        'sort @timestamp desc',
        'limit 100',
      ]),
    );

    dashboard.addWidgets(
      logsWidget('Calls out: Bedrock, Location, Stripe, SES', 24, 6, [
        "filter event = 'dep.call'",
        'stats count(*) as calls, sum(ok = 0) as failed, avg(ms) as avgMs, pct(ms, 95) as p95Ms, max(ms) as maxMs by dep, op',
        'sort p95Ms desc',
      ]),
    );

    dashboard.addWidgets(
      logsWidget('Crashes and timeouts (outside the app logger)', 24, 6, [
        'fields @timestamp, @message',
        'filter not ispresent(level)',
        'filter @message like /Task timed out|Runtime\\.|Error|ERROR|Unhandled/',
        'sort @timestamp desc',
        'limit 50',
      ]),
    );

    new cdk.CfnOutput(this, 'ApiUrlOutput', { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'ApiFunctionNameOutput', { value: fn.functionName });
    new cdk.CfnOutput(this, 'TableNameOutput', { value: table.tableName });
    new cdk.CfnOutput(this, 'BillsBucketOutput', { value: billsBucket.bucketName });
    new cdk.CfnOutput(this, 'AlertTopicArnOutput', { value: alertTopic.topicArn });
    new cdk.CfnOutput(this, 'DashboardUrlOutput', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${dashboard.dashboardName}`,
    });
  }
}

const app = new cdk.App();
const region = 'eu-west-2';

new GdpBackendStack(app, 'GdpBackendDev', { env: { region }, envName: 'dev' });
new GdpBackendStack(app, 'GdpBackendProd', { env: { region }, envName: 'prod' });

// Dev and prod share this AWS account (Callum's call, 1 Nov 2026). Every
// resource is named per environment, and each Lambda can only read its own
// gdp-<env>/* secrets. What keeps a dev run away from prod is GitHub: each
// deploy role is trusted only by jobs in its own GitHub environment, and the
// `prod` environment is limited to main with a required reviewer. (Both roles
// can assume the shared CDK bootstrap roles, so AWS itself doesn't separate
// them; a second account would.)
//
// OIDC roles for .github/workflows/api-deploy.yml. The dev deploy job keeps
// both up to date. They share the account's one GitHub OIDC provider. See
// githubDeploy.ts.
const existingProviderArn = app.node.tryGetContext('githubOidcProviderArn') as string | undefined;
new GithubDeployStack(app, 'GdpGithubDeploy', {
  env: { region },
  environment: 'dev',
  repo: 'caldvs/gdp',
  repoWithIds: 'caldvs@42970938/gdp@1440859247',
  existingProviderArn,
});
new GithubDeployStack(app, 'GdpGithubDeployProd', {
  env: { region },
  environment: 'prod',
  repo: 'caldvs/gdp',
  repoWithIds: 'caldvs@42970938/gdp@1440859247',
  existingProviderArn,
});

// Daily AWS cost email to Callum (the whole account: dev and prod share it).
new CostReportStack(app, 'GdpCostReport', {
  env: { region },
  to: 'callumdavies155@gmail.com',
  fromParameter: '/gdp-dev/ses-from-email',
  apiDir: API_DIR,
  repoRoot: REPO_ROOT,
});
