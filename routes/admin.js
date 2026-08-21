// routes/admin.js
const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/orders', requireAdmin, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  const itemsStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  res.json(orders.map((o) => ({ ...o, items: itemsStmt.all(o.id) })));
});

router.post('/orders/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body || {};
  const allowed = ['pending_payment', 'paid', 'preparing', 'ready', 'completed', 'cancelled', 'expired'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }

  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, req.params.id);
  res.json({ ok: true });
});

router.get('/menu', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM menu_items ORDER BY category, id').all());
});

router.post('/menu/:id/availability', requireAdmin, (req, res) => {
  const { isAvailable } = req.body || {};
  const item = db.prepare('SELECT id FROM menu_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Menu item not found' });

  db.prepare('UPDATE menu_items SET is_available = ? WHERE id = ?').run(isAvailable ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

module.exports = router;
