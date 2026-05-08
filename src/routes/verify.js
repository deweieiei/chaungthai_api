/**
 * verify.js — OTP verify สำหรับ email และ phone
 *
 * POST /api/verify/email/send      — ส่ง OTP ไปที่ email ของ user
 * POST /api/verify/email/confirm   — ยืนยัน OTP → set email_verified_at
 * POST /api/verify/phone/send      — ส่ง OTP SMS ไปที่เบอร์ของ user
 * POST /api/verify/phone/confirm   — ยืนยัน OTP → set phone_verified_at
 */

const express    = require('express');
const rateLimit  = require('express-rate-limit');
const { z }      = require('zod');
const db         = require('../db');
const { errors, asyncHandler } = require('../utils/http');
const { requireAuth }          = require('../middleware/auth');
const { sha256, randomCode }   = require('../utils/tokens');
const { sendMail, otpEmailHtml } = require('../utils/mailer');
const { sendSMS }              = require('../utils/sms');
const validate                 = require('../middleware/validate');

const router = express.Router();

// OTP settings
const OTP_EXPIRES_MIN = 10;      // หมดอายุใน 10 นาที
const OTP_MAX_ATTEMPTS = 5;      // กรอกผิดได้สูงสุด 5 ครั้ง
const OTP_RESEND_WAIT_SEC = 60;  // รอ 60 วินาทีก่อนส่งใหม่

// Rate limit: ส่ง OTP ได้สูงสุด 5 ครั้ง/ชั่วโมง ต่อ IP
const otpSendLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    keyGenerator: (req) => `${req.ip}-${req.user?.id}`,
    message: { ok: false, error: { code: 'too_many_requests', message: 'ส่ง OTP บ่อยเกินไป กรุณารอ 1 ชั่วโมง' } },
});

// ── Helper: สร้างและบันทึก OTP ────────────────────────────────────────────
async function createOTP(userId, target, purpose) {
    // เช็คว่า OTP ล่าสุดส่งไปยังไม่ครบ 60 วินาที (กัน spam)
    const recent = await db.queryOne(
        `SELECT created_at FROM otp_codes
          WHERE user_id = :uid AND purpose = :p AND used_at IS NULL
            AND created_at > (NOW() - INTERVAL :sec SECOND)
          ORDER BY created_at DESC LIMIT 1`,
        { uid: userId, p: purpose, sec: OTP_RESEND_WAIT_SEC }
    );
    if (recent) {
        throw errors.tooMany('otp_too_soon', `กรุณารอ ${OTP_RESEND_WAIT_SEC} วินาทีก่อนส่งใหม่`);
    }

    // Invalidate OTP เก่า (ยกเลิกทั้งหมดสำหรับ target+purpose นี้)
    await db.query(
        `UPDATE otp_codes SET used_at = NOW()
          WHERE user_id = :uid AND purpose = :p AND used_at IS NULL`,
        { uid: userId, p: purpose }
    );

    const code      = randomCode(6);
    const codeHash  = sha256(code);
    const expiresAt = new Date(Date.now() + OTP_EXPIRES_MIN * 60 * 1000);

    await db.query(
        `INSERT INTO otp_codes (user_id, target, code_hash, purpose, expires_at)
         VALUES (:uid, :target, :hash, :purpose, :exp)`,
        { uid: userId, target, hash: codeHash, purpose, exp: expiresAt }
    );

    return code;
}

// ── Helper: ตรวจสอบ OTP ──────────────────────────────────────────────────
async function verifyOTP(target, code, purpose) {
    const row = await db.queryOne(
        `SELECT * FROM otp_codes
          WHERE target = :target AND purpose = :p
            AND used_at IS NULL AND expires_at > NOW()
          ORDER BY created_at DESC LIMIT 1`,
        { target, p: purpose }
    );

    if (!row) throw errors.badRequest('otp_invalid', 'OTP ไม่ถูกต้องหรือหมดอายุแล้ว');

    if (row.attempts >= OTP_MAX_ATTEMPTS) {
        throw errors.badRequest('otp_too_many_attempts', 'กรอกรหัสผิดเกินกำหนด กรุณาขอ OTP ใหม่');
    }

    // เพิ่ม attempts ก่อนเช็ค (กัน timing attack)
    await db.query(
        `UPDATE otp_codes SET attempts = attempts + 1 WHERE id = :id`,
        { id: row.id }
    );

    if (sha256(code) !== row.code_hash) {
        const remaining = OTP_MAX_ATTEMPTS - (row.attempts + 1);
        throw errors.badRequest('otp_wrong', `รหัส OTP ไม่ถูกต้อง (เหลือ ${Math.max(0, remaining)} ครั้ง)`);
    }

    // Mark as used
    await db.query(`UPDATE otp_codes SET used_at = NOW() WHERE id = :id`, { id: row.id });
    return row;
}

// ═══════════════════════════════════════════════════════════════════
//  EMAIL VERIFY
// ═══════════════════════════════════════════════════════════════════

