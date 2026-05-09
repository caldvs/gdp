import * as cdk from 'aws-cdk-lib';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as logs from 'aws-cdk-lib/aws-logs';
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

    const fn = new nodejs.NodejsFunction(this, 'ApiHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: 'src/lambda.ts',
      handler: 'handler',
      memorySize: 1024,
      timeout: cdk.Duration.seconds(25),
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        NODE_ENV: nodeEnvFor(envName),
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
        DDB_TABLE_NAME: table.tableName,
        S3_BUCKET_BILLS: billsBucket.bucketName,
        LOG_LEVEL: envName === 'prod' ? 'info' : 'debug',
        // Secrets (GOOGLE_CLIENT_ID, GEMINI_API_KEY, TRUELAYER_*) are wired via
        // SSM Parameter Store / Secrets Manager when the account is provisioned.
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
      },
      logGroup: new logs.LogGroup(this, 'ApiHandlerLogs', {
        retention:
          envName === 'prod' ? logs.RetentionDays.SIX_MONTHS : logs.RetentionDays.ONE_MONTH,
        removalPolicy,
      }),
    });

    table.grantReadWriteData(fn);
    billsBucket.grantReadWrite(fn);

    const httpApi = new apigw.HttpApi(this, 'HttpApi', {
      apiName: `gdp-${envName}`,
      defaultIntegration: new integrations.HttpLambdaIntegration('LambdaIntegration', fn),
    });

    new cdk.CfnOutput(this, 'ApiUrlOutput', { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'TableNameOutput', { value: table.tableName });
    new cdk.CfnOutput(this, 'BillsBucketOutput', { value: billsBucket.bucketName });
  }
}

const app = new cdk.App();
const region = 'eu-west-2';

new GdpBackendStack(app, 'GdpBackendDev', { env: { region }, envName: 'dev' });
new GdpBackendStack(app, 'GdpBackendStaging', { env: { region }, envName: 'staging' });
new GdpBackendStack(app, 'GdpBackendProd', { env: { region }, envName: 'prod' });
