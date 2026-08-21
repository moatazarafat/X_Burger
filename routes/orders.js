// routes/orders.js
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const fawry = require('../services/fawry');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const TAX_RATE = 0.14;
const DEFAULT_DELIVERY_FEE = 25;

function generateMerchantRefNum() {
  // Digits-only and unique enough for a single restaurant's order volume.
  return `${Date.now()}${crypto.randomInt(100, 999)}`;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Builds FawryPay's chargeItems array from the cart, plus delivery fee and
// tax as their own line items — so the sum of chargeItems always matches
// the total amount being charged.
function buildChargeItems(items, deliveryFee, tax) {
  const chargeItems = items.map((item) => ({
    itemId: String(item.menu_item_id ?? item.name),
    description: item.name,
    price: fawry.money(item.unit_price),
    quantity: item.qty,
  }));
  if (deliveryFee > 0) {
    chargeItems.push({ itemId: 'delivery-fee', description: 'Delivery fee', price: fawry.money(deliveryFee), quantity: 1 });
  }
  if (tax > 0) {
    chargeItems.push({ itemId: 'tax', description: 'Tax (14%)', price: fawry.money(tax), quantity: 1 });
  }
  return chargeItems;
}

/**
 * Shared checkout logic used by both the guest checkout endpoint and the
 * authenticated one. Never trusts prices sent from the browser — every
 * line is re-priced against the real menu_items table.
 */
async function checkout({ userId, customer, cartItems, deliveryFee = DEFAULT_DELIVERY_FEE }) {
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    const err = new Error('Cart is empty');
    err.status = 400;
    throw err;
  }
  if (!customer || !customer.name || !customer.mobile) {
    const err = new Error('Customer name and mobile number are required');
    err.status = 400;
    throw err;
  }

  const priced = cartItems.map((ci) => {
    const menuItem = ci.menu_item_id
      ? db.prepare('SELECT * FROM menu_items WHERE id = ?').get(ci.menu_item_id)
      : db.prepare('SELECT * FROM menu_items WHERE name = ?').get(ci.name);

    if (!menuItem || !menuItem.is_available) {
      const err = new Error(`"${ci.name}" is not available right now`);
      err.status = 400;
      throw err;
    }
    const qty = Math.max(1, parseInt(ci.qty, 10) || 1);
    return { menu_item_id: menuItem.id, name: menuItem.name, unit_price: menuItem.price, qty };
  });

  const subtotal = round2(priced.reduce((sum, i) => sum + i.unit_price * i.qty, 0));
  const tax = round2(subtotal * TAX_RATE);
  const total = round2(subtotal + deliveryFee + tax);
  const merchantRefNum = generateMerchantRefNum();
  const customerEmail = customer.email || `${customer.mobile.replace(/\D/g, '')}@xburger-guest.com`;

  const createOrder = db.transaction(() => {
    const insertOrder = db.prepare(`
      INSERT INTO orders
        (user_id, customer_name, customer_mobile, customer_email, status, payment_method, merchant_ref_num, subtotal, delivery_fee, tax, total)
      VALUES (?, ?, ?, ?, 'pending_payment', 'PayAtFawry', ?, ?, ?, ?, ?)
    `);
    const result = insertOrder.run(
      userId || null,
      customer.name,
      customer.mobile,
      customerEmail,
      merchantRefNum,
      subtotal,
      deliveryFee,
      tax,
      total
    );
    const orderId = result.lastInsertRowid;

    const insertItem = db.prepare(
      'INSERT INTO order_items (order_id, menu_item_id, name, unit_price, qty) VALUES (?, ?, ?, ?, ?)'
    );
    for (const item of priced) {
      insertItem.run(orderId, item.menu_item_id, item.name, item.unit_price, item.qty);
    }
    return orderId;
  });

  const orderId = createOrder();

  const paymentExpiry = Date.now() + 48 * 60 * 60 * 1000; // 48h to pay at any Fawry outlet
  const webhookBase = process.env.PUBLIC_BASE_URL; // e.g. https://xburger-backend.onrender.com
  const orderWebHookUrl = webhookBase ? `${webhookBase.replace(/\/$/, '')}/api/orders/fawry-webhook` : undefined;

  try {
    const charge = await fawry.createPayAtFawryCharge({
      merchantRefNum,
      customerName: customer.name,
      customerMobile: customer.mobile,
      customerEmail,
      customerProfileId: userId,
      amount: total,
      chargeItems: buildChargeItems(priced, deliveryFee, tax),
      description: `X-Burger order #${orderId}`,
      paymentExpiry,
      orderWebHookUrl,
    });

    db.prepare("UPDATE orders SET fawry_reference_number = ?, updated_at = datetime('now') WHERE id = ?").run(
      charge.referenceNumber,
      orderId
    );

    return {
      orderId,
      merchantRefNum,
      fawryReferenceNumber: charge.referenceNumber,
      total,
      expiresAt: paymentExpiry,
    };
  } catch (err) {
    // Don't leave a dangling order if FawryPay rejected the request.
    db.prepare("UPDATE orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(orderId);
    throw err;
  }
}

// ---------------------------------------------------------------------
// Guest checkout — this is what order.html's fetch('.../api/checkout')
// calls. Body: { customer: {name, mobile, email}, items: [{name, qty}], deliveryFee }
// ---------------------------------------------------------------------
router.post('/checkout', async (req, res) => {
  try {
    const { customer, items, deliveryFee } = req.body || {};
    const cartItems = (items || []).map((i) => ({ menu_item_id: null, name: i.name, qty: i.qty }));

    const result = await checkout({
      userId: null,
      customer: { name: customer?.name, mobile: customer?.mobile, email: customer?.email },
      cartItems,
      deliveryFee: typeof deliveryFee === 'number' ? deliveryFee : DEFAULT_DELIVERY_FEE,
    });

    res.status(201).json(result);
  } catch (err) {
    console.error('Checkout failed:', err.fawryResponse || err.message);
    res.status(err.status || 502).json({ error: err.message || 'Checkout failed', fawry: err.fawryResponse });
  }
});

// ---------------------------------------------------------------------
// Authenticated checkout, per the README's documented API — same flow,
// but tied to a logged-in account.
// ---------------------------------------------------------------------
router.post('/', requireAuth, async (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const { items, deliveryFee, email } = req.body || {};

    const result = await checkout({
      userId: user.id,
      customer: { name: user.name, mobile: user.phone, email },
      cartItems: items || [],
      deliveryFee: typeof deliveryFee === 'number' ? deliveryFee : DEFAULT_DELIVERY_FEE,
    });

    res.status(201).json(result);
  } catch (err) {
    console.error('Checkout failed:', err.fawryResponse || err.message);
    res.status(err.status || 502).json({ error: err.message || 'Checkout failed', fawry: err.fawryResponse });
  }
});

