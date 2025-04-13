// /backend/websocket/handlers.js
const { redisClient, addUserToRoom, getRoomUsers, storeMessage } = require('../services/redisService');
const { createMediasoupRouter, createWebRtcTransport, mediasoupRooms } = require('../services/mediasoupService');

/**
 * Handles a "join" message.
 */
async function handleJoin(data, ws, context) {
  const { userId, roomId, isTeacher, name } = data;

  // Ensure a local room exists
  if (!context.localRooms.has(roomId)) {
    context.localRooms.set(roomId, new Map());
  }
  context.localRooms.get(roomId).set(userId, { ws, name, isTeacher });

  // Save user info to Redis along with this instance's ID.
  await addUserToRoom(roomId, userId, { name, isTeacher, instanceId: context.instanceId });

  // If the joining user is the teacher and a MediaSoup router hasn’t been created yet, create one.
  if (isTeacher && !mediasoupRooms.has(roomId)) {
    const router = await createMediasoupRouter(roomId);
    // Save the router's RTP capabilities in Redis for fallback use
    await redisClient.hset(`room:${roomId}`, 'routerRtpCapabilities', JSON.stringify(router.rtpCapabilities));
    // Also store the mediasoupRooms map in our context for later use.
    context.mediasoupRooms = mediasoupRooms;
  }

  const users = await getRoomUsers(roomId);
  return { type: 'user-joined', userId, name, isTeacher, users };
}

/**
 * Handles a "chat" message.
 */
async function handleChat(data, context) {
  const { userId, roomId, message } = data;
  const user = context.localRooms.get(roomId).get(userId);
  const chatMsg = {
    type: 'chat',
    userId,
    name: user.name,
    isTeacher: user.isTeacher,
    message,
    timestamp: Date.now()
  };

  // Save the chat message into Redis.
  await storeMessage(roomId, chatMsg);
  return chatMsg;
}

/**
 * Handles "getRouterRtpCapabilities" message.
 */
async function handleGetRouterRtpCapabilities(data, ws, context) {
  const { roomId } = data;
  
  // First try to get capabilities from local memory (if router exists on this instance)
  if (context.mediasoupRooms && context.mediasoupRooms.has(roomId)) {
    const mediasoupRoom = context.mediasoupRooms.get(roomId);
    console.log("Router RTP Capabilities from memory:", mediasoupRoom.router.rtpCapabilities);
    ws.send(JSON.stringify({
      type: 'routerRtpCapabilities',
      data: mediasoupRoom.router.rtpCapabilities
    }));
  } else {
    // Try to retrieve stored RTP capabilities from Redis
    try {
      const capabilitiesStr = await redisClient.hget(`room:${roomId}`, 'routerRtpCapabilities');
      if (capabilitiesStr) {
        const capabilities = JSON.parse(capabilitiesStr);
        console.log("Router RTP Capabilities from Redis:", capabilities);
        ws.send(JSON.stringify({
          type: 'routerRtpCapabilities',
          data: capabilities
        }));
      } else {
        // No router exists for this room yet
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Room not properly initialized for media. Please wait for teacher to join.'
        }));
      }
    } catch (error) {
      console.error("Error retrieving router capabilities from Redis:", error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Failed to get router capabilities'
      }));
    }
  }
}

/**
 * Handles "createProducerTransport" for a teacher.
 */
async function handleCreateProducerTransport(data, ws, context) {
  const { roomId, isTeacher } = data;
  console.log("Producer transport request:", data, roomId, context.mediasoupRooms && context.mediasoupRooms.has(roomId));
  if (roomId && context.mediasoupRooms && context.mediasoupRooms.has(roomId) && isTeacher) {
    const mediasoupRoom = context.mediasoupRooms.get(roomId);
    const announcedIp = await redisClient.hget(`room:${roomId}`, 'instanceIp');
    console.log(`Using announced IP for room ${roomId}:`, announcedIp);
    
    const { transport, params } = await createWebRtcTransport(mediasoupRoom.router, announcedIp);
    context.producerTransport = transport;
    transport.on('dtlsstatechange', (dtlsState) => {
      if (dtlsState === 'closed') transport.close();
    });
    ws.send(JSON.stringify({
      type: 'producerTransportCreated',
      data: params
    }));
  } else if (!isTeacher) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Only teachers can broadcast video'
    }));
  }
}

