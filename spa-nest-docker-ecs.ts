import * as aws from '@pulumi/aws';
import * as synced from '@pulumi/synced-folder';
import * as pulumi from '@pulumi/pulumi';

// Create an AWS resource (S3 Bucket)
const bucket = new aws.s3.Bucket('next-static');

new synced.S3BucketFolder('synced-folder', {
  path: '../../apps/context-gpt/out',
  bucketName: bucket.bucket,
  acl: 'private',
});

// Create a VPC (we'll use the default VPC for simplicity)
const vpc = new aws.ec2.Vpc('my-vpc', {
  cidrBlock: '10.242.0.0/16',
  enableDnsHostnames: true,
  enableDnsSupport: true,
  tags: {
    Name: 'my-vpc',
  },
});

// Create public subnets
const publicSubnet1 = new aws.ec2.Subnet('public-subnet', {
  vpcId: vpc.id,
  cidrBlock: '10.242.1.0/24',
  mapPublicIpOnLaunch: true,
  availabilityZone: 'us-east-1a', // Replace with your desired AZ
  tags: {
    Name: 'public-subnet1',
  },
});

const publicSubnet2 = new aws.ec2.Subnet('public-subnet-2', {
  vpcId: vpc.id,
  cidrBlock: '10.242.2.0/24',
  mapPublicIpOnLaunch: true,
  availabilityZone: 'us-east-1b',
  tags: {
    Name: 'public-subnet-2',
  },
});

// Create an Internet Gateway
const internetGateway = new aws.ec2.InternetGateway('my-ig', {
  vpcId: vpc.id,
  tags: {
    Name: 'my-ig',
  },
});

// Create a route table
const routeTable = new aws.ec2.RouteTable('public-rt', {
  vpcId: vpc.id,
  routes: [
    {
      cidrBlock: '0.0.0.0/0',
      gatewayId: internetGateway.id,
    },
  ],
  tags: {
    Name: 'public-rt',
  },
});

// Associate the route table with the public subnet
const routeTableAssociation1 = new aws.ec2.RouteTableAssociation('public-rta', {
  subnetId: publicSubnet1.id,
  routeTableId: routeTable.id,
});

const routeTableAssociation2 = new aws.ec2.RouteTableAssociation('public-rta-2', {
  subnetId: publicSubnet2.id,
  routeTableId: routeTable.id,
});

// Create an ECS cluster
const cluster = new aws.ecs.Cluster('dev-cluster');

// Create a security group for the ALB
const albSg = new aws.ec2.SecurityGroup('alb-sg', {
  vpcId: vpc.id,
  ingress: [
    { protocol: 'tcp', fromPort: 80, toPort: 80, cidrBlocks: ['0.0.0.0/0'] },
    { protocol: 'tcp', fromPort: 443, toPort: 443, cidrBlocks: ['0.0.0.0/0'] },
  ],
  egress: [{ protocol: 'tcp', fromPort: 8000, toPort: 8000, cidrBlocks: [publicSubnet1.cidrBlock] }],
});

// EC2 instance security group
const instanceSg = new aws.ec2.SecurityGroup('instance-sg', {
  vpcId: vpc.id,
  ingress: [
    {
      protocol: 'tcp',
      fromPort: 8000,
      toPort: 8000,
      securityGroups: [albSg.id],
    },
  ],
  egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] }],
});
// Create an IAM role for the EC2 instances
const instanceRole = new aws.iam.Role('instance-role', {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: 'ec2.amazonaws.com' }),
});

// Attach the necessary policies to the instance role
new aws.iam.RolePolicyAttachment('ecs-instance-role-attachment', {
  role: instanceRole.name,
  policyArn: 'arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role',
});

// Create an instance profile
const instanceProfile = new aws.iam.InstanceProfile('instance-profile', {
  role: instanceRole.name,
});

// Create an IAM role for ECS task execution
const ecsTaskExecutionRole = new aws.iam.Role('ecs-task-execution-role', {
  assumeRolePolicy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Action: 'sts:AssumeRole',
        Effect: 'Allow',
        Principal: {
          Service: 'ecs-tasks.amazonaws.com',
        },
      },
    ],
  }),
});

