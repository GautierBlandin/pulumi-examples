import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import * as synced from '@pulumi/synced-folder';
import * as url from 'url';

const stack = pulumi.getStack();
const stackConfig = new pulumi.Config();
const PRODUCTION = 'prod';

const certificateArn = stack === PRODUCTION ? stackConfig.require('certificateArn') : undefined;
const targetDomain = stack === PRODUCTION ? stackConfig.require('targetDomain') : undefined;

const config = {
  // targetDomain is the domain/host to serve content at.
  targetDomain: targetDomain,
  // If true create an A record for the www subdomain of targetDomain pointing to the generated cloudfront distribution.
  // If a certificate was generated it will support this subdomain.
  // default: true
  certificateArn: certificateArn,
};

const bucket = new aws.s3.Bucket('bucket');

new synced.S3BucketFolder('synced-folder', {
  path: '../build/client',
  bucketName: bucket.bucket,
  acl: 'private',
});

const lambdaRole = new aws.iam.Role('lambdaRole', {
  assumeRolePolicy: {
    Version: '2012-10-17',
    Statement: [
      {
        Action: 'sts:AssumeRole',
        Principal: {
          Service: 'lambda.amazonaws.com',
        },
        Effect: 'Allow',
        Sid: '',
      },
    ],
  },
});

new aws.iam.RolePolicyAttachment('lambdaRoleAttachment', {
  role: lambdaRole,
  policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
});

const lambda = new aws.lambda.Function(`server-${stack}-lambdaFunction`, {
  code: new pulumi.asset.AssetArchive({
    '.': new pulumi.asset.FileArchive('../build/lambda'),
  }),
  runtime: aws.lambda.Runtime.NodeJS20dX,
  role: lambdaRole.arn,
  handler: 'index.handler',
});

const apigw = new aws.apigatewayv2.Api('httpApiGateway', {
  protocolType: 'HTTP',
});

new aws.lambda.Permission('lambdaPermission', {
  action: 'lambda:InvokeFunction',
  principal: 'apigateway.amazonaws.com',
  function: lambda,
  sourceArn: pulumi.interpolate`${apigw.executionArn}/*/*`,
});

const integration = new aws.apigatewayv2.Integration('lambdaIntegration', {
  apiId: apigw.id,
  integrationType: 'AWS_PROXY',
  integrationUri: lambda.arn,
  payloadFormatVersion: '2.0',
});

const route = new aws.apigatewayv2.Route('apiRoute', {
  apiId: apigw.id,
  routeKey: '$default',
  target: pulumi.interpolate`integrations/${integration.id}`,
});

const stage = new aws.apigatewayv2.Stage('apiStage', {
  apiId: apigw.id,
  name: stack,
  routeSettings: [
    {
      routeKey: route.routeKey,
      throttlingBurstLimit: 5000,
      throttlingRateLimit: 10000,
    },
  ],
  autoDeploy: true,
});

export const httpApiEndpoint = pulumi.interpolate`${apigw.apiEndpoint}/${stage.name}`;

/*
 * Route53 configuration
 */

// Split a domain name into its subdomain and parent domain names.
// e.g. "www.example.com" => "www", "example.com".
function getDomainAndSubdomain(domain: string): { subdomain: string; parentDomain: string } {
  const parts = domain.split('.');
  if (parts.length < 2) {
    throw new Error(`No TLD found on ${domain}`);
  }
  // No subdomain, e.g. awesome-website.com.
  if (parts.length === 2) {
    return { subdomain: '', parentDomain: domain };
  }

  const subdomain = parts[0];
  parts.shift(); // Drop first element.
  return {
    subdomain,
    // Trailing "." to canonicalize domain.
    parentDomain: parts.join('.') + '.',
  };
}

// Creates a new Route53 DNS record pointing the domain to the CloudFront distribution.
function createAliasRecord(targetDomain: string, distribution: aws.cloudfront.Distribution): aws.route53.Record {
  const domainParts = getDomainAndSubdomain(targetDomain);
  const hostedZoneId = aws.route53
    .getZone({ name: domainParts.parentDomain }, { async: true })
    .then((zone) => zone.zoneId);
  return new aws.route53.Record(targetDomain, {
    name: domainParts.subdomain,
    zoneId: hostedZoneId,
    type: 'A',
    aliases: [
      {
        name: distribution.domainName,
        zoneId: distribution.hostedZoneId,
        evaluateTargetHealth: true,
      },
    ],
  });
}