/**
 * Handles "connectProducerTransport".
 */
async function handleConnectProducerTransport(data, ws, context) {
  if (context.producerTransport) {
    await context.producerTransport.connect({ dtlsParameters: data.dtlsParameters });
    ws.send(JSON.stringify({ type: 'producerTransportConnected' }));
  }
}

/**
 * Handles "produce".
 */
/**
 * Handles "produce".
 */
async function handleProduce(data, ws, context) {
  console.log("Produce request:", data, context.producerTransport);
  if (context.producerTransport && data.isTeacher) {
    const { roomId, userId, kind, rtpParameters } = data;
    const mediasoupRoom = context.mediasoupRooms.get(roomId);
    
    // Deduplicate: if a producer of the same kind (e.g. 'video') exists, close it.
    for (const [pid, existingProducer] of mediasoupRoom.producers) {
      if (existingProducer.kind === kind) {
        console.log(`Producer of kind ${kind} already exists with ID: ${pid}. Closing it.`);
        existingProducer.close();
        mediasoupRoom.producers.delete(pid);
      }
    }
    
    // Create a new producer
    const producer = await context.producerTransport.produce({ kind, rtpParameters });
    mediasoupRoom.producers.set(producer.id, producer);
    
    producer.on('transportclose', () => {
      producer.close();
      mediasoupRoom.producers.delete(producer.id);
    });
    
    ws.send(JSON.stringify({
      type: 'produced',
      data: { id: producer.id, kind }
    }));
    
    // Broadcast a newProducer message (excluding the teacher who produced)
    const teacherData = context.localRooms.get(roomId).get(userId);
    return {
      type: 'newProducer',
      producerId: producer.id,
      kind,
      teacherId: userId,
      teacherName: teacherData.name
    };
  }
}

/**
 * Handles "getActiveProducers".
 */
async function handleGetActiveProducers(data, ws, context) {
  const { roomId } = data;
  console.log(roomId, context.mediasoupRooms, context.mediasoupRooms && context.mediasoupRooms.has(roomId));
  if (roomId && context.mediasoupRooms && context.mediasoupRooms.has(roomId)) {
    const mediasoupRoom = context.mediasoupRooms.get(roomId);
    const activeProducers = [];
    mediasoupRoom.producers.forEach((producer, producerId) => {
      let teacherId = null;
      let teacherName = null;
      context.localRooms.get(roomId).forEach((user, uid) => {
        if (user.isTeacher) {
          teacherId = uid;
          teacherName = user.name;
        }
      });
      activeProducers.push({
        id: producerId,
        kind: producer.kind,
        teacherId,
        teacherName
      });
    });
    ws.send(JSON.stringify({
      type: 'activeProducers',
      producers: activeProducers
    }));
  } else {
    ws.send(JSON.stringify({
      type: 'activeProducers',
      producers: []
    }));
  }
}

/**
 * Handles "createConsumerTransport".
 */
async function handleCreateConsumerTransport(data, ws, context, connectionContext) {
  const { roomId } = data;
  if (roomId && context.mediasoupRooms && context.mediasoupRooms.has(roomId)) {
    const mediasoupRoom = context.mediasoupRooms.get(roomId);
    const announcedIp = await redisClient.hget(`room:${roomId}`, 'instanceIp');
    console.log(`Using announced IP for room ${roomId}:`, announcedIp);
    
    const { transport, params } = await createWebRtcTransport(mediasoupRoom.router, announcedIp);
    const transportId = data.transportId;
    connectionContext.consumerTransports.set(transportId, transport);
    
    // Add extended logging for connection state changes
    transport.on('connectionstatechange', (state) => {
      console.log(`Consumer transport ${transportId} connection state changed to: ${state}`);
      if (state === 'failed' || state === 'closed') {
        console.log(`Consumer transport ${transportId} has failed. Closing transport.`);
        transport.close();
        connectionContext.consumerTransports.delete(transportId);
      }
    });

    transport.on('dtlsstatechange', (dtlsState) => {
      console.log(`Consumer transport ${transportId} DTLS state change: ${dtlsState}`);
    });
    
    ws.send(JSON.stringify({
      type: 'consumerTransportCreated',
      data: { transportId, params },
      producerId: data.producerId
    }));
  } else {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Failed to create consumer transport'
    }));
  }
}

