// /backend/websocket/handlers.js
const { redisClient } = require('../services/redisService');


// /backend/websocket/handlers.js
const {
    addUserToRoom,
    getRoomUsers,
    getRecentMessages,
    removeUserFromRoom,
    storeMessage
  } = require('../services/redisService');
  const {
    createMediasoupRouter,
    createWebRtcTransport,
    mediasoupRooms
  } = require('../services/mediasoupService');
  
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
      await createMediasoupRouter(roomId);
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
   * Handles a "getRouterRtpCapabilities" message.
   */
  // async function handleGetRouterRtpCapabilities(data, ws, context) {
  //   const { roomId } = data;
  //   // console.log("roomid", data)
  //   // console.log(roomId, context.mediasoupRooms.length ,  context.mediasoupRooms.has(roomId))
  //   if (context.mediasoupRooms && context.mediasoupRooms.has(roomId)) {
  //     const mediasoupRoom = context.mediasoupRooms.get(roomId);
  //     console.log(mediasoupRoom);
  //     ws.send(JSON.stringify({
  //       type: 'routerRtpCapabilities',
  //       data: mediasoupRoom.router.rtpCapabilities
  //     }));
  //   } else {
  //     ws.send(JSON.stringify({
  //       type: 'error',
  //       message: 'Room not properly initialized for media'
  //     }));
  //   }
  // }
  

 
async function handleGetRouterRtpCapabilities(data, ws, context) {
  const { roomId } = data;
  // Check if the mediasoup room exists in memory
  if (context.mediasoupRooms && context.mediasoupRooms.has(roomId)) {
    const mediasoupRoom = context.mediasoupRooms.get(roomId);
    console.log("Router RTP Capabilities (memory):", mediasoupRoom.router.rtpCapabilities);
    ws.send(JSON.stringify({
      type: 'routerRtpCapabilities',
      data: mediasoupRoom.router.rtpCapabilities
    }));
  } else {
    // If not in memory, attempt to retrieve stored RTP capabilities from Redis
    const capabilitiesStr = await redisClient.hget(`room:${roomId}`, 'routerRtpCapabilities');
    if (capabilitiesStr) {
      const capabilities = JSON.parse(capabilitiesStr);
      console.log("Router RTP Capabilities (Redis):", capabilities);
      ws.send(JSON.stringify({
        type: 'routerRtpCapabilities',
        data: capabilities
      }));
    } else {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Room not properly initialized for media'
      }));
    }
  }
}
  /**
   * Handles "createProducerTransport" for a teacher.
   */
  async function handleCreateProducerTransport(data, ws, context) {
    const { roomId, isTeacher } = data;
    console.log("producer",data, roomId, context.mediasoupRooms.has(roomId))
    if (roomId && context.mediasoupRooms && context.mediasoupRooms.has(roomId) && isTeacher) {
      const mediasoupRoom = context.mediasoupRooms.get(roomId);
      const { transport, params } = await createWebRtcTransport(mediasoupRoom.router);
      // Store the producer transport on the connection context.
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
  async function handleProduce(data, ws, context) {
    console.log(data , context.producerTransport); 
    if (context.producerTransport && data.isTeacher) {
      const { roomId, userId, kind, rtpParameters } = data;
      const mediasoupRoom = context.mediasoupRooms.get(roomId);
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
    console.log(roomId,context.mediasoupRooms , context.mediasoupRooms.has(roomId))
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
      const { transport, params } = await createWebRtcTransport(mediasoupRoom.router);
      const transportId = data.transportId;
      connectionContext.consumerTransports.set(transportId, transport);
      transport.on('dtlsstatechange', (dtlsState) => {
        if (dtlsState === 'closed') {
          transport.close();
          connectionContext.consumerTransports.delete(transportId);
        }
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
    console.log("consume",data)
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

      mediasoupRoom.consumers.set(consumer.id, consumer);
      consumer.on('transportclose', () => {
        consumer.close();
        mediasoupRoom.consumers.delete(consumer.id);
      });
      consumer.on('producerclose', () => {
        consumer.close();
        mediasoupRoom.consumers.delete(consumer.id);
        ws.send(JSON.stringify({
          type: 'producerClosed',
          consumerId: consumer.id,
          kind: consumer.kind
        }));
      });
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
      ws.send(JSON.stringify({ type: 'error', message: 'Error creating consumer' }));
    }
  }
  
  /**
   * Handles "resumeConsumer".
   */
  async function handleResumeConsumer(data, ws, context) {
    const { consumerId, roomId } = data;
    console.log("consume id in resume consumer",consumerId, roomId)
    const mediasoupRoom = context.mediasoupRooms.get(roomId);
    console.log(mediasoupRoom , mediasoupRoom.consumers.has(consumerId));
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
  