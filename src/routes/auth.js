const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');

const config = require('../config');
const db = require('../db');
const { errors, asyncHandler } = require('../utils/http');
const { signAccessToken, signRefreshToken, verifyRefreshToken, sha256 } = require('../utils/tokens');
const { requireAuth } = require('../middleware/auth');
const validate = require('../middleware/validate');

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

module.exports = router;