// POST /api/verify/email/send
router.post(
    '/email/send',
    requireAuth,
    otpSendLimiter,
    asyncHandler(async (req, res) => {
        const user = await db.queryOne('SELECT * FROM users WHERE id = :id', { id: req.user.id });
        if (!user) throw errors.notFound('user_not_found', 'ไม่พบผู้ใช้');
        if (user.email_verified_at) {
            return res.json({ ok: true, message: 'ยืนยันอีเมลแล้ว' });
        }

        const code = await createOTP(user.id, user.email, 'verify_email');

        await sendMail({
            to:      user.email,
            subject: `[ChaungThai] รหัส OTP ยืนยันอีเมล: ${code}`,
            html:    otpEmailHtml(code, 'verify_email', OTP_EXPIRES_MIN),
        });

        // Dev: log code ออก console เพื่อทดสอบง่าย
        if (process.env.NODE_ENV !== 'production') {
            console.log(`[verify] DEV OTP (email) for user ${user.id}: ${code}`);
        }

        res.json({ ok: true, message: `ส่ง OTP ไปที่ ${maskEmail(user.email)} แล้ว` });
    })
);

// POST /api/verify/email/confirm
const confirmEmailSchema = z.object({
    code: z.string().length(6).regex(/^\d{6}$/),
});

router.post(
    '/email/confirm',
    requireAuth,
    validate({ body: confirmEmailSchema }),
    asyncHandler(async (req, res) => {
        const user = await db.queryOne('SELECT * FROM users WHERE id = :id', { id: req.user.id });
        if (!user) throw errors.notFound('user_not_found', 'ไม่พบผู้ใช้');
        if (user.email_verified_at) {
            return res.json({ ok: true, message: 'ยืนยันอีเมลแล้ว' });
        }

        await verifyOTP(user.email, req.body.code, 'verify_email');

        await db.query(
            `UPDATE users SET email_verified_at = NOW(), updated_at = NOW() WHERE id = :id`,
            { id: user.id }
        );

        res.json({ ok: true, message: 'ยืนยันอีเมลสำเร็จ!' });
    })
);

// ═══════════════════════════════════════════════════════════════════
//  PHONE VERIFY
// ═══════════════════════════════════════════════════════════════════

// POST /api/verify/phone/send
router.post(
    '/phone/send',
    requireAuth,
    otpSendLimiter,
    asyncHandler(async (req, res) => {
        const user = await db.queryOne('SELECT * FROM users WHERE id = :id', { id: req.user.id });
        if (!user) throw errors.notFound('user_not_found', 'ไม่พบผู้ใช้');
        if (!user.phone) throw errors.badRequest('no_phone', 'บัญชีนี้ไม่มีเบอร์โทร');
        if (user.phone_verified_at) {
            return res.json({ ok: true, message: 'ยืนยันเบอร์โทรแล้ว' });
        }

        const code = await createOTP(user.id, user.phone, 'verify_phone');

        await sendSMS({
            to:   user.phone,
            body: `[ChaungThai] รหัส OTP ยืนยันเบอร์: ${code} (หมดอายุใน ${OTP_EXPIRES_MIN} นาที)`,
        });

        if (process.env.NODE_ENV !== 'production') {
            console.log(`[verify] DEV OTP (phone) for user ${user.id}: ${code}`);
        }

        res.json({ ok: true, message: `ส่ง OTP ไปที่ ${maskPhone(user.phone)} แล้ว` });
    })
);

// POST /api/verify/phone/confirm
const confirmPhoneSchema = z.object({
    code: z.string().length(6).regex(/^\d{6}$/),
});

router.post(
    '/phone/confirm',
    requireAuth,
    validate({ body: confirmPhoneSchema }),
    asyncHandler(async (req, res) => {
        const user = await db.queryOne('SELECT * FROM users WHERE id = :id', { id: req.user.id });
        if (!user) throw errors.notFound('user_not_found', 'ไม่พบผู้ใช้');
        if (!user.phone) throw errors.badRequest('no_phone', 'บัญชีนี้ไม่มีเบอร์โทร');
        if (user.phone_verified_at) {
            return res.json({ ok: true, message: 'ยืนยันเบอร์โทรแล้ว' });
        }

        await verifyOTP(user.phone, req.body.code, 'verify_phone');

        await db.query(
            `UPDATE users SET phone_verified_at = NOW(), updated_at = NOW() WHERE id = :id`,
            { id: user.id }
        );

        res.json({ ok: true, message: 'ยืนยันเบอร์โทรสำเร็จ!' });
    })
);

// ── Mask helpers ──────────────────────────────────────────────────────────
function maskEmail(email) {
    const [user, domain] = email.split('@');
    return user.slice(0, 2) + '***@' + domain;
}

function maskPhone(phone) {
    return phone.slice(0, 3) + '***' + phone.slice(-2);
}

module.exports = router;