function createWWWAliasRecord(targetDomain: string, distribution: aws.cloudfront.Distribution): aws.route53.Record {
  const domainParts = getDomainAndSubdomain(targetDomain);
  const hostedZoneId = aws.route53
    .getZone({ name: domainParts.parentDomain }, { async: true })
    .then((zone) => zone.zoneId);

  return new aws.route53.Record(`${targetDomain}-www-alias`, {
    name: `www.${targetDomain}`,
    zoneId: hostedZoneId,
    type: 'A',
    aliases: [
      {
        name: distribution.domainName,
        zoneId: distribution.hostedZoneId,
        evaluateTargetHealth: true,
      },
    ],
  });
}

// if config.includeWWW include an alias for the www subdomain
const distributionAliases = stack === PRODUCTION ? [config.targetDomain!, `www.${config.targetDomain!}`] : undefined;
/*
 * CloudFront configuration
 */

const cloudfrontOAC = new aws.cloudfront.OriginAccessControl('cloudfrontOAC', {
  originAccessControlOriginType: 's3',
  signingBehavior: 'always', // always override authorization header
  signingProtocol: 'sigv4', // only allowed value
});

const cachingDisabledPolicyId = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const cachingOptimizedPolicyId = '658327ea-f89d-4fab-a63d-7e88639e58f6';
const allVieverExceptHostHeaderPolicyId = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';

function getS3OriginCacheBehavior({ pathPattern }: { pathPattern: string }) {
  return {
    pathPattern,
    allowedMethods: ['GET', 'HEAD'],
    cachedMethods: ['GET', 'HEAD'],
    compress: true,
    cachePolicyId: stack === PRODUCTION ? cachingOptimizedPolicyId : cachingDisabledPolicyId,
    targetOriginId: 'S3Origin',
    viewerProtocolPolicy: 'redirect-to-https',
  };
}

const distribution = new aws.cloudfront.Distribution('distribution', {
  enabled: true,
  aliases: distributionAliases,
  httpVersion: 'http2',
  origins: [
    {
      originId: 'S3Origin',
      domainName: bucket.bucketRegionalDomainName,
      originAccessControlId: cloudfrontOAC.id,
    },
    {
      originId: 'APIGatewayOrigin',
      domainName: pulumi.interpolate`${httpApiEndpoint.apply((endpoint) => url.parse(endpoint).hostname)}`,
      originPath: pulumi.interpolate`/${stack}`,
      customOriginConfig: {
        httpPort: 80,
        httpsPort: 443,
        originProtocolPolicy: 'https-only',
        originSslProtocols: ['TLSv1.2'],
      },
    },
  ],
  defaultRootObject: '',
  defaultCacheBehavior: {
    allowedMethods: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
    cachedMethods: ['GET', 'HEAD', 'OPTIONS'],
    compress: false,
    cachePolicyId: cachingDisabledPolicyId,
    originRequestPolicyId: allVieverExceptHostHeaderPolicyId,
    targetOriginId: 'APIGatewayOrigin',
    viewerProtocolPolicy: 'redirect-to-https',
  },
  orderedCacheBehaviors: [
    getS3OriginCacheBehavior({ pathPattern: '/favicon.ico' }),
    getS3OriginCacheBehavior({ pathPattern: '/assets/*' }),
    getS3OriginCacheBehavior({ pathPattern: '/images/*' }),
  ],
  restrictions: {
    geoRestriction: {
      restrictionType: 'none',
    },
  },
  viewerCertificate:
    stack === PRODUCTION
      ? {
        acmCertificateArn: config.certificateArn, // Per AWS, ACM certificate must be in the us-east-1 region.
        sslSupportMethod: 'sni-only',
      }
      : {
        cloudfrontDefaultCertificate: true,
      },
});

new aws.s3.BucketPolicy('allowCloudFrontBucketPolicy', {
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
});

export const distributionAddress = pulumi.interpolate`https://${distribution.domainName}`;

if (stack === PRODUCTION) {
  createAliasRecord(config.targetDomain!, distribution);
  createWWWAliasRecord(config.targetDomain!, distribution);
}
