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
   * The GitHub environment whose jobs may assume the role. Jobs that declare
   * `environment: <name>` get the OIDC subject `repo:<repo>:environment:<name>`,
   * so other branches' jobs, PRs and jobs in other environments can't.
   */
  environment: 'dev' | 'prod';
  /**
   * ARN of an existing GitHub OIDC provider in this account. An account can
   * only hold one provider per URL, so pass this (`-c githubOidcProviderArn=…`)
   * if another project already created it.
   */
  existingProviderArn?: string;
}

/**
 * Lets `.github/workflows/deploy-api.yml` deploy with OIDC instead of
 * long-lived keys. The role only assumes the CDK bootstrap roles (`cdk-*`),
 * which do the actual work, so it holds no other AWS permissions.
 *
 * The dev deploy job deploys this stack too, so changes here ship with the
 * next push to main. In a new account it has to be created once by hand:
 *
 *   npx cdk deploy GdpGithubDeploy --profile gdp-dev
 *
 * Then put the `DeployRoleArnOutput` value in the GitHub environment as the
 * variable AWS_DEPLOY_ROLE_ARN (and AWS_REGION = eu-west-2).
 *
 * The OIDC subject must match exactly. The deploy job's "Show OIDC claims"
 * step prints what GitHub sent; if AssumeRoleWithWebIdentity is refused
 * after a change here, compare it with the trust policy.
 */
/**
 * The deploy role's name for an environment. Dev keeps the original name,
 * because its ARN is already in the GitHub `dev` environment.
 */
export const deployRoleName = (environment: 'dev' | 'prod'): string =>
  environment === 'dev' ? 'gdp-github-deploy' : `gdp-github-deploy-${environment}`;

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
      roleName: deployRoleName(props.environment),
      description: `GitHub Actions deploys for ${props.repo} (${props.environment})`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        // Only jobs in this repo's `environment` (which also limits them to
        // that environment's allowed branches). GitHub sends the repo either
        // by name (`repo:caldvs/gdp:…`) or, newer, with owner and repo IDs
        // (`repo:caldvs@42970938/gdp@1440859247:…`), so accept both.
        StringEquals: {
          [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com',
          [`${GITHUB_OIDC_HOST}:sub`]: [
            `repo:${props.repo}:environment:${props.environment}`,
            `repo:${props.repoWithIds}:environment:${props.environment}`,
          ],
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
