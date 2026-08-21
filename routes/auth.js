// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, phone: user.phone, isAdmin: !!user.is_admin },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

router.post('/register', (req, res) => {
  const { name, phone, password } = req.body || {};
  if (!name || !phone || !password) {
    return res.status(400).json({ error: 'name, phone and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  if (existing) {
    return res.status(409).json({ error: 'An account with this phone number already exists' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const insert = db.prepare('INSERT INTO users (name, phone, password_hash) VALUES (?, ?, ?)');
  const result = insert.run(name, phone, passwordHash);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  const token = signToken(user);
  res.status(201).json({ token, user: { id: user.id, name: user.name, phone: user.phone, isAdmin: !!user.is_admin } });
});

router.post('/login', (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: 'phone and password are required' });

  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid phone number or password' });
  }

  const token = signToken(user);
  res.json({ token, user: { id: user.id, name: user.name, phone: user.phone, isAdmin: !!user.is_admin } });
});

module.exports = { router };
