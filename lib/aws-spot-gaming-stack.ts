import * as cdk from 'aws-cdk-lib';
import {CfnMapping, CfnParameter, Stack, StackProps} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import {InstanceType} from 'aws-cdk-lib/aws-ec2';
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
import * as route53 from 'aws-cdk-lib/aws-route53';

interface ExposedPorts {
    udp: number[];
    tcp: number[];
}

interface ContainerProps {
    memory: number;
    image: string;
    userId?: number;
    environment?: Record<string, string>;
}

interface GameServerStackProps extends StackProps {
    usesDataSync: boolean;
    gameName: string;
    dnsName?: string;
    spotPrice: string;
    instance: {
        class: ec2.InstanceClass,
        size: ec2.InstanceSize,
    }
    hostedZoneName: string;
    keyName: string;
    imageId: string;
    exposedPorts: ExposedPorts;
    container: ContainerProps;
}

export class AwsSpotGamingStack extends Stack {
    constructor(scope: Construct, id: string, props: GameServerStackProps) {
        super(scope, id, props);

        const containerPortMapping = Object.values(ecs.Protocol).flatMap(protocol => (
            props.exposedPorts[protocol].map(port => ({
                containerPort: port,
                hostPort: port,
                protocol: protocol,
            }))
        ))

        const recordName = `${props.dnsName ?? props.gameName}.${props.hostedZoneName}`;
        const fsMountPath = `/opt/${props.gameName}`;

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

        const vpc = ec2.Vpc.fromLookup(this, 'VPC', {
            isDefault: true,
        })

        const ec2SecurityGroup = new ec2.SecurityGroup(this, 'Ec2Sg', {
            vpc,
            allowAllOutbound: true,
            securityGroupName: `${props.gameName}-ec2`,
            description: `${props.gameName}-ec2`,
        });
        ec2SecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), '[v4] Allow SSH access');
        ec2SecurityGroup.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(22), '[v6] Allow SSH access');
        props.exposedPorts.udp.forEach(port => ec2SecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(port), `[v4] Allow UDP port ${port}`));
        props.exposedPorts.tcp.forEach(port => ec2SecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(port), `[v4] Allow TCP port ${port}`));

        const efsSecurityGroup = new ec2.SecurityGroup(this, 'EfsSg', {
            vpc,
            allowAllOutbound: true,
            securityGroupName: `${props.gameName}-efs`,
            description: `${props.gameName}-efs`,
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
            clusterName: `${props.gameName}-cluster`,
        });


        // TODO: dynamic chown
        const autoScalingLaunchConfiguration = new autoscaling.CfnLaunchConfiguration(this, 'LaunchConfiguration', {
            associatePublicIpAddress: true,
            iamInstanceProfile: instanceProfile.ref,
            imageId: ec2.MachineImage.fromSsmParameter(props.imageId).getImage(this).imageId,
            instanceType: InstanceType.of(props.instance.class, props.instance.size).toString(),
            keyName: props.keyName,
            securityGroups: [
                ec2SecurityGroup.securityGroupId,
            ],
            spotPrice: props.spotPrice,
            userData: cdk.Fn.base64([
                '#!/bin/bash -xe',
                `echo ECS_CLUSTER=${cluster.ref} >> /etc/ecs/ecs.config`,
                'yum install -y amazon-efs-utils',
                `mkdir ${fsMountPath}`,
                `mount -t efs ${fs.fileSystemId}:/ ${fsMountPath}`,
                props.container.userId && `chown ${props.container.userId}:${props.container.userId} ${fsMountPath}`,
            ].filter(Boolean).join('\n')),
        })

        const autoScalingGroup = new autoscaling.CfnAutoScalingGroup(this, 'AutoScalingGroup', {
            autoScalingGroupName: `${props.gameName}-asg`,
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
                name: props.gameName,
                host: {sourcePath: fsMountPath},
            }],
        });

        const container = taskDefinition.addContainer(props.gameName, {
            image: ecs.ContainerImage.fromRegistry(props.container.image),
            memoryReservationMiB: props.container.memory,
            portMappings: containerPortMapping,
            environment: props.container.environment,
        });

        container.addMountPoints({
            containerPath: '/server-data',
            sourceVolume: props.gameName,
            readOnly: false,
        })

        const ecsService = new ecs.CfnService(this, 'Service', {
            cluster: cluster.clusterName,
            serviceName: props.gameName,
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


        const hz = route53.HostedZone.fromLookup(this, 'HostedZone', {
            domainName: props.hostedZoneName,
        });

        const updateDnsFunction = new lambda.Function(this, 'DnsUpdateFunction', {
            functionName: `${props.gameName}-dns-update`,
            description: `Sets Route 53 DNS Record for ${props.gameName}`,
            runtime: lambda.Runtime.PYTHON_3_7,
            handler: 'dns-update.handler',
            memorySize: 128,
            role: setDnsRole,
            code: lambda.Code.fromAsset(path.join(__dirname, '../res/dns-update')),
            timeout: cdk.Duration.seconds(30),
            environment: {
                HostedZoneId: hz.hostedZoneId,
                RecordName: recordName,
            },
        });

        const launchEvent = new events.Rule(this, 'LaunchEvent', {
            enabled: true,
            ruleName: `${props.gameName}-instance-launch`,
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

        if (props.usesDataSync) {
            const workbenchBucket = new s3.Bucket(this, 'S3Bucket', {
                bucketName: `${props.gameName}-data`,
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
                name: `${props.gameName}-EfsToS3`,
                sourceLocationArn: efsLocation.ref,
                destinationLocationArn: s3Location.ref,
            });

            new dataSync.CfnTask(this, 'S3ToEfs', {
                name: `${props.gameName}-S3ToEfs`,
                sourceLocationArn: s3Location.ref,
                destinationLocationArn: efsLocation.ref,
            });
        }
    }
}
