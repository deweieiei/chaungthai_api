const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');

const config = require('../config');
const db = require('../db');
const { errors, asyncHandler } = require('../utils/http');
const { signAccessToken, signRefreshToken, verifyRefreshToken, sha256, randomCode } = require('../utils/tokens');
const { requireAuth } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { sendMail, otpEmailHtml } = require('../utils/mailer');
const { sendSMS } = require('../utils/sms');

const router = express.Router();

// ---- Rate limits ----
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { ok: false, error: { code: 'too_many_requests', message: 'พยายามเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่' } },
    standardHeaders: true,
    legacyHeaders: false,
});

const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { ok: false, error: { code: 'too_many_requests', message: 'สมัครได้ไม่เกิน 5 ครั้งต่อชั่วโมง' } },
});

// ---- Schemas ----
const registerSchema = z.object({
    firstName:       z.string().trim().min(1).max(100),
    lastName:        z.string().trim().min(1).max(100),
    email:           z.string().trim().email().max(255).toLowerCase(),
    phone:           z.string().trim().regex(/^[0-9+\-\s]{8,20}$/, 'Invalid phone'),
    password:        z.string().min(8).max(100)
                       .regex(/[A-Za-z]/, 'รหัสผ่านต้องมีตัวอักษรอย่างน้อย 1 ตัว')
                       .regex(/[0-9]/,    'รหัสผ่านต้องมีตัวเลขอย่างน้อย 1 ตัว'),
    passwordConfirm: z.string(),
    role:            z.enum(['customer', 'worker']).default('customer'),
    acceptTerms:     z.preprocess(v => v === true || v === 'true' || v === 'on', z.boolean())
                       .refine(v => v === true, { message: 'ต้องยอมรับข้อกำหนด' }),
    newsletter:      z.preprocess(v => v === true || v === 'true' || v === 'on', z.boolean()).optional(),
}).refine(d => d.password === d.passwordConfirm, {
    message: 'รหัสผ่านไม่ตรงกัน',
    path: ['passwordConfirm'],
});

const loginSchema = z.object({
    identifier: z.string().trim().min(1),  // email or phone
    password:   z.string().min(1),
    remember:   z.preprocess(v => v === true || v === 'true' || v === 'on', z.boolean()).optional(),
});

const refreshSchema = z.object({
    refreshToken: z.string().min(10),
});

// ---- Helpers ----
function publicUser(u) {
    return {
        id: u.id,
        email: u.email,
        phone: u.phone,
        firstName: u.first_name,
        lastName: u.last_name,
        role: u.role,
        emailVerifiedAt: u.email_verified_at,
        phoneVerifiedAt: u.phone_verified_at,
        createdAt: u.created_at,
    };
}

async function issueTokens(user, req) {
    const access = signAccessToken({ sub: String(user.id), role: user.role });
    const refresh = signRefreshToken({ sub: String(user.id) });
    const expires = new Date(Date.now() + config.jwt.refreshTTLDays * 86400000);

    await db.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip, expires_at)
         VALUES (:userId, :hash, :ua, :ip, :exp)`,
        {
            userId: user.id,
            hash:   sha256(refresh),
            ua:     (req.headers['user-agent'] || '').slice(0, 255),
            ip:     req.ip,
            exp:    expires,
        }
    );

    return { accessToken: access, refreshToken: refresh, expiresIn: config.jwt.accessTTL };
}

async function logAudit(userId, action, req, metadata) {
    try {
        await db.query(
            `INSERT INTO audit_log (user_id, action, ip, user_agent, metadata)
             VALUES (:uid, :a, :ip, :ua, :meta)`,
            {
                uid:  userId,
                a:    action,
                ip:   req.ip,
                ua:   (req.headers['user-agent'] || '').slice(0, 255),
                meta: metadata ? JSON.stringify(metadata) : null,
            }
        );
    } catch (err) {
        console.error('[audit]', err.message);
    }
}

// ---- POST /api/auth/register ----
router.post(
    '/register',
    registerLimiter,
    validate({ body: registerSchema }),
    asyncHandler(async (req, res) => {
        const { firstName, lastName, email, phone, password, role, newsletter } = req.body;

        const exists = await db.queryOne(
            'SELECT id FROM users WHERE email = :email OR phone = :phone LIMIT 1',
            { email, phone }
        );
        if (exists) throw errors.conflict('user_exists', 'อีเมลหรือเบอร์นี้ถูกใช้แล้ว');

        const hash = await bcrypt.hash(password, config.bcryptRounds);

        const result = await db.withTransaction(async (conn) => {
            const [r] = await conn.execute(
                `INSERT INTO users (email, phone, password_hash, first_name, last_name, role, newsletter_opt_in)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [email, phone, hash, firstName, lastName, role, newsletter ? 1 : 0]
            );
            const newId = r.insertId;
            if (role === 'worker') {
                await conn.execute(
                    `INSERT INTO worker_profiles (user_id) VALUES (?)`,
                    [newId]
                );
            }
            return newId;
        });

        const user = await db.queryOne('SELECT * FROM users WHERE id = :id', { id: result });
        const tokens = await issueTokens(user, req);
        await logAudit(user.id, 'register', req, { role });

        res.status(201).json({ ok: true, user: publicUser(user), ...tokens });
    })
);

