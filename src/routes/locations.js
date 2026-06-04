// ============================================================
//  Locations Routes (Thai administrative areas)
//  Mounted at: /api/locations
//
//  GET /api/locations/provinces                          - 77 จังหวัด
//  GET /api/locations/districts?province_id=X            - อำเภอ (filter)
//  GET /api/locations/subdistricts?district_id=X         - ตำบล (filter)
// ============================================================

const express = require('express');
const pool = require('../db');

const router = express.Router();

// ============================================================
//  GET /api/locations/provinces
// ============================================================
router.get('/provinces', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT province_id, province_name_th, province_name_en
       FROM location_province_chaungthai
       ORDER BY province_id`
    );
    return res.json({ total: rows.length, provinces: rows });
  } catch (err) {
    console.error('[locations/provinces] error:', err);
    return res.status(500).json({
      error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

// ============================================================
//  GET /api/locations/districts?province_id=X
//  - ถ้าไม่ส่ง province_id -> return ทั้งหมด (~930)
// ============================================================
router.get('/districts', async (req, res) => {
  try {
    const provinceId = req.query.province_id;
    let sql = `SELECT district_id, district_province_id, district_name_th, district_name_en
               FROM location_district_chaungthai`;
    const params = [];

    if (provinceId !== undefined && provinceId !== '') {
      const pid = Number(provinceId);
      if (!Number.isInteger(pid) || pid < 1) {
        return res.status(400).json({ error: 'province_id ต้องเป็นจำนวนเต็มบวก' });
      }
      sql += ' WHERE district_province_id = ?';
      params.push(pid);
    }
    sql += ' ORDER BY district_id';

    const [rows] = await pool.execute(sql, params);
    return res.json({ total: rows.length, districts: rows });
  } catch (err) {
    console.error('[locations/districts] error:', err);
    return res.status(500).json({
      error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

// ============================================================
//  GET /api/locations/subdistricts?district_id=X
//  - ถ้าไม่ส่ง district_id -> return ทั้งหมด (~7452 - response ใหญ่!)
// ============================================================
router.get('/subdistricts', async (req, res) => {
  try {
    const districtId = req.query.district_id;
    let sql = `SELECT subdistrict_id, subdistrict_district_id,
                      subdistrict_name_th, subdistrict_name_en, subdistrict_zip_code
               FROM location_subdistrict_chaungthai`;
    const params = [];

    if (districtId !== undefined && districtId !== '') {
      const did = Number(districtId);
      if (!Number.isInteger(did) || did < 1) {
        return res.status(400).json({ error: 'district_id ต้องเป็นจำนวนเต็มบวก' });
      }
      sql += ' WHERE subdistrict_district_id = ?';
      params.push(did);
    }
    sql += ' ORDER BY subdistrict_id';

    const [rows] = await pool.execute(sql, params);
    return res.json({ total: rows.length, subdistricts: rows });
  } catch (err) {
    console.error('[locations/subdistricts] error:', err);
    return res.status(500).json({
      error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

module.exports = router;
