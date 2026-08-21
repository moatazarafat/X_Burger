// db.js
// Sets up the SQLite database file and creates tables if they don't exist yet.
// Uses Node.js's BUILT-IN SQLite module (node:sqlite) — no npm package to
// install, no native compilation, ships inside Node itself (stable since
// Node 22.13+, fully stable on Node 24+).

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const db = new DatabaseSync(path.join(dataDir, 'xburger.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    image TEXT,
    is_available INTEGER NOT NULL DEFAULT 1
  );

  -- user_id is nullable: X-Burger's checkout page (order.html) supports
  -- guest checkout, so not every order belongs to a registered account.
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    customer_name TEXT NOT NULL,
    customer_mobile TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_payment',
    -- statuses: pending_payment | paid | preparing | ready | completed | cancelled | expired
    payment_method TEXT NOT NULL DEFAULT 'PayAtFawry',
    merchant_ref_num TEXT NOT NULL UNIQUE,   -- our reference, sent to FawryPay
    fawry_reference_number TEXT,             -- FawryPay's reference, shown to the customer
    subtotal REAL NOT NULL,
    delivery_fee REAL NOT NULL DEFAULT 0,
    tax REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    menu_item_id INTEGER REFERENCES menu_items(id),
    name TEXT NOT NULL,
    unit_price REAL NOT NULL,
    qty INTEGER NOT NULL
  );
`);

// node:sqlite doesn't have a built-in db.transaction() helper (unlike
// better-sqlite3), so we add a tiny one here that the rest of the app uses
// the same way: db.transaction(() => { ...your inserts... })()
db.transaction = function (fn) {
  return function (...args) {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
};

// Seed the menu once, the first time the database is created.
const menuCount = db.prepare('SELECT COUNT(*) AS c FROM menu_items').get().c;
if (menuCount === 0) {
  const insert = db.prepare(
    'INSERT INTO menu_items (category, name, price, image) VALUES (?, ?, ?, ?)'
  );
  const seedItems = [
    ['burgers', 'Classic Burger', 120, 'Photos/menu/classic-burger.jpg'],
    ['burgers', 'Double Cheese', 160, 'Photos/menu/double-cheese.jpg'],
    ['burgers', 'Spicy Burger', 135, 'Photos/menu/spicy-burger.jpg'],
    ['burgers', 'BBQ Burger', 150, 'Photos/menu/bbq-burger.jpg'],
    ['sides', 'French Fries', 40, 'Photos/menu/fries.jpg'],
    ['sides', 'Onion Rings', 50, 'Photos/menu/onion-rings.jpg'],
    ['sides', 'Cheese Sticks', 55, 'Photos/menu/cheese-sticks.jpg'],
    ['drinks', 'Cola', 20, 'Photos/menu/cola.jpg'],
    ['drinks', 'Fresh Lemonade', 30, 'Photos/menu/lemonade.jpg'],
    ['drinks', 'Milkshake', 45, 'Photos/menu/milkshake.jpg'],
  ];
  const insertMany = db.transaction((items) => {
    for (const item of items) insert.run(...item);
  });
  insertMany(seedItems);
  console.log('Seeded menu_items with the default X-Burger menu.');
}

module.exports = db;
