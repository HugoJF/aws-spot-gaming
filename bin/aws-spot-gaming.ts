#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import {AwsSpotGamingStack} from '../lib/aws-spot-gaming-stack';
import {range} from "../lib/utils";
import {InstanceClass, InstanceSize} from "aws-cdk-lib/aws-ec2";

const app = new cdk.App();
new AwsSpotGamingStack(app, 'nginx-stack', {
    env: {account: '186669703643', region: 'sa-east-1'},
    tags: {
        project: 'aws-spot-gaming',
    },
    usesDataSync: false,
    gameName: 'nginx',
    spotPrice: '0.05',
    instance: {
        class: InstanceClass.BURSTABLE3,
        size: InstanceSize.NANO,
    },
    hostedZoneName: 'aws.hugo.dev.br',

    keyName: 'MainLinux',
    imageId: '/aws/service/ecs/optimized-ami/amazon-linux-2/recommended/image_id',
    exposedPorts: {
        tcp: [80],
        udp: [],
    },

    container: {
        memory: 256,
        image: 'nginxdemos/hello',
    }
});
new AwsSpotGamingStack(app, 'AwsSpotGamingStack', {
    env: {account: '186669703643', region: 'sa-east-1'},

    usesDataSync: false,
    gameName: 'zomboid',
    dnsName: undefined,
    spotPrice: '0.05',
    instance: {
        class: InstanceClass.BURSTABLE3,
        size: InstanceSize.MEDIUM,
    },
    hostedZoneName: 'aws.hugo.dev.br',

    keyName: 'MainLinux',
    imageId: '/aws/service/ecs/optimized-ami/amazon-linux-2/recommended/image_id',
    exposedPorts: {
        udp: [8766, 8767, 16261],
        tcp: [27015, ...range(16262, 16272)],
    },

    container: {
        memory: 3 * 1024,
        image: 'cyrale/project-zomboid:latest',
        userId: 1000,
        environment: {
            RCON_PASSWORD: 'averycoolpassword',
            ADMIN_PASSWORD: 'theadminpassword',
            SERVER_NAME: 'servertest',
            SERVER_PASSWORD: 'secretserver',
            SERVER_BRANCH: 'unstable',
        },
    }
});
