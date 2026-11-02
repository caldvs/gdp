import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import * as path from 'node:path';

export interface CostReportStackProps extends cdk.StackProps {
  /** SSM parameter holding who gets the email. In the SES sandbox it must be a verified identity. */
  toParameter: string;
  /** SSM parameter holding the verified address to send from. */
  fromParameter: string;
  apiDir: string;
  repoRoot: string;
}

/**
 * Emails the account's AWS costs every morning (src/ops/costReport.ts):
 * yesterday's and the month so far, by service, with a forecast. One per
 * account, not per environment: dev and prod share it.
 */
export class CostReportStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CostReportStackProps) {
    super(scope, id, props);

    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new nodejs.NodejsFunction(this, 'CostReport', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(props.apiDir, 'src/ops/costReport.ts'),
      projectRoot: props.repoRoot,
      depsLockFilePath: path.join(props.repoRoot, 'package-lock.json'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      logGroup,
      environment: {
        COST_REPORT_TO: ssm.StringParameter.valueForStringParameter(this, props.toParameter),
        COST_REPORT_FROM: ssm.StringParameter.valueForStringParameter(this, props.fromParameter),
      },
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: 'node22',
        externalModules: ['@aws-sdk/client-sesv2'],
      },
    });

    // Cost Explorer has no resource-level permissions.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ce:GetCostAndUsage', 'ce:GetCostForecast'],
        resources: ['*'],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: [`arn:aws:ses:${this.region}:${this.account}:identity/*`],
      }),
    );

    // 10:00 UTC: 10am in winter, 11am in summer.
    new events.Rule(this, 'EveryMorning', {
      schedule: events.Schedule.cron({ minute: '0', hour: '10' }),
      targets: [new targets.LambdaFunction(fn, { retryAttempts: 2 })],
    });

    new cdk.CfnOutput(this, 'FunctionNameOutput', { value: fn.functionName });
  }
}