// ---- POST /api/auth/login ----
router.post(
    '/login',
    loginLimiter,
    validate({ body: loginSchema }),
    asyncHandler(async (req, res) => {
        const { identifier, password } = req.body;

        const user = await db.queryOne(
            `SELECT * FROM users WHERE email = :id OR phone = :id LIMIT 1`,
            { id: identifier.toLowerCase() }
        );
        if (!user || !user.is_active) {
            await logAudit(null, 'login_failed', req, { identifier, reason: 'no_user' });
            throw errors.unauthorized('invalid_credentials', 'อีเมล/เบอร์ หรือรหัสผ่านไม่ถูกต้อง');
        }

        // Account lockout — 5 failed attempts in 15 min => locked for 15 more
        const fails = await db.queryOne(
            `SELECT COUNT(*) AS c FROM audit_log
              WHERE user_id = :id AND action = 'login_failed'
                AND created_at > (NOW() - INTERVAL 15 MINUTE)`,
            { id: user.id }
        );
        if (fails.c >= 5) {
            throw errors.tooMany(
                'account_locked',
                'บัญชีถูกล็อกชั่วคราว เนื่องจากใส่รหัสผิดหลายครั้ง กรุณารอ 15 นาทีแล้วลองใหม่'
            );
        }

        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) {
            await logAudit(user.id, 'login_failed', req, { reason: 'wrong_password' });
            throw errors.unauthorized('invalid_credentials', 'อีเมล/เบอร์ หรือรหัสผ่านไม่ถูกต้อง');
        }

        await db.query('UPDATE users SET last_login_at = NOW() WHERE id = :id', { id: user.id });

        const tokens = await issueTokens(user, req);
        await logAudit(user.id, 'login_success', req);

        res.json({ ok: true, user: publicUser(user), ...tokens });
    })
);

// ---- POST /api/auth/refresh ----
router.post(
    '/refresh',
    validate({ body: refreshSchema }),
    asyncHandler(async (req, res) => {
        const { refreshToken } = req.body;

        let payload;
        try {
            payload = verifyRefreshToken(refreshToken);
        } catch {
            throw errors.unauthorized('invalid_refresh', 'Refresh token ไม่ถูกต้อง');
        }

        const hash = sha256(refreshToken);
        const stored = await db.queryOne(
            `SELECT * FROM refresh_tokens
              WHERE token_hash = :h AND revoked_at IS NULL AND expires_at > NOW()
              LIMIT 1`,
            { h: hash }
        );
        if (!stored) throw errors.unauthorized('invalid_refresh', 'Refresh token หมดอายุ');

        const user = await db.queryOne('SELECT * FROM users WHERE id = :id', { id: payload.sub });
        if (!user || !user.is_active) throw errors.unauthorized('user_inactive', 'บัญชีถูกระงับ');

        // Rotate: revoke old, issue new
        await db.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = :id', { id: stored.id });
        const tokens = await issueTokens(user, req);

        res.json({ ok: true, ...tokens });
    })
);

// ---- POST /api/auth/logout ----
router.post(
    '/logout',
    asyncHandler(async (req, res) => {
        const { refreshToken } = req.body || {};
        if (refreshToken) {
            await db.query(
                `UPDATE refresh_tokens SET revoked_at = NOW()
                  WHERE token_hash = :h AND revoked_at IS NULL`,
                { h: sha256(refreshToken) }
            );
        }
        res.json({ ok: true });
    })
);

// ---- GET /api/auth/me ----
router.get(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
        const user = await db.queryOne('SELECT * FROM users WHERE id = :id', { id: req.user.id });
        if (!user) throw errors.notFound('user_not_found', 'ไม่พบผู้ใช้');
        res.json({ ok: true, user: publicUser(user) });
    })
);

// ── Rate limit สำหรับ forgot password ────────────────────────────────────
const forgotLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { ok: false, error: { code: 'too_many_requests', message: 'ลองใหม่ใน 15 นาที' } },
});

const OTP_EXPIRES_MIN  = 10;
const OTP_MAX_ATTEMPTS = 5;

// ---- POST /api/auth/forgot-password ----
const forgotSchema = z.object({
    identifier: z.string().trim().min(5).max(255),   // email หรือ phone
});