/**
 * Handles "connectConsumerTransport".
 */
async function handleConnectConsumerTransport(data, ws, connectionContext) {
  const { transportId, dtlsParameters } = data;
  const transport = connectionContext.consumerTransports.get(transportId);
  if (transport) {
    await transport.connect({ dtlsParameters });
    ws.send(JSON.stringify({
      type: 'consumerTransportConnected',
      transportId,
      producerId: data.producerId
    }));
  } else {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Transport not found'
    }));
  }
}

/**
 * Handles "consume".
 */
async function handleConsume(data, ws, context, connectionContext) {
  const { roomId, transportId, producerId, rtpCapabilities } = data;
  console.log("Consume request:", data);
  const mediasoupRoom = context.mediasoupRooms.get(roomId);
  const transport = connectionContext.consumerTransports.get(transportId);
  if (!mediasoupRoom) {
    ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
    return;
  }
  if (!transport) {
    ws.send(JSON.stringify({ type: 'error', message: 'Transport not found' }));
    return;
  }
  const producer = mediasoupRoom.producers.get(producerId);
  if (!producer) {
    ws.send(JSON.stringify({ type: 'error', message: 'Producer not found' }));
    return;
  }
  const router = mediasoupRoom.router;
  if (!router.canConsume({ producerId, rtpCapabilities })) {
    ws.send(JSON.stringify({ type: 'error', message: 'Cannot consume producer' }));
    return;
  }
  try {
    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: true
    });
    console.log("Consumer created with ID:", consumer.id);
    
    // Add consumer event listeners
    consumer.on('transportclose', () => {
      console.log("Consumer transport closed for consumer:", consumer.id);
      mediasoupRoom.consumers.delete(consumer.id);
    });
    consumer.on('producerclose', () => {
      console.log("Producer closed; closing consumer:", consumer.id);
      consumer.close();
      mediasoupRoom.consumers.delete(consumer.id);
      ws.send(JSON.stringify({
        type: 'producerClosed',
        consumerId: consumer.id,
        kind: consumer.kind
      }));
    });
    
    mediasoupRoom.consumers.set(consumer.id, consumer);
    ws.send(JSON.stringify({
      type: 'consumed',
      data: {
        transportId,
        consumerId: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters
      }
    }));
  } catch (error) {
    console.error("Error creating consumer:", error);
    ws.send(JSON.stringify({ type: 'error', message: 'Error creating consumer' }));
  }
}


/**
 * Handles "resumeConsumer".
 */
async function handleResumeConsumer(data, ws, context) {
  const { consumerId, roomId } = data;
  console.log("Resume consumer request for consumer:", consumerId, "in room:", roomId);
  const mediasoupRoom = context.mediasoupRooms.get(roomId);
  if (mediasoupRoom && mediasoupRoom.consumers.has(consumerId)) {
    const consumer = mediasoupRoom.consumers.get(consumerId);
    await consumer.resume();
    ws.send(JSON.stringify({ type: 'consumerResumed', consumerId }));
  } else {
    ws.send(JSON.stringify({ type: 'error', message: 'Consumer not found' }));
  }
}

module.exports = {
  handleJoin,
  handleChat,
  handleGetRouterRtpCapabilities,
  handleCreateProducerTransport,
  handleConnectProducerTransport,
  handleProduce,
  handleGetActiveProducers,
  handleCreateConsumerTransport,
  handleConnectConsumerTransport,
  handleConsume,
  handleResumeConsumer
};
