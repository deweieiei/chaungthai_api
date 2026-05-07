const express = require('express');
const db = require('../db');
const { asyncHandler } = require('../utils/http');

const router = express.Router();

router.get('/', (_req, res) => {
    res.json({ ok: true, service: 'chaungthai-api', uptime: process.uptime() });
});

router.get('/db', asyncHandler(async (_req, res) => {
    const row = await db.queryOne('SELECT VERSION() AS version, NOW() AS now');
    res.json({ ok: true, db: row });
}));

module.exports = router;
