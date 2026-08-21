// services/fawry.js
//
// Real, working integration with FawryPay's server-to-server API for the
// "Pay at Fawry" (PayAtFawry) reference-number flow — the customer gets a
// reference number and pays it in cash/card at any Fawry retail outlet,
// ATM, or through their banking/wallet app.
//
// Docs used to build this:
//   - Charge Request:      https://developer.fawrystaging.com/docs/server-apis/create-payment-refno-apis
//   - Get Payment Status:  https://developer.fawrystaging.com/docs/server-apis/payment-notifications/get-payment-status-v2
//   - Server Notification: https://developer.fawrystaging.com/docs/server-apis/payment-notifications/server-notification-v2
//
// Get your real MERCHANT_CODE and SECURE_KEY from the FawryPay merchant
// dashboard (fawrypay.online) after your merchant account is approved.
// Until then, FawryPay gives you sandbox/staging credentials so you can
// test the full flow end-to-end with fake money.

const crypto = require('crypto');

const MODE = (process.env.FAWRY_MODE || 'sandbox').toLowerCase();

// Staging (sandbox) vs. production base URLs, per FawryPay's docs.
const BASE_URL = MODE === 'production'
  ? 'https://www.atfawry.com'
  : 'https://atfawry.fawrystaging.com';

const CHARGE_URL = `${BASE_URL}/ECommerceWeb/Fawry/payments/charge`;
const STATUS_URL = `${BASE_URL}/ECommerceWeb/Fawry/payments/status/v2`;

const MERCHANT_CODE = process.env.FAWRY_MERCHANT_CODE;
const SECURE_KEY = process.env.FAWRY_SECURE_KEY;

function assertConfigured() {
  if (!MERCHANT_CODE || !SECURE_KEY) {
    throw new Error(
      'FawryPay is not configured yet. Set FAWRY_MERCHANT_CODE and FAWRY_SECURE_KEY in your .env ' +
      '(FawryPay gives you sandbox credentials immediately when you register at fawrypay.online — ' +
      'no need to wait for approval to start testing).'
    );
  }
}

// FawryPay requires amounts formatted with exactly 2 decimal places, e.g. "350.75".
function money(n) {
  return Number(n).toFixed(2);
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// Charge request signature (per FawryPay docs):
// SHA256(merchantCode + merchantRefNum + customerProfileId(if exists, else "") + paymentMethod + amount(2dp) + secureKey)
function buildChargeSignature({ merchantRefNum, customerProfileId, paymentMethod, amount }) {
  const parts = [
    MERCHANT_CODE,
    String(merchantRefNum),
    customerProfileId ? String(customerProfileId) : '',
    paymentMethod,
    money(amount),
    SECURE_KEY,
  ];
  return sha256Hex(parts.join(''));
}

// Get Payment Status V2 signature: SHA256(merchantCode + merchantRefNumber + secureKey)
function buildStatusSignature(merchantRefNumber) {
  return sha256Hex(`${MERCHANT_CODE}${merchantRefNumber}${SECURE_KEY}`);
}

// Signature FawryPay attaches to charge responses AND to webhook/notification
// payloads, so you can verify the data genuinely came from FawryPay:
// SHA256(referenceNumber + merchantRefNumber + paymentAmount(2dp) + orderAmount(2dp)
//        + orderStatus + paymentMethod + fawryFees(2dp, if exists) + shippingFees(2dp, if exists)
//        + authNumber(if exists) + customerMail(if exists) + customerMobile(if exists) + secureKey)
function buildResultSignature(data) {
  const parts = [
    data.referenceNumber || '',
    data.merchantRefNumber || data.merchantRefNum || '',
    data.paymentAmount != null ? money(data.paymentAmount) : '',
    data.orderAmount != null ? money(data.orderAmount) : '',
    data.orderStatus || '',
    data.paymentMethod || '',
    data.fawryFees != null ? money(data.fawryFees) : '',
    data.shippingFees != null ? money(data.shippingFees) : '',
    data.authNumber || '',
    data.customerMail || '',
    data.customerMobile || '',
    SECURE_KEY,
  ];
  return sha256Hex(parts.join(''));
}

function verifyResultSignature(data) {
  if (!data || !data.signature) return false;
  try {
    return buildResultSignature(data) === data.signature;
  } catch {
    return false;
  }
}

/**
 * Create a "Pay at Fawry" reference-number charge.
 * On success, FawryPay returns a `referenceNumber` — that's the code the
 * customer pays at any Fawry outlet, ATM, or banking/wallet app.
 */
async function createPayAtFawryCharge({
  merchantRefNum,
  customerName,
  customerMobile,
  customerEmail,
  customerProfileId,
  amount,
  chargeItems,
  description,
  paymentExpiry,
  language = 'en-gb',
  orderWebHookUrl,
}) {
  assertConfigured();

  const paymentMethod = 'PayAtFawry';
  const signature = buildChargeSignature({ merchantRefNum, customerProfileId, paymentMethod, amount });

  const body = {
    merchantCode: MERCHANT_CODE,
    merchantRefNum: String(merchantRefNum),
    customerName,
    customerMobile,
    customerEmail,
    ...(customerProfileId ? { customerProfileId: String(customerProfileId) } : {}),
    amount: money(amount),
    currencyCode: 'EGP',
    language,
    description: description || 'X-Burger order',
    paymentExpiry: String(paymentExpiry),
    chargeItems,
    paymentMethod,
    signature,
    ...(orderWebHookUrl ? { orderWebHookUrl } : {}),
  };

  let res;
  try {
    res = await fetch(CHARGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (networkErr) {
    throw new Error(`Could not reach FawryPay (${MODE} mode): ${networkErr.message}`);
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.statusCode !== 200) {
    const message = data.statusDescription || data.message || `FawryPay request failed (HTTP ${res.status})`;
    const err = new Error(message);
    err.fawryResponse = data;
    throw err;
  }

  return data;
}

/**
 * Pull the current status of an order directly from FawryPay — useful as a
 * fallback / manual "check now" button if the webhook hasn't arrived yet.
 */
async function getPaymentStatus(merchantRefNumber) {
  assertConfigured();

  const signature = buildStatusSignature(merchantRefNumber);
  const url = new URL(STATUS_URL);
  url.searchParams.set('merchantCode', MERCHANT_CODE);
  url.searchParams.set('merchantRefNumber', String(merchantRefNumber));
  url.searchParams.set('signature', signature);

  const res = await fetch(url.toString(), { method: 'GET' });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(data.statusDescription || `FawryPay status request failed (HTTP ${res.status})`);
    err.fawryResponse = data;
    throw err;
  }

  return data;
}

module.exports = {
  MODE,
  BASE_URL,
  isConfigured: () => Boolean(MERCHANT_CODE && SECURE_KEY),
  createPayAtFawryCharge,
  getPaymentStatus,
  verifyResultSignature,
  money,
};
