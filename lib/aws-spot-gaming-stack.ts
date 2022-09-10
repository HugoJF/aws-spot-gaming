import {range} from "./utils";
import {CfnMapping, CfnParameter, Stack, StackProps} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as path from "path";
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dataSync from 'aws-cdk-lib/aws-datasync';

export class AwsSpotGamingStack extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        const usesDataSync = false;
        const gameName = 'zomboid';
        const dnsName = undefined;
        const spotPrice = '0.05';
        const instanceType = 't3.medium';
        const hostedZoneName = 'aws.hugo.dev.br';
        const hostedZoneId = 'Z076062914KIZVO3HUW39';

        const keyName = 'MainLinux';
        const imageId = '/aws/service/ecs/optimized-ami/amazon-linux-2/recommended/image_id';
        const exposedPorts = {
            udp: [8766, 8767, 16261],
            tcp: [27015, ...range(16262, 16272)],
        };

        const containerMemory = 3 * 1024;
        const containerImage = 'cyrale/project-zomboid:latest';
        const containerUserId = 1000;
        const containerEnvironment = {
            RCON_PASSWORD: 'averycoolpassword',
            ADMIN_PASSWORD: 'theadminpassword',
            SERVER_NAME: 'servertest',
            SERVER_PASSWORD: 'secretserver',
            SERVER_BRANCH: 'unstable',
        };
        const containerPortMapping: ecs.PortMapping[] = [];
        exposedPorts.udp.forEach(port => {
            containerPortMapping.push({
                containerPort: port,
                hostPort: port,
                protocol: ecs.Protocol.UDP,
            });
        });
        exposedPorts.tcp.forEach(port => {
            containerPortMapping.push({
                containerPort: port,
                hostPort: port,
                protocol: ecs.Protocol.TCP,
            });
        });

        // DO NOT MODIFY BELOW THIS LINE
        // DO NOT MODIFY BELOW THIS LINE
        // DO NOT MODIFY BELOW THIS LINE

        const recordName = `${dnsName ?? gameName}.${hostedZoneName}`;
        const fsMountPath = `/opt/${gameName}`;

        const stateParameter = new CfnParameter(this, 'ServerState', {
            type: 'String',
            allowedValues: ['Running', 'Stopped'],
            default: 'Stopped',
        })

        const stateMapping = new CfnMapping(this, 'StateMapping', {
            mapping: {
                'Running': {DesiredCapacity: 1},
                'Stopped': {DesiredCapacity: 0},
            }
        })

        const desiredCapacity = stateMapping.findInMap(stateParameter.valueAsString, 'DesiredCapacity');

        const setDnsRole = new iam.Role(this, 'SetDnsRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromManagedPolicyArn(
                    this,
                    'AWSLambdaBasicExecutionRole',
                    'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
                ),
            ],
        });
        setDnsRole.addToPolicy(new iam.PolicyStatement({
            actions: ['route53:*'],
            resources: ['*'],
        }));
        setDnsRole.addToPolicy(new iam.PolicyStatement({
            actions: ['ec2:DescribeInstance*'],
            resources: ['*'],
        }));

        const instanceRole = new iam.Role(this, 'InstanceRole', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromManagedPolicyArn(
                    this,
                    'AmazonEC2ContainerServiceforEC2Role',
                    'arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role',
                ),
            ],
        });
        instanceRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['route53:*'],
            resources: ['*'],
        }))

        const instanceProfile = new iam.CfnInstanceProfile(this, 'InstanceProfile', {
            roles: [instanceRole.roleName],
        });

        const vpc = new ec2.Vpc(this, 'VPC', {
            cidr: '10.0.0.0/16',
            maxAzs: 2,
            natGateways: 0,
            subnetConfiguration: [{
                cidrMask: 24,
                name: 'Public',
                subnetType: ec2.SubnetType.PUBLIC,
            }],
        })

        const ec2SecurityGroup = new ec2.SecurityGroup(this, 'Ec2Sg', {
            vpc,
            allowAllOutbound: true,
            securityGroupName: `${gameName}-ec2`,
            description: `${gameName}-ec2`,
        });
        ec2SecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), '[v4] Allow SSH access');
        ec2SecurityGroup.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(22), '[v6] Allow SSH access');
        exposedPorts.udp.forEach(port => ec2SecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(port), `[v4] Allow UDP port ${port}`));
        exposedPorts.tcp.forEach(port => ec2SecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(port), `[v4] Allow TCP port ${port}`));

        const efsSecurityGroup = new ec2.SecurityGroup(this, 'EfsSg', {
            vpc,
            allowAllOutbound: true,
            securityGroupName: `${gameName}-efs`,
            description: `${gameName}-efs`,
        });
        efsSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(2049), 'Allow EFS access');

        const fs = new efs.FileSystem(this, 'FileSystem', {
            vpc,
            performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
            enableAutomaticBackups: true,
            encrypted: false,
            lifecyclePolicy: efs.LifecyclePolicy.AFTER_7_DAYS,
            securityGroup: efsSecurityGroup,
        });

        const cluster = new ecs.CfnCluster(this, 'EcsCluster', {
            clusterName: 'EcsCluster',
        });

        // TODO: dynamic chown
        const autoScalingLaunchConfiguration = new autoscaling.CfnLaunchConfiguration(this, 'LaunchConfiguration', {
            associatePublicIpAddress: true,
            iamInstanceProfile: instanceProfile.ref,
            imageId: ec2.MachineImage.fromSsmParameter(imageId).getImage(this).imageId,
            instanceType: instanceType,
            keyName: keyName,
            securityGroups: [
                ec2SecurityGroup.securityGroupId,
            ],
            spotPrice: spotPrice,
            userData: cdk.Fn.base64([
                '#!/bin/bash -xe',
                `echo ECS_CLUSTER=${cluster.ref} >> /etc/ecs/ecs.config`,
                'yum install -y amazon-efs-utils',
                `mkdir ${fsMountPath}`,
                `mount -t efs ${fs.fileSystemId}:/ ${fsMountPath}`,
                `chown ${containerUserId}:${containerUserId} ${fsMountPath}`,
            ].join('\n')),
        })

        const autoScalingGroup = new autoscaling.CfnAutoScalingGroup(this, 'AutoScalingGroup', {
            autoScalingGroupName: `${gameName}-asg`,
            availabilityZones: vpc.availabilityZones,
            launchConfigurationName: autoScalingLaunchConfiguration.ref,
            desiredCapacity: desiredCapacity,
            maxSize: desiredCapacity,
            minSize: desiredCapacity,
            vpcZoneIdentifier: vpc.publicSubnets.map(subnet => subnet.subnetId),
        });

        const stackUpdateRole = new iam.Role(this, 'StackUpdateRole', {
            assumedBy: new iam.ServicePrincipal('cloudformation.amazonaws.com'),
        });

        stackUpdateRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['iam:PassRole', 'iam:GetRole'],
            resources: [instanceRole.roleArn],
        }));

        // Used to resolve EC2 AMI
        stackUpdateRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ec2:DescribeImages', 'ec2:DescribeAvailabilityZones', 'ec2:DescribeAccountAttributes', 'ec2:DescribeSubnets'],
            resources: ['*'],
        }));

        // Used to resolve a few variables in the template
        stackUpdateRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ssm:GetParameters'],
            resources: ['arn:aws:ssm:*:*:parameter/*'],
        }));

        // # Used to update AutoScaling DesiredCapacity
        stackUpdateRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['autoscaling:UpdateAutoScalingGroup'],
            resources: [`arn:aws:autoscaling:*:*:autoScalingGroup:*:autoScalingGroupName/${autoScalingGroup.autoScalingGroupName}`],
        }));

        // # Used to removing the existing LaunchConfiguration (not sure why it's needed)
        stackUpdateRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['autoscaling:DeleteLaunchConfiguration'],
            resources: [`arn:aws:autoscaling:*:*:launchConfiguration:*:launchConfigurationName/${autoScalingLaunchConfiguration.ref}*`],
        }));

        // Used to create a new LaunchConfiguration, needs to be every resource since we cannot predict the LogicalID (not sure why it's needed)
        stackUpdateRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['autoscaling:CreateLaunchConfiguration'],
            resources: ['*'],
        }));

        //  Used to update AutoScaling
        stackUpdateRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['autoscaling:DescribeLaunchConfigurations'],
            resources: ['*'],
        }));

        const taskDefinition = new ecs.Ec2TaskDefinition(this, 'TaskDef', {
            volumes: [{
                name: gameName,
                host: {sourcePath: fsMountPath},
            }],
        });

        const container = taskDefinition.addContainer(gameName, {
            image: ecs.ContainerImage.fromRegistry(containerImage),
            memoryReservationMiB: containerMemory,
            portMappings: containerPortMapping,
            environment: containerEnvironment,
        });
        container.addMountPoints({
            containerPath: '/server-data',
            sourceVolume: gameName,
            readOnly: false,
        })

        const ecsService = new ecs.CfnService(this, 'Service', {
            cluster: cluster.clusterName,
            serviceName: gameName,
            taskDefinition: taskDefinition.taskDefinitionArn,
            desiredCount: desiredCapacity as any as number,
            deploymentConfiguration: {
                minimumHealthyPercent: 0,
                maximumPercent: 100,
            },
        });

        // Used to update the ECS service DesiredCount
        stackUpdateRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ecs:DescribeServices', 'ecs:UpdateService'],
            resources: [ecsService.ref],
        }));


        const updateDnsFunction = new lambda.Function(this, 'DnsUpdateFunction', {
            functionName: `${gameName}-dns-update`,
            description: `Sets Route 53 DNS Record for ${gameName}`,
            runtime: lambda.Runtime.PYTHON_3_7,
            handler: 'dns-update.handler',
            memorySize: 128,
            role: setDnsRole,
            code: lambda.Code.fromAsset(path.join(__dirname, '../res/dns-update')),
            timeout: cdk.Duration.seconds(30),
            environment: {
                HostedZoneId: hostedZoneId,
                RecordName: recordName,
            },
        });

        const launchEvent = new events.Rule(this, 'LaunchEvent', {
            enabled: true,
            ruleName: `${gameName}-instance-launch`,
            eventPattern: {
                source: ['aws.autoscaling'],
                detailType: ['EC2 Instance Launch Successful'],
                detail: {
                    AutoScalingGroupName: [autoScalingGroup.ref],
                },
            },
            targets: [new targets.LambdaFunction(updateDnsFunction)],
        });

        updateDnsFunction.addPermission('UpdateDnsPermission', {
            principal: new iam.ServicePrincipal('events.amazonaws.com'),
            sourceArn: launchEvent.ruleArn,
            action: 'lambda:InvokeFunction',
        });

        if (usesDataSync) {
            const workbenchBucket = new s3.Bucket(this, 'S3Bucket', {
                bucketName: `${gameName}-data`,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            });

            const workbenchBucketRole = new iam.Role(this, 'WorkbenchBucketRole', {
                assumedBy: new iam.ServicePrincipal('datasync.amazonaws.com'),
            });
            workbenchBucketRole.addToPolicy(new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    's3:GetBucketLocation',
                    's3:ListBucket',
                    's3:ListBucketMultipartUploads'
                ],
                resources: [workbenchBucket.bucketArn],
            }));
            workbenchBucketRole.addToPolicy(new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    's3:AbortMultipartUpload',
                    's3:DeleteObject',
                    's3:GetObject',
                    's3:ListMultipartUploadParts',
                    's3:PutObjectTagging',
                    's3:GetObjectTagging',
                    's3:PutObject'
                ],
                resources: [workbenchBucket.bucketArn + '/*'],
            }));

            const s3Location = new dataSync.CfnLocationS3(this, 'S3Location', {
                s3BucketArn: workbenchBucket.bucketArn,
                subdirectory: '/',
                s3Config: {
                    bucketAccessRoleArn: workbenchBucketRole.roleArn,
                },
            });

            const efsLocation = new dataSync.CfnLocationEFS(this, 'EFSLocation', {
                efsFilesystemArn: fs.fileSystemArn,
                subdirectory: '/',
                ec2Config: {
                    securityGroupArns: [
                        `arn:aws:ec2:${this.region}:${this.account}:security-group/${efsSecurityGroup.securityGroupId}`,
                    ],
                    subnetArn: `arn:aws:ec2:${this.region}:${this.account}:subnet/${vpc.publicSubnets[0].subnetId}`,
                }
            });

            new dataSync.CfnTask(this, 'EfsToS3', {
                name: `${gameName}-EfsToS3`,
                sourceLocationArn: efsLocation.ref,
                destinationLocationArn: s3Location.ref,
            });

            new dataSync.CfnTask(this, 'S3ToEfs', {
                name: `${gameName}-S3ToEfs`,
                sourceLocationArn: s3Location.ref,
                destinationLocationArn: efsLocation.ref,
            });
        }
    }
}
