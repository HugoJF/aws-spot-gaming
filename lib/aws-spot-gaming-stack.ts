import {Stack, StackProps} from 'aws-cdk-lib';
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
import * as route53 from 'aws-cdk-lib/aws-route53';

export class AwsSpotGamingStack extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        const running = false;
        const gameName = 'web';
        const dnsName = undefined;
        const spotPrice = '0.05';
        const instanceType = 't3.nano';
        const hostedZoneName = 'aws.hugo.dev.br';
        const hostedZoneId = 'Z076062914KIZVO3HUW39';

        const keyName = 'MainLinux';
        const imageId = '/aws/service/ecs/optimized-ami/amazon-linux-2/recommended/image_id';
        const exposedPorts = {
            udp: [],
            tcp: [80],
        };

        const containerMemory = 256;
        const containerImage = 'pvermeyden/nodejs-hello-world:a1e8cf1edcc04e6d905078aed9861807f6da0da4';
        const containerPortMapping: ecs.PortMapping[] = [{
            containerPort: 80,
            hostPort: 80,
            protocol: ecs.Protocol.TCP,
        }];
        const containerEnvironment = {};

        // DO NOT MODIFY BELOW THIS LINE
        // DO NOT MODIFY BELOW THIS LINE
        // DO NOT MODIFY BELOW THIS LINE

        const desiredCapacity = running ? 1 : 0;
        const recordName = `${dnsName ?? gameName}.${hostedZoneName}`;

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

        const fs = new efs.FileSystem(this, 'FileSystem', {
            vpc,
            performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
            enableAutomaticBackups: true,
            lifecyclePolicy: efs.LifecyclePolicy.AFTER_7_DAYS,
        });

        const cluster = new ecs.CfnCluster(this, 'EcsCluster', {
            clusterName: 'EcsCluster',
        });

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
                `mkdir /opt/${gameName}`,
                `mount -t efs ${fs.fileSystemId}:/ /opt/${gameName}`,
                `chown 845:845 /opt/${gameName}`,
            ].join('\n').trim()),
        })

        const autoScalingGroup = new autoscaling.CfnAutoScalingGroup(this, 'AutoScalingGroup', {
            autoScalingGroupName: `${gameName}-asg`,
            availabilityZones: vpc.availabilityZones,
            launchConfigurationName: autoScalingLaunchConfiguration.ref,
            desiredCapacity: desiredCapacity.toString(),
            maxSize: desiredCapacity.toString(),
            minSize: desiredCapacity.toString(),
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
            actions: ['ec2:DescribeImages'],
            resources: ['*'],
        }));

        // Used to resolve a few variables in the template
        stackUpdateRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ssm:GetParameters'],
            resources: ['arn:aws:ssm:*::parameter/aws*'],
        }));

        // Used to update the ECS service DesiredCount
        stackUpdateRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ecs:DescribeServices', 'ecs:UpdateService'],
            resources: ['arn:aws:ssm:*::parameter/aws*'],
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

        const efsSecurityGroup = new ec2.SecurityGroup(this, 'EfsSg', {
            vpc,
            allowAllOutbound: true,
            securityGroupName: `${gameName}-efs`,
            description: `${gameName}-efs`,
        });
        efsSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(2049), 'Allow EFS access');

        const taskDefinition = new ecs.Ec2TaskDefinition(this, 'TaskDef', {
            volumes: [{
                name: gameName,
                host: {
                    sourcePath: `/opt/${gameName}`,
                },
            }],
        });

        const container = taskDefinition.addContainer(gameName, {
            image: ecs.ContainerImage.fromRegistry(containerImage),
            memoryReservationMiB: containerMemory,
            portMappings: containerPortMapping,
            environment: containerEnvironment,
        });
        container.addMountPoints({
            containerPath: '/data',
            sourceVolume: gameName,
            readOnly: false,
        })

        new ecs.CfnService(this, 'Service', {
            cluster: cluster.clusterName,
            serviceName: gameName,
            taskDefinition: taskDefinition.taskDefinitionArn,
            desiredCount: desiredCapacity,
            deploymentConfiguration: {
                minimumHealthyPercent: 0,
                maximumPercent: 100,
            },
        });

        new route53.ARecord(this, 'Record', {
            zone: route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
                zoneName: hostedZoneName,
                hostedZoneId: hostedZoneId,
            }),
            recordName: recordName,
            ttl: cdk.Duration.seconds(60),
            target: route53.RecordTarget.fromIpAddresses('127.0.0.1')
        });

        const updateDnsFunction = new lambda.Function(this, 'UpdateDns', {
            functionName: `${gameName}-update-dns`,
            description: `Sets Route 53 DNS Record for ${gameName}`,
            runtime: lambda.Runtime.PYTHON_3_7,
            handler: 'update-dns.handler',
            memorySize: 128,
            role: setDnsRole,
            code: lambda.Code.fromAsset(path.join(__dirname, '../res')),
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
    }
}
