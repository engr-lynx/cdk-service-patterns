import {
  join,
} from 'path'
import {
  Resource,
  Construct,
  Arn,
  CustomResource,
  RemovalPolicy,
} from '@aws-cdk/core'
import {
  CloudFrontWebDistribution,
  CloudFrontWebDistributionProps,
  OriginAccessIdentity,
  PriceClass,
} from '@aws-cdk/aws-cloudfront'
import {
  Bucket,
  BucketProps,
} from '@aws-cdk/aws-s3'
import {
  Repository,
  RepositoryProps,
} from '@aws-cdk/aws-ecr'
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
  User,
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

// !ToDo: Use projen (https://www.npmjs.com/package/projen).
// ToDo: Use CDK nag (https://www.npmjs.com/package/cdk-nag).
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

// S3

export class StackRemovableBucket extends Bucket {

  constructor(scope: Construct, id: string, props?: BucketProps) {
    super(scope, id, props)
    if (props?.removalPolicy == RemovalPolicy.DESTROY) {
      const entry = join(__dirname, 'custom-resource', 'empty-bucket')
      const properties = {
        bucketName: this.bucketName,
      }
      const emptyResource = new PythonResource(this, 'EmptyResource', {
        entry,
        properties,
      })
      this.grantRead(emptyResource)
      this.grantDelete(emptyResource)
    }
  }

}

// ECR

export class StackRemovableRepository extends Repository {

  constructor(scope: Construct, id: string, props?: RepositoryProps) {
    super(scope, id, props)
    if (props?.removalPolicy == RemovalPolicy.DESTROY) {
      const entry = join(__dirname, 'custom-resource', 'empty-repo')
      const properties = {
        imageRepoName: this.repositoryName,
      }
      const emptyResource = new PythonResource(this, 'EmptyResource', {
        entry,
        properties,
      })
      // ToDo: Aggregate grant to delete.
      this.grant(emptyResource, 'ecr:ListImages', 'ecr:BatchDeleteImage')
    }
  }

}

// IAM User

export class CustomUser extends User {

  grant(grantee: IGrantable, ...actions: string[]) {
    const arn = Arn.format({
      service: 'iam',
      resource: 'user',
      region: '',
      resourceName: this.userName,
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

  grantCreateServiceSpecificCredential(grantee: IGrantable) {
    return this.grant(grantee, 'iam:CreateServiceSpecificCredential')
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

// !ToDo: May not be needed anymore if using cdk-triggers
export interface PythonResourceProps {
  readonly entry: string;
  readonly index?: string;
  readonly handler?: string;
  readonly runtime?: Runtime;
  readonly properties?: KeyValue,
}

export class PythonResource extends Construct implements IGrantable {

  public readonly resource: CustomResource
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
    this.resource = new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      properties: props.properties,
    })
  }

}