// ============================================================
//  Socket.io setup
//  - Attach กับ http server ที่ server.js สร้าง
//  - Path: /api/socket.io (อยู่ใต้ /api เพื่อให้ผ่าน nginx proxy เดิมได้)
//  - Auth: JWT ใน handshake.auth.token (เหมือน middleware verifyToken)
//  - แต่ละ user join personal room ชื่อ user:<id> → ส่งข้อความถึงตัวเดียวง่าย
//
//  Events ที่ฟัง (จาก client):
//    chat:typing { to_user_id, is_typing }
//    chat:read   { conv_id }
//
//  Events ที่ emit (ไปยัง client):
//    chat:message { msg_id, msg_conv_id, msg_sender_id, msg_content, ... }
//    chat:typing  { from_user_id, is_typing }
//    chat:read    { conv_id, by_user_id, read_at }
// ============================================================

const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const pool = require('./db');

let io = null;

function initSocket(httpServer, corsOptions) {
  io = new Server(httpServer, {
    cors: corsOptions || { origin: true, credentials: true },
    path: '/api/socket.io',
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  // ---------- Auth middleware ----------
  io.use((socket, next) => {
    try {
      const token =
        (socket.handshake.auth && socket.handshake.auth.token) ||
        (socket.handshake.query && socket.handshake.query.token);
      if (!token) return next(new Error('ไม่มี token'));
      if (!process.env.JWT_SECRET) return next(new Error('Server config error'));

      const decoded = jwt.verify(String(token), process.env.JWT_SECRET);
      socket.user_id = decoded.user_id;
      socket.user_email = decoded.user_email;
      socket.user_role = decoded.user_role;
      socket.join(`user:${decoded.user_id}`);
      next();
    } catch (err) {
      next(new Error('token ไม่ถูกต้องหรือหมดอายุ'));
    }
  });

  // ---------- Connection ----------
  io.on('connection', (socket) => {
    console.log(`[socket] user ${socket.user_id} connected (${socket.id})`);

    // typing indicator → ส่งต่อให้คู่สนทนา
    socket.on('chat:typing', (data) => {
      const otherUserId = Number(data && data.to_user_id);
      if (!Number.isInteger(otherUserId) || otherUserId < 1) return;
      io.to(`user:${otherUserId}`).emit('chat:typing', {
        from_user_id: socket.user_id,
        is_typing: !!(data && data.is_typing),
      });
    });

    // mark read — อ่านข้อความใน conv นี้ทั้งหมด (ของฝั่งตรงข้าม)
    socket.on('chat:read', async (data) => {
      const convId = Number(data && data.conv_id);
      if (!Number.isInteger(convId) || convId < 1) return;
      try {
        // ต้องเป็นสมาชิกของ conv นี้
        const [c] = await pool.execute(
          `SELECT conv_user1_id, conv_user2_id
             FROM conversation_chaungthai WHERE conv_id = ? LIMIT 1`,
          [convId]
        );
        if (c.length === 0) return;
        const isMember =
          c[0].conv_user1_id === socket.user_id ||
          c[0].conv_user2_id === socket.user_id;
        if (!isMember) return;

        const [r] = await pool.execute(
          `UPDATE message_chaungthai
              SET msg_read_at = CURRENT_TIMESTAMP
            WHERE msg_conv_id = ?
              AND msg_sender_id <> ?
              AND msg_read_at IS NULL`,
          [convId, socket.user_id]
        );
        if (r.affectedRows > 0) {
          const otherUserId =
            c[0].conv_user1_id === socket.user_id
              ? c[0].conv_user2_id
              : c[0].conv_user1_id;
          io.to(`user:${otherUserId}`).emit('chat:read', {
            conv_id: convId,
            by_user_id: socket.user_id,
            read_at: new Date().toISOString(),
          });
        }
      } catch (err) {
        console.error('[socket][chat:read]', err.message);
      }
    });

    socket.on('disconnect', (reason) => {
      // (ไม่จำเป็นต้องทำอะไร — leave room อัตโนมัติ)
      // console.log(`[socket] user ${socket.user_id} disconnect: ${reason}`);
    });
  });

  console.log('[socket] Socket.io listening at path /api/socket.io');
  return io;
}

function getIO() {
  if (!io) throw new Error('socket.io ยังไม่ถูก initialize');
  return io;
}

module.exports = { initSocket, getIO };
