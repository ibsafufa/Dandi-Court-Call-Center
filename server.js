const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.ALLOWED_ORIGIN || "*" }
});

const PORT = process.env.PORT || 3000;
const rooms = new Map(); // room ID -> Set(socket IDs)

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true }));

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, userName } = {}, callback = () => {}) => {
    roomId = String(roomId || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
    userName = String(userName || "Guest").trim().slice(0, 40) || "Guest";

    if (!roomId) return callback({ ok: false, message: "Enter a valid room code." });

    const members = rooms.get(roomId) || new Set();
    if (members.size >= 2) {
      return callback({ ok: false, message: "This room already has two participants." });
    }

    members.add(socket.id);
    rooms.set(roomId, members);
    socket.data.roomId = roomId;
    socket.data.userName = userName;
    socket.join(roomId);

    const otherId = [...members].find(id => id !== socket.id) || null;
    callback({ ok: true, roomId, otherUserPresent: Boolean(otherId) });

    if (otherId) {
      io.to(otherId).emit("peer-joined", { userName });
      socket.emit("waiting-for-peer", { userName: "Other participant" });
    } else {
      socket.emit("waiting-for-peer", {});
    }
  });

  // Relay WebRTC signaling only to the other participant in the same room.
  ["offer", "answer", "ice-candidate"].forEach(eventName => {
    socket.on(eventName, (payload) => {
      const roomId = socket.data.roomId;
      if (!roomId || !rooms.has(roomId)) return;
      socket.to(roomId).emit(eventName, payload);
    });
  });

  socket.on("leave-room", () => leaveRoom(socket));
  socket.on("disconnect", () => leaveRoom(socket));
});

function leaveRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  socket.to(roomId).emit("peer-left");
  socket.leave(roomId);
  const members = rooms.get(roomId);
  if (members) {
    members.delete(socket.id);
    if (members.size === 0) rooms.delete(roomId);
  }
  socket.data.roomId = null;
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Calling server running on http://localhost:${PORT}`);
});