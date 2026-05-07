const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { asyncHandler } = require('../utils/http');
const validate = require('../middleware/validate');

const router = express.Router();

// GET /api/skills/categories
router.get('/categories', asyncHandler(async (_req, res) => {
  const cats = await db.query(
    `SELECT id, name_th, name_en, icon_url, sort_order
     FROM skill_categories WHERE is_active = 1 ORDER BY sort_order, id`
  );
  res.json({ ok: true, data: cats });
}));

// GET /api/skills?categoryId=1
const listSkillsSchema = z.object({
  categoryId: z.coerce.number().int().positive().optional(),
});

router.get(
  '/',
  validate({ query: listSkillsSchema }),
  asyncHandler(async (req, res) => {
    const { categoryId } = req.query;
    const skills = await db.query(
      `SELECT s.id, s.category_id, s.name_th, s.name_en, s.description,
              c.name_th AS category_name_th
       FROM skills s
       JOIN skill_categories c ON c.id = s.category_id
       WHERE s.is_active = 1
         ${categoryId ? 'AND s.category_id = :catId' : ''}
       ORDER BY s.sort_order, s.id`,
      categoryId ? { catId: categoryId } : {}
    );
    res.json({ ok: true, data: skills });
  })
);

module.exports = router;
