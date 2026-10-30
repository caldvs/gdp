import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';

export interface GithubDeployStackProps extends cdk.StackProps {
  /** `owner/repo` allowed to assume the role. */
  repo: string;
  /** The same repo as `owner@<ownerId>/repo@<repoId>`, as newer OIDC subjects name it. */
  repoWithIds: string;
  /**
   * ARN of an existing GitHub OIDC provider in this account. An account can
   * only hold one provider per URL, so pass this (`-c githubOidcProviderArn=…`)
   * if another project already created it.
   */
  existingProviderArn?: string;
}

/**
 * One-off stack: lets `.github/workflows/api-deploy.yml` deploy with OIDC
 * instead of long-lived keys. The role only assumes the CDK bootstrap roles
 * (`cdk-*`), which do the actual work, so it holds no other AWS permissions.
 *
 *   npx cdk deploy GdpGithubDeploy --profile gdp-dev
 *
 * Then put the `DeployRoleArnOutput` value in the GitHub `dev` environment as
 * the variable AWS_DEPLOY_ROLE_ARN (and AWS_REGION = eu-west-2).
 */
export class GithubDeployStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GithubDeployStackProps) {
    super(scope, id, props);

    const provider = props.existingProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          'GithubOidc',
          props.existingProviderArn,
        )
      : new iam.OpenIdConnectProvider(this, 'GithubOidc', {
          url: `https://${GITHUB_OIDC_HOST}`,
          clientIds: ['sts.amazonaws.com'],
        });

    const role = new iam.Role(this, 'DeployRole', {
      roleName: 'gdp-github-deploy',
      description: `GitHub Actions deploys for ${props.repo}`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: { [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com' },
        // Any workflow run in this repo. GitHub sends the repo either by name
        // (`repo:caldvs/gdp:…`) or, newer, with owner and repo IDs
        // (`repo:caldvs@42970938/gdp@1440859247:…`), so accept both.
        StringLike: {
          [`${GITHUB_OIDC_HOST}:sub`]: [`repo:${props.repo}:*`, `repo:${props.repoWithIds}:*`],
        },
      }),
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
      }),
    );

    new cdk.CfnOutput(this, 'DeployRoleArnOutput', { value: role.roleArn });
  }
}
