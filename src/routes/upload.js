/**
 * upload.js — อัพโหลดรูปภาพและไฟล์
 *
 * POST /api/upload/image   — อัพโหลดรูป (chat, avatar, verify_id)
 *   Body  : multipart/form-data, field "file" + optional "purpose"
 *   Return: { ok:true, url:"/uploads/<filename>", fileId }
 *
 * Storage:
 *   Dev        : เซฟใน /uploads/<purpose>/<uuid>.<ext> บน disk
 *   Production : เปลี่ยน storage engine เป็น S3/GCS ใน uploadStorage object
 *
 * Limits:
 *   - max size : 5 MB
 *   - allowed  : image/jpeg, image/png, image/webp, image/gif
 */

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const crypto   = require('crypto');
const fs       = require('fs');
const db       = require('../db');
const { errors, asyncHandler } = require('../utils/http');
const { requireAuth }          = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ── Config ─────────────────────────────────────────────────────────────────
const UPLOADS_DIR    = path.join(process.cwd(), 'uploads');
const MAX_SIZE_BYTES = 5 * 1024 * 1024;   // 5 MB
const ALLOWED_MIME   = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const ALLOWED_EXT    = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const VALID_PURPOSES = new Set(['chat', 'avatar', 'verify_id', 'other']);

// ── Multer: disk storage ───────────────────────────────────────────────────
const storage = multer.diskStorage({
    destination(req, _file, cb) {
        const purpose = req.query.purpose || 'other';
        const dir = path.join(UPLOADS_DIR, purpose);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename(_req, file, cb) {
        const ext  = path.extname(file.originalname).toLowerCase();
        const uuid = crypto.randomBytes(16).toString('hex');
        cb(null, `${uuid}${ext}`);
    },
});

function fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_MIME.has(file.mimetype) || !ALLOWED_EXT.has(ext)) {
        return cb(new Error('INVALID_TYPE'), false);
    }
    cb(null, true);
}

const upload = multer({
    storage,
    limits: { fileSize: MAX_SIZE_BYTES },
    fileFilter,
});

// ── POST /api/upload/image ─────────────────────────────────────────────────
router.post(
    '/image',
    (req, res, next) => {
        upload.single('file')(req, res, (err) => {
            if (err instanceof multer.MulterError) {
                if (err.code === 'LIMIT_FILE_SIZE') {
                    return res.status(400).json({ ok: false, error: { code: 'file_too_large', message: 'ไฟล์ใหญ่เกิน 5 MB' } });
                }
                return res.status(400).json({ ok: false, error: { code: 'upload_error', message: err.message } });
            }
            if (err?.message === 'INVALID_TYPE') {
                return res.status(400).json({ ok: false, error: { code: 'invalid_type', message: 'อนุญาตเฉพาะ JPG, PNG, WebP, GIF' } });
            }
            if (err) return next(err);
            next();
        });
    },
    asyncHandler(async (req, res) => {
        if (!req.file) {
            throw errors.badRequest('no_file', 'กรุณาเลือกไฟล์ (field name: "file")');
        }

        const purpose = VALID_PURPOSES.has(req.query.purpose) ? req.query.purpose : 'other';
        const url     = `/uploads/${purpose}/${req.file.filename}`;

        // บันทึก record ใน DB สำหรับ tracking / cleanup
        const [r] = await db.pool.execute(
            `INSERT INTO file_uploads (user_id, filename, original_name, mime_type, size_bytes, purpose, url)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [req.user.id, req.file.filename, req.file.originalname,
             req.file.mimetype, req.file.size, purpose, url]
        );

        res.status(201).json({
            ok:       true,
            url,
            fileId:   r.insertId,
            filename: req.file.filename,
            size:     req.file.size,
            mimeType: req.file.mimetype,
        });
    })
);

// ── DELETE /api/upload/:fileId — ลบไฟล์ของตัวเอง ─────────────────────────
router.delete(
    '/:fileId',
    asyncHandler(async (req, res) => {
        const fileId = parseInt(req.params.fileId, 10);
        const row = await db.queryOne(
            'SELECT * FROM file_uploads WHERE id = :id AND user_id = :uid',
            { id: fileId, uid: req.user.id }
        );
        if (!row) throw errors.notFound('file_not_found', 'ไม่พบไฟล์');

        // ลบไฟล์จาก disk
        const filePath = path.join(UPLOADS_DIR, row.purpose, row.filename);
        try { fs.unlinkSync(filePath); } catch { /* ignore if already gone */ }

        await db.query('DELETE FROM file_uploads WHERE id = :id', { id: fileId });
        res.json({ ok: true, message: 'ลบไฟล์แล้ว' });
    })
);

module.exports = router;
