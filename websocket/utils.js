// /backend/websocket/utils.js
function broadcastToRoom(localRooms, roomId, message, excludeUserIds = []) {
  if (!localRooms.has(roomId)) return;
  const room = localRooms.get(roomId);
  const msg = JSON.stringify(message);
  room.forEach((user, uid) => {
    if (!excludeUserIds.includes(uid) && user.ws.readyState === user.ws.OPEN) {
      user.ws.send(msg);
    }
  });
}

module.exports = { broadcastToRoom };
