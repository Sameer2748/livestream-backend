// // /backend/services/mediasoupService.js
// const os = require('os');
// const mediasoup = require('mediasoup');

// const workers = [];
// const numWorkers = Math.min(os.cpus().length);
// const mediaCodecs = [
//   {
//     kind: 'audio',
//     mimeType: 'audio/opus',
//     clockRate: 48000,
//     channels: 2
//   },
//   {
//     kind: 'video',
//     mimeType: 'video/VP8',
//     clockRate: 90000,
//     parameters: { 'x-google-start-bitrate': 1000 }
//   },
//   {
//     kind: 'video',
//     mimeType: 'video/H264',
//     clockRate: 90000,
//     parameters: {
//       'packetization-mode': 1,
//       'profile-level-id': '42e01f',
//       'level-asymmetry-allowed': 1
//     }
//   }
// ];

// // In-memory storage for room-specific MediaSoup objects
// const mediasoupRooms = new Map();

// async function initializeMediasoupWorkers() {
//   for (let i = 0; i < numWorkers; i++) {
//     const worker = await mediasoup.createWorker({
//       logLevel: 'warn',
//       logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp']
//     });
//     worker.on('died', () => {
//       console.error(`MediaSoup worker died [pid:${worker.pid}], exiting...`);
//       setTimeout(() => process.exit(1), 2000);
//     });
//     worker.appData = { load: 0 };
//     workers.push(worker);
//     console.log(`MediaSoup worker ${i + 1}/${numWorkers} initialized [pid:${worker.pid}]`);
//   }
// }

// function getLeastLoadedWorker() {
//   let minLoad = Infinity;
//   let selectedWorker = workers[0];
//   for (const worker of workers) {
//     if (worker.appData.load < minLoad) {
//       minLoad = worker.appData.load;
//       selectedWorker = worker;
//     }
//   }
//   selectedWorker.appData.load += 1;
//   return selectedWorker;
// }

// async function createMediasoupRouter(roomId) {
//   const worker = getLeastLoadedWorker();
//   const router = await worker.createRouter({ mediaCodecs });
//   if (!mediasoupRooms.has(roomId)) {
//     mediasoupRooms.set(roomId, {
//       router,
//       worker,
//       producers: new Map(),
//       consumers: new Map()
//     });
//   }
//   console.log(`Created MediaSoup router for room ${roomId}`);
//   return router;
// }

// async function createWebRtcTransport(router, announcedIp) {
//   const transport = await router.createWebRtcTransport({
//     listenIps: [{
//       ip: '0.0.0.0',
//       announcedIp: announcedIp || '127.0.0.1'
//     }],
//     enableUdp: true,
//     enableTcp: true,
//     preferUdp: true,
//     initialAvailableOutgoingBitrate: 1000000
//   });
//   console.log('Created WebRTC transport with ID:', transport.id);
//   return {
//     transport,
//     params: {
//       id: transport.id,
//       iceParameters: transport.iceParameters,
//       iceCandidates: transport.iceCandidates,
//       dtlsParameters: transport.dtlsParameters
//     }
//   };
// }

// module.exports = {
//   initializeMediasoupWorkers,
//   createMediasoupRouter,
//   createWebRtcTransport,
//   mediasoupRooms
// };

// /backend/services/mediasoupService.js
// /backend/services/mediasoupService.js
const os = require('os');
const mediasoup = require('mediasoup');
const { redisClient } = require('./redisService'); // Import the Redis client

const workers = [];
const numWorkers = Math.min(os.cpus().length, 4);
const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 1000 }
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1
    }
  }
];

// In-memory storage for room-specific MediaSoup objects
const mediasoupRooms = new Map();

async function initializeMediasoupWorkers() {
  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp']
    });
    worker.on('died', () => {
      console.error(`MediaSoup worker died [pid:${worker.pid}], exiting...`);
      setTimeout(() => process.exit(1), 2000);
    });
    worker.appData = { load: 0 };
    workers.push(worker);
    console.log(`MediaSoup worker ${i + 1}/${numWorkers} initialized [pid:${worker.pid}]`);
  }
}

function getLeastLoadedWorker() {
  let minLoad = Infinity;
  let selectedWorker = workers[0];
  for (const worker of workers) {
    if (worker.appData.load < minLoad) {
      minLoad = worker.appData.load;
      selectedWorker = worker;
    }
  }
  selectedWorker.appData.load += 1;
  return selectedWorker;
}

async function createMediasoupRouter(roomId) {
  const worker = getLeastLoadedWorker();
  const router = await worker.createRouter({ mediaCodecs });
  if (!mediasoupRooms.has(roomId)) {
    mediasoupRooms.set(roomId, {
      router,
      worker,
      producers: new Map(),
      consumers: new Map()
    });
  }
  console.log(`Created MediaSoup router for room ${roomId}`);

  // *** NEW: Store minimal router configuration in Redis ***
  // We store the router's RTP capabilities so that if another signaling server needs to load it,
  // it can retrieve these capabilities.
  await redisClient.hset(
    `room:${roomId}`,
    'routerRtpCapabilities',
    JSON.stringify(router.rtpCapabilities)
  );

  return router;
}

async function createWebRtcTransport(router, announcedIp) {
  const transport = await router.createWebRtcTransport({
    listenIps: [{
      ip: '0.0.0.0',
      announcedIp: announcedIp || '127.0.0.1'
    }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1000000
  });
  console.log('Created WebRTC transport with ID:', transport.id);
  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    }
  };
}

module.exports = {
  initializeMediasoupWorkers,
  createMediasoupRouter,
  createWebRtcTransport,
  mediasoupRooms
};