// Attach the necessary policies to the ECS task execution role
new aws.iam.RolePolicyAttachment('ecs-task-execution-role-policy-attachment', {
  role: ecsTaskExecutionRole.name,
  policyArn: 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
});

export const unencodedUserData = pulumi.interpolate`#!/bin/bash
echo ECS_CLUSTER=${cluster.name} >> /etc/ecs/ecs.config`;

const userData = unencodedUserData.apply((data) => Buffer.from(data).toString('base64'));

// Create a launch template for the EC2 instances
const launchTemplate = new aws.ec2.LaunchTemplate(
  'launch-template',
  {
    instanceType: 't2.micro',
    imageId: aws.ec2
      .getAmi({
        owners: ['amazon'],
        mostRecent: true,
        filters: [{ name: 'name', values: ['amzn2-ami-ecs-hvm-*-x86_64-ebs'] }],
      })
      .then((ami) => ami.id),
    iamInstanceProfile: { arn: instanceProfile.arn },
    vpcSecurityGroupIds: [instanceSg.id],
    userData,
  },
  {
    dependsOn: [instanceProfile, instanceSg, cluster],
  },
);

// Create an Auto Scaling Group
const asg = new aws.autoscaling.Group('asg', {
  vpcZoneIdentifiers: [publicSubnet1.id, publicSubnet2.id],
  desiredCapacity: 1,
  maxSize: 1,
  minSize: 1,
  launchTemplate: {
    id: launchTemplate.id,
    version: '$Latest',
  },
});

// Create a capacity provider
const capacityProvider = new aws.ecs.CapacityProvider('capacity-provider', {
  autoScalingGroupProvider: {
    autoScalingGroupArn: asg.arn,
    managedTerminationProtection: 'DISABLED',
    managedScaling: {
      status: 'ENABLED',
      targetCapacity: 100,
    },
  },
});

// Associate the capacity provider with the cluster
new aws.ecs.ClusterCapacityProviders('cluster-capacity-providers', {
  clusterName: cluster.name,
  capacityProviders: [capacityProvider.name],
});

// Export the name of the bucket and cluster
export const bucketName = bucket.id;
export const clusterName = cluster.name;

export const vpcId = vpc.id;
export const publicSubnetId = publicSubnet1.id;

// Create an Application Load Balancer
const alb = new aws.lb.LoadBalancer('app-lb', {
  internal: false,
  loadBalancerType: 'application',
  securityGroups: [albSg.id],
  subnets: [publicSubnet1.id, publicSubnet2.id],
});

// Create a target group for the ALB
const targetGroup = new aws.lb.TargetGroup('app-tg', {
  port: 8000,
  protocol: 'HTTP',
  targetType: 'instance',
  vpcId: vpc.id,
  healthCheck: {
    enabled: true,
    path: '/api/health',
    port: '8000',
    protocol: 'HTTP',
    healthyThreshold: 3,
    unhealthyThreshold: 3,
    timeout: 5,
    interval: 30,
    matcher: '200',
  },
});

// Create a listener for the ALB
const listener = new aws.lb.Listener('app-listener', {
  loadBalancerArn: alb.arn,
  port: 80,
  defaultActions: [
    {
      type: 'forward',
      targetGroupArn: targetGroup.arn,
    },
  ],
});

const logGroup = new aws.cloudwatch.LogGroup('app-log-group', {
  name: '/ecs/app-task',
  retentionInDays: 30,
});

const claudeApiKey = aws.ssm.getParameter({ name: '/context-gpt/claude-api-key' });
const apiAccessToken = aws.ssm.getParameter({ name: '/context-gpt/api-access-token' });

