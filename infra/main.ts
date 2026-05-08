import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';

class GdpBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    cdk.Tags.of(this).add('project', 'gdp-backend');
    // Resources land in the foundations checkpoint:
    //   - Lambda function (Hono handler)
    //   - API Gateway HTTP API
    //   - DynamoDB single-table
    //   - S3 bucket for raw bills
    //   - Pre-signed URL IAM
  }
}

const app = new cdk.App();

new GdpBackendStack(app, 'GdpBackendDev', {
  env: { region: 'eu-west-2' },
  tags: { env: 'dev' },
});

new GdpBackendStack(app, 'GdpBackendProd', {
  env: { region: 'eu-west-2' },
  tags: { env: 'prod' },
});
