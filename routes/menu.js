// routes/menu.js
const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const items = db
    .prepare('SELECT id, category, name, price, image FROM menu_items WHERE is_available = 1 ORDER BY category, id')
    .all();
  res.json(items);
});

module.exports = router;