router.post(
    '/forgot-password',
    forgotLimiter,
    validate({ body: forgotSchema }),
    asyncHandler(async (req, res) => {
        const { identifier } = req.body;
        const user = await db.queryOne(
            `SELECT id, email, phone FROM users WHERE (email = :id OR phone = :id) AND is_active = 1`,
            { id: identifier.toLowerCase() }
        );

        // ตอบ ok เสมอ → ไม่เผย user มีอยู่หรือไม่ (กัน enumeration)
        if (!user) {
            return res.json({ ok: true, message: 'ถ้าบัญชีนี้มีอยู่ คุณจะได้รับรหัส OTP เร็วๆ นี้' });
        }

        // Invalidate OTP เก่า
        await db.query(
            `UPDATE otp_codes SET used_at = NOW()
              WHERE user_id = :uid AND purpose = 'reset_password' AND used_at IS NULL`,
            { uid: user.id }
        );

        const code      = randomCode(6);
        const codeHash  = sha256(code);
        const expiresAt = new Date(Date.now() + OTP_EXPIRES_MIN * 60 * 1000);
        const target    = identifier.includes('@') ? user.email : user.phone;

        await db.query(
            `INSERT INTO otp_codes (user_id, target, code_hash, purpose, expires_at)
             VALUES (:uid, :target, :hash, 'reset_password', :exp)`,
            { uid: user.id, target, hash: codeHash, exp: expiresAt }
        );

        // ส่ง OTP ทาง Email หรือ SMS
        if (target === user.email) {
            await sendMail({
                to:      user.email,
                subject: `[ChaungThai] รหัส OTP รีเซ็ตรหัสผ่าน: ${code}`,
                html:    otpEmailHtml(code, 'reset_password', OTP_EXPIRES_MIN),
            });
        } else {
            await sendSMS({
                to:   user.phone,
                body: `[ChaungThai] รหัส OTP รีเซ็ตรหัสผ่าน: ${code} (${OTP_EXPIRES_MIN} นาที)`,
            });
        }

        if (process.env.NODE_ENV !== 'production') {
            console.log(`[auth] DEV forgot-password OTP for user ${user.id}: ${code}`);
        }

        await logAudit(user.id, 'forgot_password_request', req, { target });
        res.json({ ok: true, message: 'ถ้าบัญชีนี้มีอยู่ คุณจะได้รับรหัส OTP เร็วๆ นี้' });
    })
);

// ---- POST /api/auth/reset-password ----
const resetSchema = z.object({
    identifier:  z.string().trim().min(5).max(255),
    code:        z.string().length(6).regex(/^\d{6}$/),
    newPassword: z.string().min(8).max(100)
                   .regex(/[A-Za-z]/, 'ต้องมีตัวอักษร')
                   .regex(/[0-9]/,    'ต้องมีตัวเลข'),
});

router.post(
    '/reset-password',
    validate({ body: resetSchema }),
    asyncHandler(async (req, res) => {
        const { identifier, code, newPassword } = req.body;

        const user = await db.queryOne(
            `SELECT id, email, phone FROM users WHERE (email = :id OR phone = :id) AND is_active = 1`,
            { id: identifier.toLowerCase() }
        );
        if (!user) throw errors.badRequest('invalid_otp', 'รหัส OTP ไม่ถูกต้องหรือหมดอายุ');

        const target = identifier.includes('@') ? user.email : user.phone;

        // หา OTP ที่ยังใช้ได้
        const otpRow = await db.queryOne(
            `SELECT * FROM otp_codes
              WHERE user_id = :uid AND target = :target
                AND purpose = 'reset_password'
                AND used_at IS NULL AND expires_at > NOW()
              ORDER BY created_at DESC LIMIT 1`,
            { uid: user.id, target }
        );
        if (!otpRow) throw errors.badRequest('invalid_otp', 'รหัส OTP ไม่ถูกต้องหรือหมดอายุ');

        if (otpRow.attempts >= OTP_MAX_ATTEMPTS) {
            throw errors.badRequest('otp_too_many_attempts', 'กรอกรหัสผิดเกินกำหนด กรุณาขอ OTP ใหม่');
        }

        await db.query(
            `UPDATE otp_codes SET attempts = attempts + 1 WHERE id = :id`,
            { id: otpRow.id }
        );

        if (sha256(code) !== otpRow.code_hash) {
            const rem = OTP_MAX_ATTEMPTS - (otpRow.attempts + 1);
            throw errors.badRequest('invalid_otp', `OTP ไม่ถูกต้อง (เหลือ ${Math.max(0, rem)} ครั้ง)`);
        }

        // OTP ถูก → mark used + เปลี่ยนรหัสผ่าน + revoke tokens
        const newHash = await bcrypt.hash(newPassword, config.bcryptRounds);
        await db.withTransaction(async (conn) => {
            await conn.execute(`UPDATE otp_codes SET used_at = NOW() WHERE id = ?`, [otpRow.id]);
            await conn.execute(`UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?`, [newHash, user.id]);
            await conn.execute(
                `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL`,
                [user.id]
            );
        });

        await logAudit(user.id, 'reset_password_success', req);
        res.json({ ok: true, message: 'รีเซ็ตรหัสผ่านสำเร็จ กรุณาเข้าสู่ระบบใหม่' });
    })
);

module.exports = router;
