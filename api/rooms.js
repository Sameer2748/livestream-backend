const express = require('express');
const router = express.Router();
const { createRoomInRedis } = require('../services/redisService');
const { launchInstanceForRoom, getInstanceForRoom } = require('../services/ec2Service');

// POST /api/create-room
router.post('/create-room', async (req, res) => {
  const { roomId, teacherName } = req.body;
  if (!roomId || roomId.length !== 6) {
    return res.status(400).json({ error: 'Invalid room ID' });
  }

  // Assume instanceId is injected into app.locals in server.js
  const instanceId = req.app.locals.instanceId;

  try {
    // First create the room in Redis
    const created = await createRoomInRedis(roomId, teacherName, instanceId);
    if (!created) return res.status(409).json({ error: 'Room already exists' });

    console.log(`Room ${roomId} created by teacher ${teacherName}`);

    // Launch an EC2 instance for this room
    const instanceInfo = await launchInstanceForRoom(roomId, teacherName);

    res.status(201).json({
      roomId,
      instanceUrl: `ws://${instanceInfo.publicIp}:3000` // URL for students to connect
      // Optionally, you can return instanceId: instanceInfo.instanceId if needed
    });
  } catch (error) {
    console.error('Error creating room:', error);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// GET /api/check-room/:roomId
router.get('/check-room/:roomId', async (req, res) => {
  const { roomId } = req.params;
  try {
    const exists = await req.app.locals.redisClient.exists(`room:${roomId}`);
    if (exists === 1) {
      // If room exists, get its instance info
      const instanceInfo = await getInstanceForRoom(roomId);
      if (instanceInfo) {
        res.json({
          exists: true,
          instanceUrl: `ws://${instanceInfo.publicIp}:3000`,
          instanceId: instanceInfo.instanceId // include if needed
        });
      } else {
        res.json({ exists: true, instanceUrl: null });
      }
    } else {
      res.json({ exists: false });
    }
  } catch (error) {
    console.error('Error checking room:', error);
    res.status(500).json({ error: 'Failed to check room' });
  }
});

// GET /api/join-room/:roomId
router.get('/join-room/:roomId', async (req, res) => {
  const { roomId } = req.params;
  try {
    // Check if room exists in Redis
    const roomExists = await req.app.locals.redisClient.exists(`room:${roomId}`);
    if (!roomExists) {
      return res.status(404).json({ error: 'Room not found' });
    }

    // Get the EC2 instance IP for this room
    const instanceIp = await req.app.locals.redisClient.hget(`room:${roomId}`, 'instanceIp');
    if (!instanceIp) {
      return res.status(404).json({ error: 'Room server not found' });
    }
    return res.json({ roomId, instanceIp: `ws://${instanceIp}:3000` });
  } catch (error) {
    console.error('Error joining room:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
