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
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import type { Construct } from 'constructs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tableSchema } from './tableSchema.js';
import { GithubDeployStack, deployRoleName } from './githubDeploy.js';
import { CostReportStack } from './costReport.js';
import { ALLOWED_ORIGINS } from '../src/config/allowedOrigins.js';

// apps/api lives inside the Pay Me Back monorepo; the npm lockfile is
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
      // Prod's table can't be deleted by a stack change or a stray call (#154).
      deletionProtection: envName === 'prod',
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
        // #226: proof-of-payment screenshots go after a month.
        { prefix: 'proofs/', expiration: cdk.Duration.days(30) },
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
    // #231: texts sign-in codes through AWS End User Messaging SMS when set
    // (GitHub environment variable SMS_SENDER_ID, or `-c smsSenderId=…`).
    // The account must be out of the SMS sandbox, with a spend limit, first.
    const smsSenderId =
      process.env.SMS_SENDER_ID ||
      (this.node.tryGetContext('smsSenderId') as string | undefined) ||
      '';

    // The bill reader: Claude Sonnet 4.6 on Bedrock through the EU cross-region
    // inference profile (requests stay in EU regions). Override with
    // `-c bedrockModelId=…`.
    const bedrockModelId =
      (this.node.tryGetContext('bedrockModelId') as string | undefined) ??
      'eu.anthropic.claude-sonnet-4-6';

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
      // Lambda CPU scales with memory. Bill reads crop and re-encode photos
      // with sharp (native libvips), well under a second; the pure-JS jpeg-js
      // it replaced took ~3.5s of a 10.7s read at 1024 MB (#172).
      memorySize: 2048,
      // API Gateway gives up on a request at 30s whatever this says, and the
      // synchronous /v1/bills/parse budgets itself under that. 60s is for
      // background bill reads (POST /v1/bills/reads), which this function
      // runs by invoking itself, outside API Gateway, with a 45s budget.
      timeout: cdk.Duration.seconds(60),
      tracing: lambda.Tracing.ACTIVE,
      // Dev shares the account (and its Lambda and Bedrock quotas) with prod,
      // so a runaway loop on dev can't take more than this (#145).
      ...(envName === 'dev' ? { reservedConcurrentExecutions: 20 } : {}),
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
        // #231: sign-in codes by text, from this alphanumeric sender ID.
        ...(smsSenderId ? { SMS_SENDER_ID: smsSenderId } : {}),

        ...(appBaseUrl ? { APP_BASE_URL: appBaseUrl } : {}),
        // Leads who never pay the table fee: a comma list from the GitHub
        // environment (secret or variable TABLE_FEE_EXEMPT_EMAILS).
        TABLE_FEE_EXEMPT_EMAILS: process.env.TABLE_FEE_EXEMPT_EMAILS ?? '',
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
        // sharp is native (libvips): installed into the bundle, not inlined,
        // with the binaries for Lambda's Linux x64 (glibc) whatever machine
        // synthesises the stack.
        nodeModules: ['sharp'],
        environment: {
          npm_config_os: 'linux',
          npm_config_cpu: 'x64',
          npm_config_libc: 'glibc',
        },
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
            // npm ignores npm_config_libc, so drop the musl and wasm builds of
            // sharp Lambda never loads (~27 MB).
            `rm -rf ${outputDir}/node_modules/@img/sharp-linuxmusl-x64 ${outputDir}/node_modules/@img/sharp-libvips-linuxmusl-x64 ${outputDir}/node_modules/@img/sharp-wasm32 ${outputDir}/node_modules/@emnapi`,
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

    // Bedrock: only the reader's inference profile and the model it routes
    // to, in any EU region the profile picks (#154). The Marketplace
    // subscription for Anthropic models was completed on 1 Nov, so the
    // function no longer needs aws-marketplace permissions.
    const bedrockBaseModel = bedrockModelId.replace(/^(eu|us|apac|global)\./, '');
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:*:${this.account}:inference-profile/${bedrockModelId}`,
          `arn:aws:bedrock:*::foundation-model/${bedrockBaseModel}*`,
        ],
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

    // #231: send texts, only in this account and region.
    if (smsSenderId) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['sms-voice:SendTextMessage'],
          resources: [`arn:aws:sms-voice:${this.region}:${this.account}:*`],
        }),
      );
    }

    // SES send permission for the EmailSender: only as the paymeback.dev
    // domain identity (verified out of band; #154).
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [`arn:aws:ses:${this.region}:${this.account}:identity/paymeback.dev`],
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
    const deployRole = iam.Role.fromRoleName(this, 'GithubDeployRole', deployRoleName(envName), {
      mutable: true,
    });
    fn.grantInvoke(deployRole);
    // The money journey (scripts/money-journey.ts) runs after each dev
    // deploy with dev's Stripe key, which is test mode. Dev only: prod's
    // deploy role never reads a Stripe key.
    if (envName === 'dev' && stripeEnabled) {
      deployRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [
            `arn:aws:secretsmanager:${this.region}:${this.account}:secret:gdp-dev/stripe-secret-key-*`,
          ],
        }),
      );
    }

    // The daily hold sweep (#168, src/ops/holdSweep.ts): takes the platform
    // fee from holds on bills still open after 6 days, before the card's
    // hold lapses, and retries any close that couldn't settle its hold.
    // A failed hold throws, which the Lambda errors alarm reports.
    new events.Rule(this, 'HoldSweepDaily', {
      description: 'Take the platform fee from card holds before they lapse (#168)',
      schedule: events.Schedule.cron({ minute: '17', hour: '3' }),
      targets: [
        new targets.LambdaFunction(fn, {
          event: events.RuleTargetInput.fromObject({ gdpHoldSweep: true }),
          retryAttempts: 2,
        }),
      ],
    });

    // The lead's email the day after settling (#221, src/ops/leadEmails.ts):
    // 09:00 UTC (9 or 10 in London) for bills settled before today. A failed
    // send stays queued for tomorrow and the Lambda errors alarm reports it.
    new events.Rule(this, 'LeadEmailsDaily', {
      description: "Email leads how yesterday's settled bills ended (#221)",
      schedule: events.Schedule.cron({ minute: '0', hour: '9' }),
      targets: [
        new targets.LambdaFunction(fn, {
          event: events.RuleTargetInput.fromObject({ gdpLeadEmails: true }),
          retryAttempts: 2,
        }),
      ],
    });

    // The automatic reminder text (#219, src/ops/reminders.ts): 10:00 UTC
    // (10 or 11 in London), for guests still owing a day after payments
    // opened. A bill that fails stays queued; the errors alarm reports it.
    new events.Rule(this, 'RemindersDaily', {
      description: 'Text guests who still owe, a day after payments open (#219)',
      schedule: events.Schedule.cron({ minute: '0', hour: '10' }),
      targets: [
        new targets.LambdaFunction(fn, {
          event: events.RuleTargetInput.fromObject({ gdpReminders: true }),
          retryAttempts: 2,
        }),
      ],
    });

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
      // With a custom domain, nothing should call the raw execute-api URL
      // (the web app, the Stripe webhook and the smoke test all use the
      // domain), so switch it off (#154).
      disableExecuteApiEndpoint: Boolean(domainName),
    });
    // Stage throttling, so a loop can't run up Lambda and Bedrock costs (#145).
    // Requests per second across the whole API; dev lower than prod.
    const stage = httpApi.defaultStage?.node.defaultChild as apigw.CfnStage | undefined;
    if (stage) {
      stage.defaultRouteSettings =
        envName === 'prod'
          ? { throttlingRateLimit: 50, throttlingBurstLimit: 100 }
          : { throttlingRateLimit: 10, throttlingBurstLimit: 20 };
    }
    if (domainName) {
      // The CNAME to add in Vercel DNS: <api name> → this value.
      new cdk.CfnOutput(this, 'ApiDomainTargetOutput', { value: domainName.regionalDomainName });
      new cdk.CfnOutput(this, 'ApiDomainUrlOutput', { value: `https://${apiDomain}` });
    }

    // ---------------- Observability: alarms ----------------

    // SNS topic for alarm notifications. Email subscribers are added
    // post-deploy via the AWS console (or `aws sns subscribe` from the
    // CLI) so the email address isn't baked into source / version
    // control. See RUNBOOK.md for the one-click subscription steps.
    const alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: `gdp-${envName}-alerts`,
      displayName: `Pay Me Back (${envName}) alerts`,
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

    // What people wait for: API Gateway's latency, not the Lambda's duration.
    // Background bill reads run in the same Lambda (it invokes itself, outside
    // API Gateway) and take 5-20s by design, so at low traffic one read was
    // the Lambda's p99 and paged us for nothing (#172).
    const apiLatencyAlarm = new cw.Alarm(this, 'ApiLatencyP99Alarm', {
      alarmName: `gdp-${envName}-api-latency-p99`,
      alarmDescription: 'API p99 latency > 10s over 5m. See RUNBOOK.md "api-latency".',
      metric: new cw.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: 'Latency',
        dimensionsMap: { ApiId: httpApi.apiId, Stage: '$default' },
        period: period5m,
        statistic: 'p99',
      }),
      threshold: 10_000,
      evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
    apiLatencyAlarm.addAlarmAction(snsAction);

    // Background bill reads: one `bill.read.finished` log line each, with `ms`.
    // Alarm when a read gets near its 45s budget (BACKGROUND_READ_BUDGET_MS).
    const readMs = new logs.MetricFilter(this, 'BillReadMsFilter', {
      logGroup: apiLogs,
      filterPattern: logs.FilterPattern.stringValue('$.event', '=', 'bill.read.finished'),
      metricNamespace: `gdp-${envName}`,
      metricName: 'BillReadMs',
      metricValue: '$.ms',
      unit: cw.Unit.MILLISECONDS,
    }).metric({ period: period5m, statistic: 'Maximum' });
    const slowReadAlarm = new cw.Alarm(this, 'BillReadSlowAlarm', {
      alarmName: `gdp-${envName}-bill-read-slow`,
      alarmDescription: 'A bill read took > 40s (budget 45s). See RUNBOOK.md "bill-read-slow".',
      metric: readMs,
      threshold: 40_000,
      evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
    slowReadAlarm.addAlarmAction(snsAction);

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

    // #231: sign-in texts. Every one is paid, so a burst (a bot, SMS pumping)
    // pages us; the send limits stop it at 200 an hour anyway.
    if (smsSenderId) {
      const textsSent = new logs.MetricFilter(this, 'SignInTextsFilter', {
        logGroup: apiLogs,
        filterPattern: logs.FilterPattern.stringValue('$.event', '=', 'signin.phone.sent'),
        metricNamespace: `gdp-${envName}`,
        metricName: 'SignInTextsSent',
        metricValue: '1',
      }).metric({ period: cdk.Duration.hours(1), statistic: 'Sum' });
      new cw.Alarm(this, 'SignInTextsBurstAlarm', {
        alarmName: `gdp-${envName}-sign-in-texts-burst`,
        alarmDescription:
          'Over 100 sign-in codes sent in an hour. Check for abuse before the SMS spend limit is hit.',
        metric: textsSent,
        threshold: 100,
        evaluationPeriods: 1,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      }).addAlarmAction(snsAction);

      // The account's SMS spend this month (one account for dev and prod, so
      // prod's stack owns it). Warns at 75% of the $20 limit.
      if (envName === 'prod') {
        new cw.Alarm(this, 'SmsSpendAlarm', {
          alarmName: 'gdp-sms-monthly-spend',
          alarmDescription:
            'SMS spend this month passed $15 of the $20 limit. Raise the limit or look for abuse.',
          metric: new cw.Metric({
            namespace: 'AWS/SMSVoice',
            metricName: 'TextMessageMonthlySpend',
            period: cdk.Duration.hours(1),
            statistic: 'Maximum',
          }),
          threshold: 15,
          evaluationPeriods: 1,
          treatMissingData: cw.TreatMissingData.NOT_BREACHING,
          comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        }).addAlarmAction(snsAction);
      }
    }

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

    // SES reputation (#146). Account-wide, so only the prod stack alarms on
    // it. AWS reviews an account at 5% bounces or 0.1% complaints and can
    // pause sending at 10% / 0.5%; alarm well before either.
    if (envName === 'prod') {
      const sesReputation = (metricName: string, id: string, threshold: number) => {
        const alarm = new cw.Alarm(this, id, {
          alarmName: `gdp-ses-${metricName === 'Reputation.BounceRate' ? 'bounce' : 'complaint'}-rate`,
          alarmDescription: `SES ${metricName} is above ${threshold * 100}%. See RUNBOOK.md "ses-reputation".`,
          metric: new cw.Metric({
            namespace: 'AWS/SES',
            metricName,
            period: cdk.Duration.hours(1),
            statistic: 'Maximum',
          }),
          threshold,
          evaluationPeriods: 1,
          treatMissingData: cw.TreatMissingData.NOT_BREACHING,
          comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        });
        alarm.addAlarmAction(snsAction);
      };
      sesReputation('Reputation.BounceRate', 'SesBounceRateAlarm', 0.04);
      sesReputation('Reputation.ComplaintRate', 'SesComplaintRateAlarm', 0.0008);
    }

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
        'filter event like /^(email|report|signin|auth)\\./ or path like /webhooks|billing|payments/',
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

    // The API's URL: its custom domain when it has one (the execute-api URL
    // is switched off then), else the execute-api URL.
    new cdk.CfnOutput(this, 'ApiUrlOutput', {
      value: domainName ? `https://${apiDomain}` : httpApi.apiEndpoint,
    });
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
// OIDC roles for .github/workflows/deploy-api.yml. The dev deploy job keeps
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
// Addresses live in SSM so they stay out of this public repo.
new CostReportStack(app, 'GdpCostReport', {
  env: { region },
  toParameter: '/gdp/cost-report-to',
  fromParameter: '/gdp-dev/ses-from-email',
  apiDir: API_DIR,
  repoRoot: REPO_ROOT,
});
