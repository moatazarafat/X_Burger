# X-Burger Backend

The real backend for X-Burger: accounts, menu, and orders stored in an
actual database, with **real, working FawryPay payments** ("Pay at Fawry"
reference-number flow) — instead of the browser's localStorage and the fake
checkout the site used to have.

## What's inside

- **Node.js + Express** — the server that answers requests from your website.
- **SQLite** (`data/xburger.db`) — the database. It's just one file, no extra
  software to install.
- **Real accounts** — passwords are hashed (never stored as plain text), and
  logins use signed tokens (JWT).
- **Admin dashboard** (`/admin.html`) — restaurant staff can see every order
  live and update its status.
- **Real FawryPay integration** (`services/fawry.js`) — creates a genuine
  "Pay at Fawry" reference number for every order, verifies FawryPay's
  signatures, and updates the order automatically via webhook when it's paid.

## 1. Install Node.js

Download and install from **nodejs.org** — you need **Node 22.13 or newer**
(the built-in SQLite module this project uses requires it). To check it
worked, open a terminal and run:

```
node -v
npm -v
```

## 2. Install the project's dependencies

Open a terminal **inside this folder** (the one with `package.json` in it) and run:

```
npm install
```

## 3. Get your FawryPay credentials

1. Register a merchant account at **fawrypay.online**. FawryPay gives you
   **sandbox/staging credentials immediately** — you don't have to wait for
   approval to start testing the full payment flow with fake money.
2. From your FawryPay dashboard, grab your **Merchant Code** and **Secure
   Key**.
3. Copy `.env.example` to a new file named `.env` and fill in:
   - `JWT_SECRET` — any long random text.
   - `FAWRY_MERCHANT_CODE` and `FAWRY_SECURE_KEY` — from step 2.
   - Leave `FAWRY_MODE=sandbox` while testing. Switch to `production` only
     once your real merchant account is approved and you're using your live
     credentials.

## 4. Run it

```
npm start
```

You should see something like:

```
X-Burger backend running on http://localhost:4000
Admin dashboard: http://localhost:4000/admin.html
FawryPay: configured, sandbox mode (https://atfawry.fawrystaging.com)
```

If it instead says `FawryPay: NOT configured`, double check your `.env`.

Visit `http://localhost:4000/api/menu` in your browser — you should see the
menu as JSON. That confirms the server itself is working.

## 5. Make yourself an admin

Register a normal account first (through the website, or with `curl`):

```
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Sara","phone":"01000000000","password":"changeme123"}'
```

Then run this **one-time** command in a *new* terminal (keep the server
running in the other one) to make that account an admin:

```
node -e "require('./db').prepare('UPDATE users SET is_admin = 1 WHERE phone = ?').run('01000000000')"
```

Open `http://localhost:4000/admin.html` and log in with that phone number
and password — you'll see every order come in live.

## 6. Test a real payment

1. On `order.html`, add items to the cart and fill in the delivery details.
2. "Pay at Fawry" is already selected — click **Place order**.
3. The backend re-prices your cart against the real menu, creates the order,
   and calls FawryPay's Charge API for real. You'll get back a genuine
   FawryPay reference number.
4. In **sandbox mode**, use FawryPay's published test reference/payment
   flows (see FawryPay's "End-to-End Testing" docs) to simulate paying that
   reference — your order's status will flip to `paid` automatically once
   the webhook arrives (see step 7), or you can check
   `GET /api/orders/:id/status` to pull the live status manually.

## 7. Getting paid-status updates automatically (webhook)

Once this backend is deployed somewhere with a real public URL, set
`PUBLIC_BASE_URL` in your `.env` (e.g. `https://xburger-backend.onrender.com`).
Every new order will then ask FawryPay to `POST` payment updates to:

```
{PUBLIC_BASE_URL}/api/orders/fawry-webhook
```

The backend verifies FawryPay's signature on every webhook call before
trusting it, so orders only flip to `paid` when FawryPay itself confirms it.

While testing locally (no public URL), orders still work — you just poll
`GET /api/orders/:id/status` instead of waiting on the webhook.

## 8. Deploying so it's live on the internet

1. Push this folder to a new GitHub repository.
2. Go to **render.com**, sign up free, click **New > Web Service**, and
   connect your GitHub repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Under **Environment**, add the same variables from your `.env` file
   (`JWT_SECRET`, `FAWRY_MERCHANT_CODE`, `FAWRY_SECURE_KEY`, `FAWRY_MODE`,
   `PUBLIC_BASE_URL` set to the Render URL Render gives you, `ALLOWED_ORIGIN`
   set to your real site's URL).
5. Deploy. Update `CHECKOUT_API_URL` in `order.html` to point at your real
   backend URL instead of `http://localhost:4000/api/checkout`.

⚠️ Render's free tier "sleeps" the server after inactivity, so the first
request after a while takes ~30 seconds to wake up. Fine for testing; for a
real restaurant taking live orders, a small paid tier avoids that delay.

## 9. Going live with real (non-sandbox) payments

Once FawryPay approves your merchant account for production:

1. Set `FAWRY_MODE=production` in your `.env` / Render environment.
2. Replace `FAWRY_MERCHANT_CODE` and `FAWRY_SECURE_KEY` with your **live**
   credentials (different from your sandbox ones).
3. Restart the server. No code changes needed — the same integration now
   talks to `www.atfawry.com` instead of the staging environment.

## API reference (quick)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/menu` | none | List available menu items |
| POST | `/api/auth/register` | none | `{ name, phone, password }` |
| POST | `/api/auth/login` | none | `{ phone, password }` |
| POST | `/api/orders/checkout` | none | Guest checkout — what `order.html` calls. `{ customer: {name, mobile, email}, items: [{name, qty}], deliveryFee }` → `{ orderId, fawryReferenceNumber, total, expiresAt }` |
| POST | `/api/orders` | Bearer token | Same as above, tied to your account |
| GET | `/api/orders/mine` | Bearer token | Your own order history |
| GET | `/api/orders/:id/status` | none | Pull the live FawryPay status for one order |
| POST | `/api/orders/fawry-webhook` | FawryPay signature | Receives payment confirmations from FawryPay |
| GET | `/api/admin/orders` | Bearer token (admin) | Every order |
| POST | `/api/admin/orders/:id/status` | Bearer token (admin) | Update order status |
| GET | `/api/health` | none | Confirms the server + FawryPay config are up |