// Create an ECS task definition
const taskDefinition = new aws.ecs.TaskDefinition('app-task', {
  family: 'app-task',
  memory: '512',
  networkMode: 'host',
  executionRoleArn: ecsTaskExecutionRole.arn, // Use the new ECS task execution role
  taskRoleArn: ecsTaskExecutionRole.arn,
  containerDefinitions: pulumi.all([claudeApiKey, apiAccessToken]).apply(([claudeApiKeyValue, apiAccessTokenValue]) =>
    JSON.stringify([
      {
        name: 'app',
        image: '058264106231.dkr.ecr.us-east-1.amazonaws.com/context-gpt:latest',
        portMappings: [
          {
            containerPort: 8000,
            hostPort: 8000,
          },
        ],
        environment: [
          {
            name: 'CLAUDE_API_KEY',
            value: claudeApiKeyValue.value,
          },
          {
            name: 'API_ACCESS_TOKEN',
            value: apiAccessTokenValue.value,
          },
        ],
        logConfiguration: {
          logDriver: 'awslogs',
          options: {
            'awslogs-group': '/ecs/app-task',
            'awslogs-region': 'us-east-1',
            'awslogs-stream-prefix': 'ecs',
          },
        },
      },
    ]),
  ),
});

// Create an ECS service
const ecsService = new aws.ecs.Service('app-service', {
  capacityProviderStrategies: [{ capacityProvider: capacityProvider.name, weight: 1 }],
  cluster: cluster.id,
  taskDefinition: taskDefinition.arn,
  desiredCount: 1,
  loadBalancers: [
    {
      targetGroupArn: targetGroup.arn,
      containerName: 'app',
      containerPort: 8000,
    },
  ],
});

export const apiURL = pulumi.interpolate`http://${alb.dnsName}`;

const cloudfrontOAC = new aws.cloudfront.OriginAccessControl('cloudfrontOAC', {
  originAccessControlOriginType: 's3',
  signingBehavior: 'always',
  signingProtocol: 'sigv4',
});
const cachingDisabledPolicyId = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const cachingOptimizedPolicyId = '658327ea-f89d-4fab-a63d-7e88639e58f6';
const allVieverExceptHostHeaderPolicyId = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';

const distribution = new aws.cloudfront.Distribution('s3Distribution', {
  enabled: true,
  defaultRootObject: 'index.html',

  origins: [
    {
      domainName: bucket.bucketRegionalDomainName,
      originId: 'S3Origin',
      originAccessControlId: cloudfrontOAC.id,
    },
    {
      domainName: alb.dnsName,
      originId: 'ALBOrigin',
      customOriginConfig: {
        httpPort: 80,
        httpsPort: 443,
        originProtocolPolicy: 'http-only',
        originSslProtocols: ['TLSv1.2'],
      },
    },
  ],

  defaultCacheBehavior: {
    allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
    cachedMethods: ['GET', 'HEAD', 'OPTIONS'],
    compress: true,
    cachePolicyId: cachingDisabledPolicyId,
    targetOriginId: 'S3Origin',
    viewerProtocolPolicy: 'redirect-to-https',
  },
  orderedCacheBehaviors: [
    {
      pathPattern: '/api/*',
      allowedMethods: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
      cachedMethods: ['GET', 'HEAD', 'OPTIONS'],
      compress: true,
      cachePolicyId: cachingDisabledPolicyId,
      originRequestPolicyId: allVieverExceptHostHeaderPolicyId,
      targetOriginId: 'ALBOrigin',
      viewerProtocolPolicy: 'redirect-to-https',
    },
  ],

  restrictions: {
    geoRestriction: {
      restrictionType: 'none',
    },
  },

  viewerCertificate: {
    cloudfrontDefaultCertificate: true,
  },
});

new aws.s3.BucketPolicy(
  'allowCloudFrontBucketPolicy',
  {
    bucket: bucket.bucket,
    policy: {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'AllowCloudFrontServicePrincipalRead',
          Effect: 'Allow',
          Principal: {
            Service: 'cloudfront.amazonaws.com',
          },
          Action: ['s3:GetObject'],
          Resource: pulumi.interpolate`${bucket.arn}/*`,
          Condition: {
            StringEquals: {
              'AWS:SourceArn': distribution.arn,
            },
          },
        },
      ],
    },
  },
  { dependsOn: [bucket, distribution] },
);

export const cloudFrontUrl = distribution.domainName;
