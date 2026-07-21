// ============================================================
//  Auth Middleware
//  ใช้ verifyToken เป็นด่านตรวจ JWT ก่อนเข้าถึง endpoint ที่ต้อง login
// ============================================================

const jwt = require('jsonwebtoken');

/**
 * Middleware: ตรวจ JWT ใน header
 *   Authorization: Bearer eyJhbGciOi...
 *
 * - ผ่าน: ใส่ req.user = { user_id, user_email, user_role, iat, exp }
 * - ไม่ผ่าน: 401 พร้อมเหตุผล
 */
function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return res.status(401).json({
      error: 'กรุณาแนบ token ใน header (Authorization: Bearer ...)',
    });
  }

  const token = match[1];

  if (!process.env.JWT_SECRET) {
    console.error('[verifyToken] JWT_SECRET not set');
    return res.status(500).json({ error: 'Server config error' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token หมดอายุ กรุณา login ใหม่' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Token ไม่ถูกต้อง' });
    }
    return res.status(401).json({ error: 'ตรวจสอบ token ไม่ผ่าน' });
  }
}

/**
 * Middleware factory: จำกัดว่า endpoint นี้ใช้ได้เฉพาะบัญชีฝั่งไหน
 *
 * ช่างกับผู้ว่าจ้างเป็นคนละบัญชีกันสมบูรณ์ (migration 12)
 * ใช้ต่อจาก verifyToken เสมอ เช่น:
 *   router.post('/', verifyToken, requireAccountType('worker'), handler)
 *
 * token เก่าที่ออกก่อน migration 12 ไม่มี user_account_type → ถือเป็น employer
 */
function requireAccountType(type) {
  const LABEL = { employer: 'ผู้ว่าจ้าง', worker: 'ช่าง' };
  return function (req, res, next) {
    const mine = (req.user && req.user.user_account_type) || 'employer';
    if (mine !== type) {
      return res.status(403).json({
        error: `ต้องใช้บัญชี${LABEL[type]}เท่านั้น — ตอนนี้คุณอยู่ในบัญชี${LABEL[mine] || mine}`,
        required_account_type: type,
        current_account_type: mine,
      });
    }
    return next();
  };
}

module.exports = { verifyToken, requireAccountType };
