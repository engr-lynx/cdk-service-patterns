import {
  Construct,
  Arn,
} from '@aws-cdk/core'
import {
  CloudFrontWebDistribution,
  CloudFrontWebDistributionProps,
  OriginAccessIdentity,
  PriceClass,
} from '@aws-cdk/aws-cloudfront'
import {
  Bucket,
} from '@aws-cdk/aws-s3'
import {
  CfnService,
} from '@aws-cdk/aws-apprunner'
import {
  Grant,
  IGrantable,
  Role,
  ServicePrincipal,
  ManagedPolicy,
} from '@aws-cdk/aws-iam'

// CloudFront

type WebDistributionProps = Omit<CloudFrontWebDistributionProps, 'defaultRootObject'>

export class WebDistribution extends CloudFrontWebDistribution {

  constructor(scope: Construct, id: string, webDistributionProps: WebDistributionProps) {
    const cloudFrontWebDistributionProps = {
      ...webDistributionProps,
      defaultRootObject: 'index.html',
    }
    super(scope, id, cloudFrontWebDistributionProps)
  }

  grant(grantee: IGrantable, ...actions: string[]) {
    const arn = Arn.format({
      service: 'cloudfront',
      resource: 'distribution',
      region: '',
      resourceName: this.distributionId,
    }, this.stack)
    return Grant.addToPrincipal({
      grantee,
      actions,
      resourceArns: [
        arn
      ],
      scope: this,
    })
  }

  grantInvalidate(grantee: IGrantable) {
    return this.grant(grantee, 'cloudfront:CreateInvalidation')
  }

}

/*
 * Constructs
 */

// CDN: CloudFront - S3

export class Cdn extends Construct {

  public readonly source: Bucket
  public readonly distribution: WebDistribution

  constructor(scope: Construct, id: string) {
    super(scope, id)
    this.source = new Bucket(this, 'Source')
    const originAccessIdentity = new OriginAccessIdentity(this, 'OriginAccessIdentity')
    const s3OriginSource = {
      s3BucketSource: this.source,
      originAccessIdentity,
    }
    const behaviors = [{
      isDefaultBehavior: true,
    }]
    const originConfigs = [{
      s3OriginSource,
      behaviors,
    }]
    this.distribution = new WebDistribution(this, 'Distribution', {
      originConfigs,
      priceClass: PriceClass.PRICE_CLASS_200,
    })
  }

}

// App Image Service: App Runner (Image)

export enum RepositoryType {
  ECR = 'ECR',
  ECR_PUBLIC = 'ECR_PUBLIC',
}

export interface KeyValuePair {
  name?: string,
  value?: string,
}

export interface AppImageServiceProps {
  repositoryType: RepositoryType,
  imageId: string,
  port?: string,
  startCommand?: string,
  environment?: KeyValuePair[],
  willAutoDeploy?: boolean,
}

export class AppImageService extends Construct {

  public readonly service: CfnService;

  constructor(scope: Construct, id: string, appImageServiceProps: AppImageServiceProps) {
    super(scope, id)
    const assumedBy = new ServicePrincipal('build.apprunner.amazonaws.com')
    const managedPolicies = [
      ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSAppRunnerServicePolicyForECRAccess'),
    ]
    const accessRole = new Role(this, 'AccessRole', {
      assumedBy,
      managedPolicies,
    })
    const authenticationConfiguration = {
      accessRoleArn: accessRole.roleArn,
    }
    const imageConfiguration = {
      port: appImageServiceProps.port,
      startCommand: appImageServiceProps.startCommand,
      runtimeEnvironmentVariables: appImageServiceProps.environment,
    }
    const imageRepository = {
      imageIdentifier: appImageServiceProps.imageId,
      imageRepositoryType: appImageServiceProps.repositoryType,
      imageConfiguration,
    }
    const sourceConfiguration = {
      imageRepository,
      authenticationConfiguration,
      autoDeploymentsEnabled: appImageServiceProps.willAutoDeploy,
    }
    this.service = new CfnService(this, 'Service', {
      sourceConfiguration,
    })
  }

}
