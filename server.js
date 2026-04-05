const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
// Tailscale Funnel strips the path prefix, so we receive on '/'
const WEBHOOK_PATH = '/';
const LOG_DIR = path.join(__dirname, 'logs');

// Load webhook ID from secrets
const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Send Telegram notification (disabled)
async function notifyTelegram(transaction) {
  // Notifications disabled
  return;
}

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Rate limiting (simple in-memory)
const requestCounts = new Map();
const RATE_LIMIT = 30; // requests per minute
const RATE_WINDOW = 60000; // 1 minute

function checkRateLimit(ip) {
  const now = Date.now();
  const record = requestCounts.get(ip) || { count: 0, resetAt: now + RATE_WINDOW };
  
  if (now > record.resetAt) {
    record.count = 1;
    record.resetAt = now + RATE_WINDOW;
  } else {
    record.count++;
  }
  
  requestCounts.set(ip, record);
  return record.count <= RATE_LIMIT;
}

// Raw body needed for signature verification
// Accept any content type to ensure we capture PayPal's requests
app.use(express.raw({ type: '*/*' }));

// Serve static assets
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Serve dashboard
const DASHBOARD_PATH = path.join(__dirname, 'dashboard.html');
app.get('/dashboard', (req, res) => {
  try {
    const html = fs.readFileSync(DASHBOARD_PATH, 'utf8');
    res.type('html').send(html);
  } catch (e) {
    res.status(500).send('Dashboard error: ' + e.message);
  }
});

// API: get payments for a specific date (Berlin time), defaults to today
// Usage: /api/payments/today or /api/payments/today?date=2026-03-04
app.get('/api/payments/today', (req, res) => {
  const logPath = req.query.date
    ? path.join(LOG_DIR, `${req.query.date}.json`)
    : getTodayLogPath();
  try {
    if (fs.existsSync(logPath)) {
      const data = JSON.parse(fs.readFileSync(logPath, 'utf8'));
      res.json(data);
    } else {
      res.json([]);
    }
  } catch (e) {
    res.json([]);
  }
});

// Security: only Tailscale routes to this port, so we accept on root
// The random path is handled by Tailscale Funnel, not here

// PayPal signature verification
function verifyPayPalSignature(req) {
  // Required headers from PayPal
  const transmissionId = req.headers['paypal-transmission-id'];
  const timestamp = req.headers['paypal-transmission-time'];
  const signature = req.headers['paypal-transmission-sig'];
  const certUrl = req.headers['paypal-cert-url'];
  const authAlgo = req.headers['paypal-auth-algo'];
  
  if (!transmissionId || !timestamp || !signature || !PAYPAL_WEBHOOK_ID) {
    return false;
  }
  
  // For full verification, we'd need to:
  // 1. Download PayPal's cert from certUrl
  // 2. Verify the signature using the cert
  // 
  // Simplified: we'll use PayPal's verification API endpoint instead
  // This is done async after logging - see verifyWithPayPal()
  
  return { transmissionId, timestamp, signature, certUrl, authAlgo };
}

// Async verification with PayPal API
async function verifyWithPayPal(headers, body, webhookId) {
  try {
    // Get access token
    const authResponse = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(
          process.env.PAYPAL_CLIENT_ID + ':' + process.env.PAYPAL_CLIENT_SECRET
        ).toString('base64')
      },
      body: 'grant_type=client_credentials'
    });
    
    const { access_token } = await authResponse.json();
    
    // Verify webhook signature
    const verifyResponse = await fetch('https://api-m.paypal.com/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${access_token}`
      },
      body: JSON.stringify({
        auth_algo: headers['paypal-auth-algo'],
        cert_url: headers['paypal-cert-url'],
        transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'],
        transmission_time: headers['paypal-transmission-time'],
        webhook_id: webhookId,
        webhook_event: JSON.parse(body)
      })
    });
    
    const result = await verifyResponse.json();
    return result.verification_status === 'SUCCESS';
  } catch (err) {
    console.error('Verification error:', err.message);
    return false;
  }
}

// Get today's log file path (Berlin time)
function getTodayLogPath() {
  return getLogPathForDate(new Date());
}

// Get log file path for a specific date, in Berlin timezone
function getLogPathForDate(date) {
  const berlinDate = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
  return path.join(LOG_DIR, `${berlinDate}.json`);
}

