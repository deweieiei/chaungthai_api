/**
 * reports.js — รายงานผู้ใช้ที่มีปัญหา
 *
 * POST /api/reports          — ส่งรายงาน
 * GET  /api/reports/my       — ดูรายงานที่เราเคยส่ง
 */

const express  = require('express');
const { z }    = require('zod');
const rateLimit = require('express-rate-limit');
const db       = require('../db');
const { errors, asyncHandler } = require('../utils/http');
const { requireAuth }          = require('../middleware/auth');
const validate                 = require('../middleware/validate');

const router = express.Router();
router.use(requireAuth);

// Rate limit: report ได้ 10 ครั้ง/ชั่วโมง (กัน spam report)
const reportLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: { ok: false, error: { code: 'too_many_requests', message: 'ส่งรายงานบ่อยเกินไป กรุณารอ 1 ชั่วโมง' } },
});

// เหตุผลที่รายงานได้
const REPORT_REASONS = [
    'spam',             // สแปม
    'fake_profile',     // โปรไฟล์ปลอม
    'inappropriate',    // เนื้อหาไม่เหมาะสม
    'fraud',            // หลอกลวง / โกง
    'harassment',       // ก่อกวน / คุกคาม
    'other',            // อื่นๆ
];

// ── POST /api/reports ─────────────────────────────────────────────────────
const createReportSchema = z.object({
    targetType:   z.enum(['user', 'job', 'match', 'message']),
    targetId:     z.number().int().positive(),
    reason:       z.enum(['spam', 'fake_profile', 'inappropriate', 'fraud', 'harassment', 'other']),
    description:  z.string().trim().min(10).max(1000).optional(),
});

router.post(
    '/',
    reportLimiter,
    validate({ body: createReportSchema }),
    asyncHandler(async (req, res) => {
        const { targetType, targetId, reason, description } = req.body;
        const reporterId = req.user.id;

        // ── ดึง targetUserId ตามประเภท ──────────────────────────────
        let targetUserId = null;
        switch (targetType) {
            case 'user':
                targetUserId = targetId;
                if (targetUserId === reporterId) {
                    throw errors.badRequest('cannot_report_self', 'ไม่สามารถรายงานตัวเองได้');
                }
                // ตรวจว่า user มีอยู่จริง
                const u = await db.queryOne('SELECT id FROM users WHERE id = :id', { id: targetUserId });
                if (!u) throw errors.notFound('user_not_found', 'ไม่พบผู้ใช้');
                break;

            case 'job':
                const j = await db.queryOne('SELECT customer_id FROM jobs WHERE id = :id', { id: targetId });
                if (!j) throw errors.notFound('job_not_found', 'ไม่พบงาน');
                targetUserId = j.customer_id;
                break;

            case 'match':
                const m = await db.queryOne(
                    'SELECT customer_id, worker_id FROM job_matches WHERE id = :id AND (customer_id = :uid OR worker_id = :uid)',
                    { id: targetId, uid: reporterId }
                );
                if (!m) throw errors.notFound('match_not_found', 'ไม่พบงาน');
                targetUserId = m.customer_id === reporterId ? m.worker_id : m.customer_id;
                break;

            case 'message':
                const msg = await db.queryOne('SELECT sender_id FROM chat_messages WHERE id = :id', { id: targetId });
                if (!msg) throw errors.notFound('message_not_found', 'ไม่พบข้อความ');
                targetUserId = msg.sender_id;
                break;
        }

        // เช็คว่า report ซ้ำในช่วง 24 ชม. (targetType + targetId เดิม)
        const existing = await db.queryOne(
            `SELECT id FROM reports
              WHERE reporter_id = :rid AND target_type = :tt AND target_id = :tid
                AND created_at > (NOW() - INTERVAL 24 HOUR)`,
            { rid: reporterId, tt: targetType, tid: targetId }
        );
        if (existing) {
            throw errors.conflict('already_reported', 'คุณรายงานรายการนี้แล้ว (ภายใน 24 ชั่วโมง)');
        }

        const [r] = await db.pool.execute(
            `INSERT INTO reports (reporter_id, target_user_id, target_type, target_id, reason, description)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [reporterId, targetUserId, targetType, targetId, reason, description || null]
        );

        res.status(201).json({
            ok: true,
            message: 'รับรายงานของคุณแล้ว ทีมงานจะตรวจสอบโดยเร็ว',
            reportId: r.insertId,
        });
    })
);

// ── GET /api/reports/my — รายงานที่เราเคยส่ง ─────────────────────────────
router.get(
    '/my',
    asyncHandler(async (req, res) => {
        const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(30, parseInt(req.query.limit, 10) || 10);

        const reports = await db.query(
            `SELECT r.id, r.target_type, r.target_id, r.reason, r.description,
                    r.status, r.created_at,
                    u.first_name AS target_first_name, u.last_name AS target_last_name
             FROM reports r
             LEFT JOIN users u ON u.id = r.target_user_id
             WHERE r.reporter_id = :uid
             ORDER BY r.created_at DESC
             LIMIT :limit OFFSET :offset`,
            { uid: req.user.id, limit, offset: (page - 1) * limit }
        );

        res.json({ ok: true, data: reports, page, limit });
    })
);

module.exports = router;
