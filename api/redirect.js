// /backend/api/redirect.js
const express = require('express');
const router = express.Router();
const { getRoomInstance } = require('../services/ec2Service');

// GET /api/redirect/:roomId
// Redirects users to the specific instance hosting their room
router.get('/redirect/:roomId', async (req, res) => {
  const { roomId } = req.params;
  
  try {
    const instanceInfo = await getRoomInstance(roomId);
    
    if (!instanceInfo) {
      return res.status(404).json({ error: 'Room not found or has no active instance' });
    }
    
    // Redirect user to the correct instance
    // You can use DNS instead of IP if you've set that up
    const redirectUrl = `https://${instanceInfo.publicIp}:${process.env.APP_PORT || 3000}/classroom/${roomId}`;
    
    // You can either do a redirect or return the URL
    if (req.query.json === 'true') {
      res.json({ redirectUrl });
    } else {
      res.redirect(redirectUrl);
    }
    
  } catch (error) {
    console.error(`Error redirecting for room ${roomId}:`, error);
    res.status(500).json({ error: 'Failed to process redirection' });
  }
});

module.exports = router;