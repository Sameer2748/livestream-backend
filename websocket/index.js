// /backend/websocket/index.js
const WebSocket = require('ws');
const {
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
} = require('./handlers');
const { broadcastToRoom } = require('./utils'); // Assume you have a small utils file for broadcasting

function setupWebSocketServer(server, context) {
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    // Each connection gets its own context for consumer transports and a producer transport reference.
    const connectionContext = {
      consumerTransports: new Map(),
      producerTransport: null
    };
    let userId = null;
    let roomId = null;
    let isTeacher = false;

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        console.log('Received message:', data.type);

        switch (data.type) {
          case 'join': {
            userId = data.userId;
            roomId = data.roomId;
            isTeacher = data.isTeacher;
            // Process join and broadcast a join message
            const joinResponse = await handleJoin(data, ws, context);
            broadcastToRoom(context.localRooms, roomId, joinResponse);
            // For students, send recent messages
            if (!isTeacher) {
              const { getRecentMessages } = require('../services/redisService');
              const recentMessages = await getRecentMessages(roomId);
              ws.send(JSON.stringify({ type: 'recent-messages', messages: recentMessages }));
            }
            break;
          }
          case 'chat': {
            if (roomId && userId) {
              const chatResponse = await handleChat(data, context);
              broadcastToRoom(context.localRooms, roomId, chatResponse);
            }
            break;
          }
          case 'getRouterRtpCapabilities': {

            await handleGetRouterRtpCapabilities(data, ws, context);
            break;
          }
          case 'createProducerTransport': {
            console.log(data, context);
            await handleCreateProducerTransport(data, ws, context);
            connectionContext.producerTransport = context.producerTransport;
            break;
          }
          case 'connectProducerTransport': {
            await handleConnectProducerTransport(data, ws, context);
            break;
          }
          case 'produce': {
            const produceMsg = await handleProduce({ ...data, isTeacher }, ws, context);
            if (produceMsg) {
              broadcastToRoom(context.localRooms, roomId, produceMsg, [userId]);
            }
            break;
          }
          case 'getActiveProducers': {
            await handleGetActiveProducers(data, ws, context);
            break;
          }
          case 'createConsumerTransport': {
            await handleCreateConsumerTransport(data, ws, context, connectionContext);
            break;
          }
          case 'connectConsumerTransport': {
            await handleConnectConsumerTransport(data, ws, connectionContext);
            break;
          }
          case 'consume': {
            await handleConsume(data, ws, context, connectionContext);
            break;
          }
          case 'resumeConsumer': {
            await handleResumeConsumer(data, ws, context);
            break;
          }
          default:
            console.log('Unknown message type:', data.type);
        }
      } catch (error) {
        console.error('Error processing message:', error);
        ws.send(JSON.stringify({ type: 'error', message: 'Internal server error' }));
      }
    });

    ws.on('close', async () => {
      if (roomId && userId && context.localRooms.has(roomId)) {
        const userData = context.localRooms.get(roomId).get(userId);
        context.localRooms.get(roomId).delete(userId);
        const { removeUserFromRoom } = require('../services/redisService');
        await removeUserFromRoom(roomId, userId);
        broadcastToRoom(context.localRooms, roomId, {
          type: 'user-left',
          userId,
          name: userData.name
        });
        if (context.localRooms.get(roomId).size === 0) {
          context.localRooms.delete(roomId);
          if (context.mediasoupRooms && context.mediasoupRooms.has(roomId)) {
            const mediasoupRoom = context.mediasoupRooms.get(roomId);
            mediasoupRoom.producers.forEach(producer => producer.close());
            mediasoupRoom.consumers.forEach(consumer => consumer.close());
            context.mediasoupRooms.delete(roomId);
          }
        }
      }
      if (connectionContext.producerTransport) connectionContext.producerTransport.close();
      connectionContext.consumerTransports.forEach(transport => transport.close());
      console.log('WebSocket connection closed');
    });
  });

  return wss;
}

module.exports = setupWebSocketServer;
