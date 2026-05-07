const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { asyncHandler } = require('../utils/http');
const validate = require('../middleware/validate');

const router = express.Router();

// GET /api/locations/provinces
router.get('/provinces', asyncHandler(async (_req, res) => {
  const rows = await db.query('SELECT id, name_th, name_en FROM provinces ORDER BY name_th');
  res.json({ ok: true, data: rows });
}));

// GET /api/locations/districts?provinceId=1
router.get('/districts', asyncHandler(async (req, res) => {
  const provinceId = parseInt(req.query.provinceId, 10) || null;
  const rows = await db.query(
    `SELECT id, province_id, name_th, name_en FROM districts
     ${provinceId ? 'WHERE province_id = :pid' : ''}
     ORDER BY name_th`,
    provinceId ? { pid: provinceId } : {}
  );
  res.json({ ok: true, data: rows });
}));

// GET /api/locations/subdistricts?districtId=1
router.get('/subdistricts', asyncHandler(async (req, res) => {
  const districtId = parseInt(req.query.districtId, 10) || null;
  const rows = await db.query(
    `SELECT id, district_id, name_th, name_en, postal_code FROM subdistricts
     ${districtId ? 'WHERE district_id = :did' : ''}
     ORDER BY name_th`,
    districtId ? { did: districtId } : {}
  );
  res.json({ ok: true, data: rows });
}));

module.exports = router;
