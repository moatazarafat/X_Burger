// server.js
// Entry point — start this with `npm start`.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { router: authRouter } = require('./routes/auth');
const menuRouter = require('./routes/menu');
const ordersRouter = require('./routes/orders');
const adminRouter = require('./routes/admin');
const fawry = require('./services/fawry');

const app = express();

app.use(cors()); // during development, allow requests from anywhere.
// Before going live, set ALLOWED_ORIGIN in .env and change this to:
// app.use(cors({ origin: process.env.ALLOWED_ORIGIN }));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // serves public/admin.html

app.use('/api/auth', authRouter);
app.use('/api/menu', menuRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/admin', adminRouter);

app.get('/api/health', (req, res) => res.json({ ok: true, fawryMode: fawry.MODE, fawryConfigured: fawry.isConfigured() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`X-Burger backend running on http://localhost:${PORT}`);
  console.log(`Admin dashboard: http://localhost:${PORT}/admin.html`);
  console.log(
    fawry.isConfigured()
      ? `FawryPay: configured, ${fawry.MODE} mode (${fawry.BASE_URL})`
      : `FawryPay: NOT configured — set FAWRY_MERCHANT_CODE and FAWRY_SECURE_KEY in .env`
  );
});
