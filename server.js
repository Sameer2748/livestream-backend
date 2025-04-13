// /backend/server.js
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');
const { cleanupEmptyRoomInstances } = require('./services/ec2Service');


dotenv.config();

const app = express();
const server = http.createServer(app);

// Global state
const localRooms = new Map();

// Generate a unique instance ID (this is stored in Redis for each room)
const instanceId = uuidv4();
console.log(`Instance ID: ${instanceId}`);
const context = {
  localRooms,
  instanceId,
  // mediasoupRooms will be assigned by the mediasoupService or as handlers create a router
  mediasoupRooms: new Map()
};

// Make instanceId and localRooms available in app.locals for API routes and others
app.locals.instanceId = instanceId;
app.locals.localRooms = localRooms;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Import services and APIs
const { redisClient } = require('./services/redisService');
app.locals.redisClient = redisClient;

const { initializeMediasoupWorkers } = require('./services/mediasoupService');
// For health API, we pass activeWorkers count via app.locals
app.locals.activeWorkers = 0; // This will be updated after worker initialization

// Import API routes
const roomsRoutes = require('./api/rooms');
const healthRoutes = require('./api/health');
app.use('/api', roomsRoutes);
app.use('/api', healthRoutes);

// Set up WebSocket server
const setupWebSocketServer = require('./websocket/index');
const wsServer = setupWebSocketServer(server, context);

// Start the server after initializing MediaSoup workers
async function startServer() {
  try {
    // Test Redis connection
    const pong = await redisClient.ping();
    console.log('Connected to Redis:', pong);

    // Initialize MediaSoup workers
    await initializeMediasoupWorkers();
    // Update activeWorkers (if you want to use it in health-check)
    app.locals.activeWorkers = require('./services/mediasoupService').workersCount || 0;
    // setInterval(cleanupEmptyRoomInstances, 2 * 60 * 1000); // Check every 5 minutes

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Instance ID: ${instanceId}`);
    });
    
    // Optional: Set up intervals for publishing metrics, etc.
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}
// Graceful shutdown on SIGTERM
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  wsServer.clients.forEach(client => client.close(1001, 'Server is shutting down'));
  await redisClient.quit();
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

startServer();
