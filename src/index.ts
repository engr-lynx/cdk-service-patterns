import {
  Resource,
  Construct,
  Arn,
  CustomResource,
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
  IPrincipal,
} from '@aws-cdk/aws-iam'
import {
  PythonFunction,
} from '@aws-cdk/aws-lambda-python'
import {
  Runtime,
} from '@aws-cdk/aws-lambda'
import {
  Provider,
} from '@aws-cdk/custom-resources'

// ToDo: Break these up so that there's a logical grouping or Constructs and Resources.

export interface KeyValue {
  readonly [key: string]: string | number,
}

export interface KeyValuePair {
  readonly name?: string,
  readonly value?: string,
}

// CloudFront

type WebDistributionProps = Omit<CloudFrontWebDistributionProps, 'defaultRootObject'>

export class WebDistribution extends CloudFrontWebDistribution {

  constructor(scope: Construct, id: string, props: WebDistributionProps) {
    const cloudFrontWebDistributionProps = {
      ...props,
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
    const resourceArns = [
      arn
    ]
    return Grant.addToPrincipal({
      grantee,
      actions,
      resourceArns,
      scope: this,
    })
  }

  grantInvalidate(grantee: IGrantable) {
    return this.grant(grantee, 'cloudfront:CreateInvalidation')
  }

}

// App Runner

const SERVICE_READ_ACTIONS = [
  'apprunner:DescribeService',
  'apprunner:DescribeCustomDomains',
  'apprunner:ListOperations',
]

const SERVICE_WRITE_ACTIONS = [
  'apprunner:UpdateService',
  'apprunner:AssociateCustomDomain',
  'apprunner:DisassociateCustomDomain',
]

const SERVICE_OPERATE_ACTIONS = [
  'apprunner:PauseService',
  'apprunner:ResumeService',
  'apprunner:StartDeployment',
]

interface InstanceProps {
  readonly cpu?: string,
  readonly memory?: string,
}

interface BaseServiceRunnerProps extends InstanceProps {
  readonly willAutoDeploy?: boolean,
}

class BaseServiceRunner extends Resource {

  protected readonly instanceConfiguration?: InstanceProps
  public serviceArn: string
  public serviceId: string
  public serviceUrl: string
  public status: string

  constructor(scope: Construct, id: string, props?: BaseServiceRunnerProps) {
    super(scope, id)
    this.instanceConfiguration = {
      cpu: props?.cpu,
      memory: props?.memory,
    }
  }

  grant(grantee: IGrantable, ...actions: string[]) {
    const resourceArns = [
      this.serviceArn,
    ]
    return Grant.addToPrincipal({
      grantee,
      actions,
      resourceArns,
      scope: this,
    })
  }

  grantRead(grantee: IGrantable) {
    return this.grant(grantee,
      ...SERVICE_READ_ACTIONS,
    )
  }

  grantWrite(grantee: IGrantable) {
    return this.grant(grantee,
      ...SERVICE_WRITE_ACTIONS,
    )
  }

  grantReadWrite(grantee: IGrantable) {
    return this.grant(grantee,
      ...SERVICE_READ_ACTIONS,
      ...SERVICE_WRITE_ACTIONS,
    )
  }

  grantOperate(grantee: IGrantable) {
    return this.grant(grantee,
      ...SERVICE_OPERATE_ACTIONS,
    )
  }

}

export enum RepositoryType {
  ECR = 'ECR',
  ECR_PUBLIC = 'ECR_PUBLIC',
}

export interface ImageServiceRunnerProps extends BaseServiceRunnerProps {
  readonly repositoryType: RepositoryType,
  readonly imageId: string,
  readonly port?: string,
  readonly startCommand?: string,
  readonly environment?: KeyValuePair[],
}

// ToDo: This may implement IGrantable for the app inside the service.
export class ImageServiceRunner extends BaseServiceRunner {

  constructor(scope: Construct, id: string, props: ImageServiceRunnerProps) {
    super(scope, id, props)
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
      port: props.port,
      startCommand: props.startCommand,
      runtimeEnvironmentVariables: props.environment,
    }
    const imageRepository = {
      imageIdentifier: props.imageId,
      imageRepositoryType: props.repositoryType,
      imageConfiguration,
    }
    const sourceConfiguration = {
      imageRepository,
      authenticationConfiguration,
      autoDeploymentsEnabled: props.willAutoDeploy,
    }
    const service = new CfnService(this, 'Service', {
      sourceConfiguration,
      instanceConfiguration: this.instanceConfiguration,
    })
    this.node.defaultChild = service
    this.serviceArn = service.attrServiceArn
    this.serviceId = service.attrServiceId
    this.serviceUrl = service.attrServiceUrl
    this.status = service.attrStatus
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

export interface PythonResourceProps {
  readonly entry: string;
  readonly index?: string;
  readonly handler?: string;
  readonly runtime?: Runtime;
  readonly properties?: KeyValue,
}

export class PythonResource extends Construct implements IGrantable {

  readonly grantPrincipal: IPrincipal

  constructor(scope: Construct, id: string, props: PythonResourceProps) {
    super(scope, id)
    const onEventHandler = new PythonFunction(this, 'Handler', {
      entry: props.entry,
      index: props.index,
      handler: props.handler,
      runtime: props.runtime,
    })
    this.grantPrincipal = onEventHandler.grantPrincipal
    const provider = new Provider(this, 'Provider', {
      onEventHandler,
    })
    new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      properties: props.properties,
    })
  }

}