router.get('/mine', requireAuth, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  const itemsStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  res.json(orders.map((o) => ({ ...o, items: itemsStmt.all(o.id) })));
});

// Pull a single order's live status straight from FawryPay — a fallback
// for when the webhook is delayed, or for a "check payment" button.
router.get('/:id/status', async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  try {
    const status = await fawry.getPaymentStatus(order.merchant_ref_num);
    if (status.orderStatus === 'PAID' && order.status !== 'paid') {
      db.prepare("UPDATE orders SET status = 'paid', updated_at = datetime('now') WHERE id = ?").run(order.id);
      order.status = 'paid';
    }
    res.json({ order, fawry: status });
  } catch (err) {
    res.status(502).json({ error: err.message, order });
  }
});

// ---------------------------------------------------------------------
// FawryPay server-to-server webhook. Point FawryPay's notification
// settings (or the per-order orderWebHookUrl, set automatically here via
// PUBLIC_BASE_URL) at: POST https://your-domain.com/api/orders/fawry-webhook
// ---------------------------------------------------------------------
router.post('/fawry-webhook', (req, res) => {
  const payload = req.body || {};

  if (!fawry.verifyResultSignature(payload)) {
    console.warn('Rejected a FawryPay webhook with an invalid signature.');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const refNum = payload.merchantRefNumber || payload.merchantRefNum;
  const order = db.prepare('SELECT * FROM orders WHERE merchant_ref_num = ?').get(refNum);
  if (!order) return res.status(404).json({ error: 'Unknown order' });

  const statusMap = {
    PAID: 'paid',
    UNPAID: 'pending_payment',
    EXPIRED: 'expired',
    REFUNDED: 'cancelled',
    CANCELED: 'cancelled',
  };
  const newStatus = statusMap[payload.orderStatus] || order.status;

  db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, order.id);

  res.json({ ok: true });
});

module.exports = router;
