const axios = require('axios');
const crypto = require('crypto');

// =====================================================
// Razorpay (Orders API + signature verification)
// https://razorpay.com/docs/payments/server-integration/nodejs/integration-steps/
// =====================================================

const razorpayApi = axios.create({
  baseURL: 'https://api.razorpay.com/v1',
  auth: {
    username: process.env.RAZORPAY_KEY_ID || '',
    password: process.env.RAZORPAY_KEY_SECRET || ''
  }
});

/**
 * Create a Razorpay order. amountPaise must be an integer (smallest unit).
 */
async function createRazorpayOrder({ amountPaise, receipt, notes }) {
  const res = await razorpayApi.post('/orders', {
    amount: amountPaise,
    currency: 'INR',
    receipt,
    payment_capture: 1,
    notes
  });
  return res.data; // { id, amount, currency, receipt, ... }
}

/**
 * Verify the signature returned by Razorpay Checkout after a successful payment.
 * https://razorpay.com/docs/payments/server-integration/nodejs/integration-steps/#3-verify-payment-signature
 */
function verifyRazorpayPaymentSignature({ orderId, paymentId, signature }) {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return expected === signature;
}

/**
 * Verify a Razorpay webhook payload signature.
 * https://razorpay.com/docs/webhooks/validate-test/
 */
function verifyRazorpayWebhookSignature({ rawBody, signature }) {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || '')
    .update(rawBody)
    .digest('hex');
  return expected === signature;
}

// =====================================================
// PayPal (Orders v2 REST API)
// https://developer.paypal.com/docs/api/orders/v2/
// =====================================================

const paypalBase = process.env.PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getPaypalAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry - 30_000) {
    return cachedToken;
  }
  const res = await axios.post(
    `${paypalBase}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      auth: {
        username: process.env.PAYPAL_CLIENT_ID || '',
        password: process.env.PAYPAL_CLIENT_SECRET || ''
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }
  );
  cachedToken = res.data.access_token;
  cachedTokenExpiry = Date.now() + res.data.expires_in * 1000;
  return cachedToken;
}

/**
 * Create a PayPal order (intent: CAPTURE). amountUsd is a string/number like "3.50".
 */
async function createPaypalOrder({ amountUsd, referenceId, returnUrl, cancelUrl }) {
  const token = await getPaypalAccessToken();
  const res = await axios.post(
    `${paypalBase}/v2/checkout/orders`,
    {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: referenceId,
          amount: { currency_code: 'USD', value: Number(amountUsd).toFixed(2) }
        }
      ],
      application_context: {
        return_url: returnUrl,
        cancel_url: cancelUrl,
        user_action: 'PAY_NOW',
        shipping_preference: 'NO_SHIPPING'
      }
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return res.data; // { id, status, links: [...] }
}

/**
 * Capture a previously approved PayPal order.
 */
async function capturePaypalOrder(orderId) {
  const token = await getPaypalAccessToken();
  const res = await axios.post(
    `${paypalBase}/v2/checkout/orders/${orderId}/capture`,
    {},
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return res.data; // { id, status: 'COMPLETED', purchase_units: [...] }
}

/**
 * Fetch order details (used to read reference_id / status without capturing).
 */
async function getPaypalOrder(orderId) {
  const token = await getPaypalAccessToken();
  const res = await axios.get(`${paypalBase}/v2/checkout/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.data;
}

module.exports = {
  createRazorpayOrder,
  verifyRazorpayPaymentSignature,
  verifyRazorpayWebhookSignature,
  createPaypalOrder,
  capturePaypalOrder,
  getPaypalOrder,
  paypalBase
};
