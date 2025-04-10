const AWS = require("aws-sdk");
const dotenv = require("dotenv");
dotenv.config();

// Configure AWS SDK
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY,
  secretAccessKey: process.env.AWS_SECRET_KEY,
  region: process.env.AWS_REGION || "ap-south-1",
});

const ec2 = new AWS.EC2();
const { redisClient } = require("./redisService");

// Cache for tracking EC2 launch operations
const pendingLaunches = new Map();

// Launch a new EC2 instance for a room using your custom AMI
async function launchInstanceForRoom(roomId, teacherName) {
  try {
    // Check if we already have an instance for this room
    const existingInstance = await getInstanceForRoom(roomId);
    if (existingInstance) {
      console.log(`Instance already exists for room ${roomId}: ${existingInstance}`);
      return existingInstance;
    }

    // If a launch is already in progress for this room, wait for it
    if (pendingLaunches.has(roomId)) {
      console.log(`Launch already in progress for room ${roomId}`);
      return pendingLaunches.get(roomId);
    }

    // Create a promise that will resolve when the instance is ready
    const launchPromise = new Promise(async (resolve, reject) => {
      try {
        // In this case, your custom AMI is pre-configured.
        // So you only need to trigger a restart of your backend.
        // For example, kill any process on port 3000 and then restart PM2.

        const userData = `#!/bin/bash
# Kill any existing process on port 3000 to avoid conflicts
sudo fuser -k 3000/tcp || true

# Change directory to the app folder (it should already be there in your custom AMI)
cd /home/ubuntu/livestream-backend

# Restart your app with PM2 (assumes PM2 and your app are already set up)
pm2 delete room-server || true
pm2 start server.js --name room-server
pm2 save
`;

        const params = {
          // Use your custom AMI ID (this should be the AMI that you manually configured)
          ImageId: process.env.EC2_AMI_ID, // e.g., your custom AMI ID
          InstanceType: "t3.medium", // Adjust based on your needs
          MinCount: 1,
          MaxCount: 1,
          UserData: Buffer.from(userData).toString("base64"),
          // It is best to ensure that the instance receives a public IP.
          // If your subnet auto-assigns a public IP, you can specify SecurityGroupIds here.
          // Otherwise, use NetworkInterfaces with AssociatePublicIpAddress set to true.
          ...(process.env.EC2_SUBNET_ID
            ? {
                NetworkInterfaces: [{
                  DeviceIndex: 0,
                  AssociatePublicIpAddress: true,
                  SubnetId: process.env.EC2_SUBNET_ID,
                  Groups: [process.env.EC2_SECURITY_GROUP]
                }]
              }
            : {
                SecurityGroupIds: [process.env.EC2_SECURITY_GROUP]
              }),
          TagSpecifications: [
            {
              ResourceType: "instance",
              Tags: [
                { Key: "Name", Value: `classroom-${roomId}` },
                { Key: "RoomId", Value: roomId },
              ],
            },
          ],
        };

        const result = await ec2.runInstances(params).promise();
        const instanceId = result.Instances[0].InstanceId;
        
        // Store the instance ID in Redis
        await redisClient.hset(`room:${roomId}`, "ec2InstanceId", instanceId);
        
        // Wait for the instance to be running and have a public IP
        console.log(`Waiting for instance ${instanceId} to be running...`);
        await ec2.waitFor("instanceRunning", {
          InstanceIds: [instanceId],
        }).promise();
        
        // Get the instance details including public IP
        const describeResult = await ec2.describeInstances({
          InstanceIds: [instanceId],
        }).promise();
        const publicIp = describeResult.Reservations[0].Instances[0].PublicIpAddress;
        
        // Store the public IP in Redis
        await redisClient.hset(`room:${roomId}`, "instanceIp", publicIp);
        console.log(`Instance ${instanceId} launched with IP ${publicIp} for room ${roomId}`);
        
        // Wait a bit for your application to start (adjust as needed)
        await new Promise((r) => setTimeout(r, 30000));
        resolve({ instanceId, publicIp });
      } catch (err) {
        console.error(`Error launching instance for room ${roomId}:`, err);
        reject(err);
      } finally {
        pendingLaunches.delete(roomId);
      }
    });
    
    // Store the promise in the pending launches map
    pendingLaunches.set(roomId, launchPromise);
    return launchPromise;
  } catch (error) {
    console.error(`Failed to launch instance for room ${roomId}:`, error);
    throw error;
  }
}

// Get the instance information for a room
async function getInstanceForRoom(roomId) {
  try {
    const instanceId = await redisClient.hget(`room:${roomId}`, "ec2InstanceId");
    const instanceIp = await redisClient.hget(`room:${roomId}`, "instanceIp");
    
    if (!instanceId || !instanceIp) {
      return null;
    }
    
    // Check if the instance is still running
    const result = await ec2.describeInstanceStatus({
      InstanceIds: [instanceId],
      IncludeAllInstances: true,
    }).promise();
    
    if (
      result.InstanceStatuses.length === 0 || 
      result.InstanceStatuses[0].InstanceState.Name !== "running"
    ) {
      // Instance is not running, clean up Redis
      await redisClient.hdel(`room:${roomId}`, "ec2InstanceId", "instanceIp");
      return null;
    }
    
    return { instanceId, publicIp: instanceIp };
  } catch (error) {
    console.error(`Error getting instance for room ${roomId}:`, error);
    return null;
  }
}

// Terminate an instance for a room
async function terminateInstanceForRoom(roomId) {
  try {
    const instanceInfo = await getInstanceForRoom(roomId);
    if (!instanceInfo) {
      return false;
    }
    
    await ec2.terminateInstances({
      InstanceIds: [instanceInfo.instanceId],
    }).promise();
    
    // Remove instance info from Redis
    await redisClient.hdel(`room:${roomId}`, "ec2InstanceId", "instanceIp");
    console.log(`Terminated instance ${instanceInfo.instanceId} for room ${roomId}`);
    return true;
  } catch (error) {
    console.error(`Error terminating instance for room ${roomId}:`, error);
    return false;
  }
}

// Check and terminate instances for empty rooms
async function cleanupEmptyRoomInstances() {
  try {
    // Get all rooms
    const roomKeys = await redisClient.keys("room:*");
    for (const key of roomKeys) {
      if (key.includes(":users") || key.includes(":messages")) continue;
      
      const roomId = key.split(":")[1];
      
      // Check if room has users
      const usersKey = `room:${roomId}:users`;
      const userCount = await redisClient.hlen(usersKey);
      
      if (userCount === 0) {
        console.log(`Room ${roomId} is empty, terminating instance...`);
        await terminateInstanceForRoom(roomId);
      }
    }
  } catch (error) {
    console.error("Error during cleanup of empty room instances:", error);
  }
}

module.exports = {
  launchInstanceForRoom,
  getInstanceForRoom,
  terminateInstanceForRoom,
  cleanupEmptyRoomInstances,
};
