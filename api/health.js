// /backend/api/health.js
const express = require('express');
const router = express.Router();

router.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    instanceId: req.app.locals.instanceId,
    activeRooms: req.app.locals.localRooms.size,
    activeWorkers: req.app.locals.activeWorkers,
    uptime: process.uptime()
  });
});

module.exports = router;
