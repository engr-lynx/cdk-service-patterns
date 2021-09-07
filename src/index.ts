import {
  Construct,
  Arn,
  Stack,
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
  IGrantable,
  PolicyStatement,
  Role,
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

  grantInvalidate(grantee: IGrantable) {
    const arn = Arn.format({
      service: 'cloudfront',
      resource: 'distribution',
      region: '',
      resourceName: this.distributionId,
    }, this.stack)
    const policy = new PolicyStatement({
      actions: [
        'cloudfront:CreateInvalidation',
      ],
      resources: [
        arn,
      ],
    })
    grantee.grantPrincipal.addToPrincipalPolicy(policy)
  }

}

// IAM

export class IamRole extends Role {

  static grantGet(grantee: IGrantable, scope: Construct, name: string, isService?: boolean) {
    const fullName = (isService ? 'service-role/' : '') + name
    const arn = Arn.format({
      service: 'iam',
      resource: 'role',
      region: '',
      resourceName: fullName,
    }, Stack.of(scope))
    const policy = new PolicyStatement({
      actions: [
        'iam:GetRole',
      ],
      resources: [
        arn,
      ],
    })
    grantee.grantPrincipal.addToPrincipalPolicy(policy)
  }

  static grantCreate(grantee: IGrantable, scope: Construct) {
    const arn = Arn.format({
      service: 'iam',
      resource: 'role',
      region: '',
      resourceName: '*',
    }, Stack.of(scope))
    const policy = new PolicyStatement({
      actions: [
        'iam:CreateRole',
        'iam:CreateServiceLinkedRole',
      ],
      resources: [
        arn,
      ],
    })
    grantee.grantPrincipal.addToPrincipalPolicy(policy)
  }

  static grantPass(grantee: IGrantable, scope: Construct, name: string, isService?: boolean) {
    const fullName = (isService ? 'service-role/' : '') + name
    const arn = Arn.format({
      service: 'iam',
      resource: 'role',
      region: '',
      resourceName: fullName,
    }, Stack.of(scope))
    const policy = new PolicyStatement({
      actions: [
        'iam:PassRole',
      ],
      resources: [
        arn,
      ],
    })
    grantee.grantPrincipal.addToPrincipalPolicy(policy)
  }

}

// App Runner

export class AppRunnerService extends CfnService {

  static grantCreate(grantee: IGrantable, scope: Construct) {
    const serviceArn = Arn.format({
      service: 'apprunner',
      resource: 'service',
      resourceName: '*',
    }, Stack.of(scope))
    const connectionArn = Arn.format({
      service: 'apprunner',
      resource: 'connection',
      resourceName: '*',
    }, Stack.of(scope))
    const autoscalingArn = Arn.format({
      service: 'apprunner',
      resource: 'autoscalingconfiguration',
      resourceName: '*',
    }, Stack.of(scope))
    const policy = new PolicyStatement({
      actions: [
        'apprunner:CreateService',
      ],
      resources: [
        serviceArn,
        connectionArn,
        autoscalingArn,
      ],
    })
    grantee.grantPrincipal.addToPrincipalPolicy(policy)
  }

  static grantList(grantee: IGrantable, scope: Construct) {
    const arn = Arn.format({
      service: 'apprunner',
      resource: 'service',
      resourceName: '*',
    }, Stack.of(scope))
    const policy = new PolicyStatement({
      actions: [
        'apprunner:ListServices',
      ],
      resources: [
        arn,
      ],
    })
    grantee.grantPrincipal.addToPrincipalPolicy(policy)
  }

  static grantDescribe(grantee: IGrantable, scope: Construct, name: string) {
    const arn = Arn.format({
      service: 'apprunner',
      resource: 'service',
      resourceName: name,
    }, Stack.of(scope))
    const policy = new PolicyStatement({
      actions: [
        'apprunner:DescribeService',
      ],
      resources: [
        arn,
      ],
    })
    grantee.grantPrincipal.addToPrincipalPolicy(policy)
  }

}

// Constructs

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
