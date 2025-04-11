// /backend/services/redisService.js
const Redis = require('ioredis');
const dotenv = require('dotenv');
dotenv.config();

const redisClient = new Redis({
  host: process.env.REDIS_HOST || 'ec2-13-235-71-141.ap-south-1.compute.amazonaws.com',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || '',
  keepAlive: 10000,
  retryStrategy: (times) => Math.min(times * 50, 2000)
});

async function createRoomInRedis(roomId, teacherName, instanceId, instanceIp) {
  const roomExists = await redisClient.exists(`room:${roomId}`);
  if (roomExists) return false;
  await redisClient.hmset(`room:${roomId}`, {
    teacherName,
    createdAt: Date.now(),
    instanceId,   // stored for this room
    instanceIp    // stored for routing student requests to the correct EC2 instance
  });
  await redisClient.expire(`room:${roomId}`, 86400); // 24-hour expiry
  return true;
}

async function addUserToRoom(roomId, userId, userData) {
  await redisClient.hset(`room:${roomId}:users`, userId, JSON.stringify(userData));
}

async function removeUserFromRoom(roomId, userId) {
  await redisClient.hdel(`room:${roomId}:users`, userId);
  // Clean up if room is empty
  const users = await redisClient.hgetall(`room:${roomId}:users`);
  if (!users || Object.keys(users).length === 0) {
    await redisClient.del(`room:${roomId}`);
    await redisClient.del(`room:${roomId}:users`);
    await redisClient.del(`room:${roomId}:messages`);
  }
}

async function getRoomUsers(roomId) {
  const users = await redisClient.hgetall(`room:${roomId}:users`);
  const result = [];
  if (users) {
    for (const [uid, data] of Object.entries(users)) {
      const userData = JSON.parse(data);
      result.push({
        id: uid,
        name: userData.name,
        isTeacher: userData.isTeacher
      });
    }
  }
  return result;
}

async function storeMessage(roomId, message) {
  await redisClient.rpush(`room:${roomId}:messages`, JSON.stringify(message));
  await redisClient.ltrim(`room:${roomId}:messages`, -100, -1); // keep last 100 messages
}

async function getRecentMessages(roomId, limit = 50) {
  const messages = await redisClient.lrange(`room:${roomId}:messages`, -limit, -1);
  return messages.map(msg => JSON.parse(msg));
}

module.exports = {
  redisClient,
  createRoomInRedis,
  addUserToRoom,
  removeUserFromRoom,
  getRoomUsers,
  storeMessage,
  getRecentMessages
};
