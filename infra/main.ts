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
import type { Construct } from 'constructs';
import { tableSchema } from './tableSchema.js';

type EnvName = 'dev' | 'staging' | 'prod';

interface GdpStackProps extends cdk.StackProps {
  envName: EnvName;
}

// Map our short env names to the values the runtime zod schema expects
// (env.ts EnvSchema NODE_ENV: 'development' | 'test' | 'staging' | 'production').
const nodeEnvFor = (e: EnvName): 'development' | 'staging' | 'production' => {
  if (e === 'prod') return 'production';
  if (e === 'staging') return 'staging';
  return 'development';
};

class GdpBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GdpStackProps) {
    super(scope, id, props);
    const { envName } = props;

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
      // Browser clients PUT directly to presigned URLs from a different
      // origin (e.g. http://localhost:8081 in dev). Without CORS the
      // preflight fails. Permissive in dev — tighten origins before prod.
      cors: [
        {
          allowedOrigins: ['*'],
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
    const googleClientId = ssm.StringParameter.valueForStringParameter(
      this,
      `/gdp-${envName}/google-client-id`,
    );
    const trueLayerClientId = ssm.StringParameter.valueForStringParameter(
      this,
      `/gdp-${envName}/truelayer-client-id`,
    );
    const trueLayerSigningKid = ssm.StringParameter.valueForStringParameter(
      this,
      `/gdp-${envName}/truelayer-signing-kid`,
    );
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

    // Secrets — Secrets Manager. Values resolved at deploy time via friendly-
    // name dynamic CloudFormation references and land as Lambda env vars.
    // Trade-off: the values are visible in the Lambda console UI to anyone
    // with read access to this account. Acceptable for dev; revisit for prod
    // (switch to a runtime fetch via aws-sdk client-secrets-manager).
    //
    // Using cdk.SecretValue.secretsManager() rather than Secret.fromSecretNameV2,
    // because the latter generates an ARN-form dynamic reference that CFN
    // sometimes refuses to resolve; the friendly-name form is what AWS docs
    // describe as canonical.
    const geminiKey = cdk.SecretValue.secretsManager(`gdp-${envName}/gemini-api-key`);
    // Google Places key lives in SSM Parameter Store as a plain String.
    // SecureString would be tighter at rest but CFN's
    // `{{resolve:ssm-secure}}` reference is NOT supported in Lambda env
    // vars (it errors at change-set creation). Matches the existing
    // posture for googleClientId etc.: plaintext key landing in the
    // Lambda env, visible in the console to anyone with read access.
    // Acceptable for dev — switch to a runtime SDK fetch before prod if
    // tightening is wanted.
    const googlePlacesKey = ssm.StringParameter.valueForStringParameter(
      this,
      `/gdp-${envName}/google-places-api-key`,
    );
    const trueLayerClientSecret = cdk.SecretValue.secretsManager(
      `gdp-${envName}/truelayer-client-secret`,
    );
    const trueLayerWebhookSecret = cdk.SecretValue.secretsManager(
      `gdp-${envName}/truelayer-webhook-secret`,
    );
    const trueLayerSigningPrivateKey = cdk.SecretValue.secretsManager(
      `gdp-${envName}/truelayer-signing-private-key`,
    );

    const fn = new nodejs.NodejsFunction(this, 'ApiHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: 'src/lambda.ts',
      handler: 'handler',
      memorySize: 1024,
      // 30s is the API Gateway HTTP API integration timeout cap. Bumped
      // from 25s after a complex receipt (HEIC source, large JPEG after
      // conversion) made Gemini parse take 25001ms and the Lambda was
      // killed mid-flight. Most parses come back in 6-15s; the buffer
      // covers cold-start + complex images.
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        NODE_ENV: nodeEnvFor(envName),
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
        DDB_TABLE_NAME: table.tableName,
        S3_BUCKET_BILLS: billsBucket.bucketName,
        LOG_LEVEL: envName === 'prod' ? 'info' : 'debug',

        GOOGLE_CLIENT_ID: googleClientId,

        GEMINI_API_KEY: geminiKey.unsafeUnwrap(),
        GOOGLE_PLACES_API_KEY: googlePlacesKey,
        SES_FROM_EMAIL: sesFromEmail,

        TRUELAYER_CLIENT_ID: trueLayerClientId,
        TRUELAYER_CLIENT_SECRET: trueLayerClientSecret.unsafeUnwrap(),
        TRUELAYER_WEBHOOK_SECRET: trueLayerWebhookSecret.unsafeUnwrap(),
        TRUELAYER_SIGNING_KID: trueLayerSigningKid,
        TRUELAYER_SIGNING_PRIVATE_KEY_PEM: trueLayerSigningPrivateKey.unsafeUnwrap(),
        TRUELAYER_ENVIRONMENT: 'sandbox',
        // `manual` = guests pay the lead via their own banking app (Monzo/
        // Revolut deep links if available, raw sort+account otherwise),
        // lead confirms receipt manually. Free of TrueLayer fees. Switch
        // to `truelayer` once TL Live commercial onboarding is in place.
        PAYMENT_PROVIDER: 'manual',
      },
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: 'node22',
        minify: envName === 'prod',
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
        // pino + some transitive deps still use `require()` even when
        // bundled as ESM. Provide a CJS-compatible require so the bundle
        // can resolve them at module load.
        banner:
          "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
        // Ship openapi.yaml alongside the bundled lambda.js so the
        // /docs and /openapi.yaml routes can resolve it at runtime
        // (routes/docs.ts already looks for it next to import.meta.url).
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp ${inputDir}/openapi.yaml ${outputDir}/openapi.yaml`,
          ],
        },
      },
      logGroup: new logs.LogGroup(this, 'ApiHandlerLogs', {
        retention:
          envName === 'prod' ? logs.RetentionDays.SIX_MONTHS : logs.RetentionDays.ONE_MONTH,
        removalPolicy,
      }),
    });

    table.grantReadWriteData(fn);
    billsBucket.grantReadWrite(fn);

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

    const httpApi = new apigw.HttpApi(this, 'HttpApi', {
      apiName: `gdp-${envName}`,
      defaultIntegration: new integrations.HttpLambdaIntegration('LambdaIntegration', fn),
    });

    // The TrueLayer return URL has to match what's registered in the Console.
    // We resolve it from the API endpoint so a stack re-create still produces
    // a coherent value in the Lambda env — but the Console-side URL must be
    // updated by hand if the API endpoint ever changes.
    fn.addEnvironment('TRUELAYER_RETURN_URI', `${httpApi.apiEndpoint}/v1/payments/return`);

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

    new cdk.CfnOutput(this, 'ApiUrlOutput', { value: httpApi.apiEndpoint });
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
new GdpBackendStack(app, 'GdpBackendStaging', { env: { region }, envName: 'staging' });
new GdpBackendStack(app, 'GdpBackendProd', { env: { region }, envName: 'prod' });