// Parse PayPal payment_date (e.g. "04:53:39 Mar 04, 2026 PST") → JS Date
function parsePayPalDate(str) {
  if (!str) return new Date();
  // Replace PST/PDT with explicit offset so Date.parse handles it
  const normalized = str.replace('PST', '-08:00').replace('PDT', '-07:00');
  const d = new Date(normalized);
  return isNaN(d.getTime()) ? new Date() : d;
}

// Append transaction to the log file matching the real payment date (Berlin time)
function logTransaction(data) {
  const paymentDate = parsePayPalDate(data.payment_date);
  const logPath = getLogPathForDate(paymentDate);
  let transactions = [];
  
  if (fs.existsSync(logPath)) {
    try {
      transactions = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    } catch (e) {
      transactions = [];
    }
  }
  
  transactions.push(data);
  fs.writeFileSync(logPath, JSON.stringify(transactions, null, 2));
}

// The webhook endpoint (Tailscale routes /hook-xxx to us as /)
app.post('/', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  
  // Rate limit check
  if (!checkRateLimit(ip)) {
    return res.status(429).end();
  }
  
  // Quick response to PayPal (they have timeout limits)
  res.status(200).end();
  
  // Parse and process async
  try {
    const body = Buffer.isBuffer(req.body) ? req.body.toString() : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    console.log('Received notification, body length:', body.length);
    console.log('Content-Type:', req.headers['content-type']);
    
    // Check if this is IPN (form-encoded) or Webhook (JSON)
    const isIPN = req.headers['content-type']?.includes('x-www-form-urlencoded') || body.includes('payment_status=');
    
    if (isIPN) {
      // Parse IPN (form-encoded)
      const params = new URLSearchParams(body);
      const paymentStatus = params.get('payment_status');
      const amount = params.get('mc_gross');
      const currency = params.get('mc_currency') || 'EUR';
      const payerEmail = params.get('payer_email') || 'unknown';
      const txnId = params.get('txn_id');
      
      console.log('IPN received:', paymentStatus, amount, currency);
      
      // Only process completed payments
      if (paymentStatus !== 'Completed') {
        console.log('Ignoring IPN with status:', paymentStatus);
        return;
      }
      
      // Capture all IPN fields for analysis
      const allFields = {};
      for (const [key, value] of params.entries()) {
        allFields[key] = value;
      }
      
      const transaction = {
        id: txnId,
        amount: amount,
        currency: currency,
        payer_email: payerEmail,
        payer_name: `${params.get('first_name') || ''} ${params.get('last_name') || ''}`.trim() || 'unknown',
        fee: params.get('mc_fee') || '0',
        payment_date: params.get('payment_date') || new Date().toISOString(),
        time: new Date().toISOString(),
        source: 'IPN',
        verified: true,
        raw: allFields  // Full IPN data for analysis
      };
      
      logTransaction(transaction);
      console.log(`✅ IPN Logged: €${amount} from ${payerEmail}`);
      notifyTelegram(transaction);
      return;
    }
    
    // Otherwise handle as webhook (JSON)
    const event = JSON.parse(body);
    console.log('Event type:', event.event_type);
    
    // Only process completed payments (capture = checkout, sale = PayPal.me/direct)
    const validEvents = ['PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.SALE.COMPLETED'];
    if (!validEvents.includes(event.event_type)) {
      console.log(`Ignoring event type: ${event.event_type}`);
      return;
    }
    
    // Verify signature with PayPal
    const isValid = await verifyWithPayPal(req.headers, body, PAYPAL_WEBHOOK_ID);
    
    if (!isValid) {
      console.log('Invalid signature - rejected');
      return;
    }
    
    // Extract payment info (handle both capture and sale event structures)
    const resource = event.resource;
    const transaction = {
      id: resource.id,
      amount: resource.amount?.value || resource.amount?.total || '0',
      currency: resource.amount?.currency_code || resource.amount?.currency || 'EUR',
      payer_email: resource.payer?.email_address || resource.payer_info?.email || 'unknown',
      time: event.create_time,
      event_type: event.event_type,
      verified: true
    };
    
    logTransaction(transaction);
    console.log(`✅ Logged: €${transaction.amount} from ${transaction.payer_email}`);
    
    // Send Telegram notification
    notifyTelegram(transaction);
    
  } catch (err) {
    console.error('Processing error:', err.message);
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`PayPal webhook receiver running on port ${PORT}`);
  console.log(`Endpoint: ${WEBHOOK_PATH}`);
  console.log(`Webhook ID configured: ${PAYPAL_WEBHOOK_ID ? 'Yes' : 'NO - set PAYPAL_WEBHOOK_ID!'}`);
});
