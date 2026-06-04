// ============================================================
//  Skills Routes
//  Mounted at: /api/skills
//
//  GET /api/skills  - ดึงหมวด + สาขา + สกิล รวมเป็น tree (สาธารณะ)
// ============================================================

const express = require('express');
const pool = require('../db');

const router = express.Router();

// ============================================================
//  GET /api/skills
//  คืน tree: หมวด -> สาขา -> สกิล
//  - ดึงเฉพาะ is_active = 1
//  - 3 query แยก + group ใน Node (memory น้อยกว่า JOIN ที่มี dup rows)
// ============================================================
router.get('/', async (req, res) => {
  try {
    // ----- 1. ดึง categories (active) -----
    const [categories] = await pool.query(
      `SELECT
         skill_category_id,
         skill_category_name_th,
         skill_category_name_en
       FROM skill_category_chaungthai
       WHERE skill_category_is_active = 1
       ORDER BY skill_category_id`
    );

    // ----- 2. ดึง subcategories (active) -----
    const [subcategories] = await pool.query(
      `SELECT
         skill_subcategory_id,
         skill_subcategory_category_id,
         skill_subcategory_name_th,
         skill_subcategory_name_en
       FROM skill_subcategory_chaungthai
       WHERE skill_subcategory_is_active = 1
       ORDER BY skill_subcategory_category_id, skill_subcategory_id`
    );

    // ----- 3. ดึง skills (active) -----
    const [skills] = await pool.query(
      `SELECT
         skill_id,
         skill_subcategory_id,
         skill_name_th,
         skill_name_en
       FROM skill_chaungthai
       WHERE skill_is_active = 1
       ORDER BY skill_subcategory_id, skill_id`
    );

    // ----- 4. Group skills โดยใช้ subcategory_id เป็น key -----
    const skillsBySubcat = {};
    for (const s of skills) {
      const k = s.skill_subcategory_id;
      if (!skillsBySubcat[k]) skillsBySubcat[k] = [];
      skillsBySubcat[k].push({
        skill_id: s.skill_id,
        skill_name_th: s.skill_name_th,
        skill_name_en: s.skill_name_en,
      });
    }

    // ----- 5. Group subcategories โดยใช้ category_id เป็น key -----
    //         พร้อมแนบ skills เข้าไป
    const subcatsByCat = {};
    for (const sub of subcategories) {
      const k = sub.skill_subcategory_category_id;
      if (!subcatsByCat[k]) subcatsByCat[k] = [];
      subcatsByCat[k].push({
        skill_subcategory_id: sub.skill_subcategory_id,
        skill_subcategory_name_th: sub.skill_subcategory_name_th,
        skill_subcategory_name_en: sub.skill_subcategory_name_en,
        skills: skillsBySubcat[sub.skill_subcategory_id] || [],
      });
    }

    // ----- 6. ประกอบ tree สุดท้าย -----
    const tree = categories.map((c) => ({
      skill_category_id: c.skill_category_id,
      skill_category_name_th: c.skill_category_name_th,
      skill_category_name_en: c.skill_category_name_en,
      subcategories: subcatsByCat[c.skill_category_id] || [],
    }));

    return res.json({
      total_categories: tree.length,
      total_subcategories: subcategories.length,
      total_skills: skills.length,
      categories: tree,
    });

  } catch (err) {
    console.error('[skills] error:', err);
    return res.status(500).json({
      error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

module.exports = router;
