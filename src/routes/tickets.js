const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { errors, asyncHandler } = require('../utils/http');
const { requireAuth, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');

const router = express.Router();
router.use(requireAuth);

// GET /api/tickets  — balance + recent transactions
router.get('/', requireRole('worker'), asyncHandler(async (req, res) => {
  const uid = req.user.id;

  const wp = await db.queryOne(
    `SELECT tickets_balance, is_verified FROM worker_profiles WHERE user_id = :id`,
    { id: uid }
  );
  if (!wp) throw errors.notFound('profile_not_found', 'ไม่พบโปรไฟล์ช่าง');

  const transactions = await db.query(
    `SELECT id, type, amount, balance_after, reference_type, note, expires_at, created_at
     FROM ticket_transactions WHERE worker_id = :id
     ORDER BY created_at DESC LIMIT 30`,
    { id: uid }
  );

  res.json({
    ok: true,
    balance: wp.tickets_balance,
    isVerified: !!wp.is_verified,
    transactions,
  });
}));

// GET /api/tickets/packages
router.get('/packages', asyncHandler(async (_req, res) => {
  const pkgs = await db.query(
    `SELECT id, name, description, ticket_count, price, validity_days
     FROM ticket_packages WHERE is_active = 1 ORDER BY sort_order, price`,
  );
  res.json({ ok: true, data: pkgs });
}));

// GET /api/tickets/payments  — own payment history
router.get('/payments', asyncHandler(async (req, res) => {
  const payments = await db.query(
    `SELECT p.id, p.amount, p.currency, p.payment_method, p.status, p.paid_at, p.created_at,
            tp.name AS package_name, tp.ticket_count
     FROM payments p
     LEFT JOIN ticket_packages tp ON tp.id = p.package_id
     WHERE p.user_id = :uid
     ORDER BY p.created_at DESC LIMIT 50`,
    { uid: req.user.id }
  );
  res.json({ ok: true, data: payments });
}));

// POST /api/tickets/purchase  — initiate purchase
const purchaseSchema = z.object({
  packageId:     z.number().int().positive(),
  paymentMethod: z.enum(['promptpay', 'credit_card', 'bank_transfer', 'other']),
});

router.post(
  '/purchase',
  requireRole('worker'),
  validate({ body: purchaseSchema }),
  asyncHandler(async (req, res) => {
    const { packageId, paymentMethod } = req.body;

    const pkg = await db.queryOne(
      'SELECT * FROM ticket_packages WHERE id = :id AND is_active = 1',
      { id: packageId }
    );
    if (!pkg) throw errors.notFound('package_not_found', 'ไม่พบแพ็คเกจนี้');

    const [r] = await db.pool.execute(
      `INSERT INTO payments (user_id, package_id, amount, payment_method, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [req.user.id, packageId, pkg.price, paymentMethod]
    );
    const paymentId = r.insertId;

    // TODO: integrate payment gateway (Omise / 2C2P) here
    // For now: simulate success immediately (sandbox mode)
    if (process.env.NODE_ENV !== 'production') {
      await _completePurchase(paymentId, req.user.id, pkg);
      return res.status(201).json({
        ok: true,
        message: `[DEV] ซื้อตั๋ว ${pkg.ticket_count} ใบสำเร็จ (sandbox)`,
        paymentId,
        ticketsAdded: pkg.ticket_count,
      });
    }

    // Production: return payment_id for gateway redirect
    res.status(201).json({
      ok: true,
      paymentId,
      amount: pkg.price,
      message: 'สร้างรายการชำระเงินแล้ว กรุณาชำระผ่าน gateway',
    });
  })
);

// POST /api/tickets/webhook  — payment gateway callback
const webhookSchema = z.object({
  paymentId: z.number().int().positive(),
  status:    z.enum(['completed', 'failed']),
  gatewayRef: z.string().max(255).optional(),
});

router.post(
  '/webhook',
  validate({ body: webhookSchema }),
  asyncHandler(async (req, res) => {
    const { paymentId, status, gatewayRef } = req.body;

    const payment = await db.queryOne(
      'SELECT * FROM payments WHERE id = :id AND status = \'pending\'',
      { id: paymentId }
    );
    if (!payment) return res.json({ ok: true }); // idempotent

    if (status === 'completed') {
      await db.query(
        `UPDATE payments SET status = 'completed', gateway_ref = :ref, paid_at = NOW(), updated_at = NOW()
         WHERE id = :id`,
        { id: paymentId, ref: gatewayRef || null }
      );
      const pkg = await db.queryOne('SELECT * FROM ticket_packages WHERE id = :id', { id: payment.package_id });
      if (pkg) await _completePurchase(paymentId, payment.user_id, pkg);
    } else {
      await db.query(
        `UPDATE payments SET status = 'failed', updated_at = NOW() WHERE id = :id`,
        { id: paymentId }
      );
    }

    res.json({ ok: true });
  })
);

async function _completePurchase(paymentId, userId, pkg) {
  const expiresAt = new Date(Date.now() + pkg.validity_days * 86400000);

  await db.withTransaction(async (conn) => {
    const [[wp]] = await conn.execute(
      'SELECT tickets_balance FROM worker_profiles WHERE user_id = ?', [userId]
    );
    const newBalance = (wp?.tickets_balance || 0) + pkg.ticket_count;

    await conn.execute(
      'UPDATE worker_profiles SET tickets_balance = ?, updated_at = NOW() WHERE user_id = ?',
      [newBalance, userId]
    );
    await conn.execute(
      `INSERT INTO ticket_transactions
         (worker_id, type, amount, balance_after, reference_id, reference_type, note, expires_at)
       VALUES (?, 'purchase_add', ?, ?, ?, 'payment', ?, ?)`,
      [userId, pkg.ticket_count, newBalance, paymentId, `ซื้อแพ็ค: ${pkg.name}`, expiresAt]
    );
    await conn.execute(
      `UPDATE payments SET status = 'completed', paid_at = NOW() WHERE id = ?`, [paymentId]
    );
    await conn.execute(
      `INSERT INTO notifications (user_id, type, title, body, data) VALUES (?, 'ticket_purchase', ?, ?, ?)`,
      [userId, `ได้รับ ${pkg.ticket_count} ตั๋วแล้ว!`,
       `ซื้อ ${pkg.name} สำเร็จ ยอดตั๋วรวม ${newBalance} ใบ`,
       JSON.stringify({ payment_id: paymentId, tickets_added: pkg.ticket_count })]
    );
  });
}

module.exports = router;
