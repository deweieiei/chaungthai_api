/**
 * ws.js — WebSocket manager สำหรับ real-time chat + notifications
 *
 * Architecture:
 *   - Client เชื่อมต่อผ่าน ws://host/ws?token=<accessToken>
 *   - Server ตรวจ token ทันที → reject ถ้า invalid
 *   - เก็บ Map<userId, Set<WebSocket>> สำหรับ 1 user อาจมีหลาย device
 *   - broadcast(userId, payload)         → ส่งให้ user คนนั้นทุก device
 *   - broadcastMany([userId1, userId2], payload) → ส่งหลาย user พร้อมกัน
 *
 * Integration:
 *   - server.js    : ws.setup(httpServer)
 *   - chat.js      : ws.broadcastMany([senderId, receiverId], { type:'chat_message', ... })
 *   - notify.js    : ws.broadcast(userId, { type:'notification', ... })
 */

const { WebSocketServer } = require('ws');
const url = require('url');
const { verifyAccessToken } = require('./utils/tokens');

// userId (number) → Set<WebSocket>
const clients = new Map();

let wss = null;

// ── Setup ──────────────────────────────────────────────────────────────────
function setup(httpServer) {
    wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    wss.on('connection', (ws, req) => {
        // ── Auth: ดึง token จาก query string ──────────────────────────
        const query  = url.parse(req.url, true).query;
        const token  = query.token;
        let userId   = null;

        try {
            const payload = verifyAccessToken(token);
            userId = parseInt(payload.sub, 10);
        } catch {
            ws.close(4001, 'Unauthorized');
            return;
        }

        // ── ลงทะเบียน client ──────────────────────────────────────────
        if (!clients.has(userId)) clients.set(userId, new Set());
        clients.get(userId).add(ws);
        console.log(`[ws] user ${userId} connected (total sockets: ${countAll()})`);

        // ── ส่ง ack ──────────────────────────────────────────────────
        _send(ws, { type: 'connected', userId });

        // ── Heartbeat: client ส่ง ping → server ตอบ pong ─────────────
        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.type === 'ping') _send(ws, { type: 'pong' });
            } catch { /* ignore malformed */ }
        });

        // ── Cleanup เมื่อ disconnect ──────────────────────────────────
        ws.on('close', () => {
            const set = clients.get(userId);
            if (set) {
                set.delete(ws);
                if (set.size === 0) clients.delete(userId);
            }
            console.log(`[ws] user ${userId} disconnected (total sockets: ${countAll()})`);
        });

        ws.on('error', (err) => {
            console.error(`[ws] user ${userId} error:`, err.message);
        });
    });

    console.log('[ws] WebSocket server ready at /ws');
}

// ── broadcast helpers ──────────────────────────────────────────────────────

/** ส่ง payload ให้ user คนเดียว (ทุก device ที่ online) */
function broadcast(userId, payload) {
    const set = clients.get(userId);
    if (!set || set.size === 0) return;
    const data = JSON.stringify(payload);
    for (const ws of set) {
        if (ws.readyState === ws.OPEN) ws.send(data);
    }
}

/** ส่ง payload ให้หลาย user พร้อมกัน (เช่น ทั้ง 2 ฝ่ายในห้องแชท) */
function broadcastMany(userIds, payload) {
    const data = JSON.stringify(payload);
    for (const userId of userIds) {
        const set = clients.get(userId);
        if (!set) continue;
        for (const ws of set) {
            if (ws.readyState === ws.OPEN) ws.send(data);
        }
    }
}

/** จำนวน socket ทั้งหมดที่ online */
function countAll() {
    let n = 0;
    for (const set of clients.values()) n += set.size;
    return n;
}

function _send(ws, payload) {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

// ── Stats endpoint (สำหรับ /api/admin/ws-stats) ────────────────────────────
function stats() {
    return {
        connected_users:   clients.size,
        connected_sockets: countAll(),
    };
}

module.exports = { setup, broadcast, broadcastMany, stats };
