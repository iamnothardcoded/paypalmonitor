/**
 * PayPal API Poller
 * Polls PayPal every 5 minutes and writes to the same log format as IPN.
 * Resilient fallback — works even if IPN/Funnel/Tailscale is down.
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
const SEEN_FILE = path.join(__dirname, 'logs', '.seen_transactions.json');
const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function notifyTelegram(entry) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: `💶 *€${parseFloat(entry.amount).toFixed(2)}* erhalten\n👤 ${entry.payer_name || entry.payer_email}`,
        parse_mode: 'Markdown'
      })
    });
  } catch(e) {
    console.error('[poller] Telegram error:', e.message);
  }
}

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function getBerlinDate(isoDate) {
  const d = isoDate ? new Date(isoDate) : new Date();
  return d.toLocaleString('sv', { timeZone: 'Europe/Berlin' }).slice(0, 10);
}

function getLogPath(date) {
  return path.join(LOG_DIR, `${date}.json`);
}

function loadSeen() {
  try {
    return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')));
  } catch {
    return new Set();
  }
}

function saveSeen(seen) {
  // Only keep last 1000 IDs to prevent bloat
  const arr = [...seen].slice(-1000);
  fs.writeFileSync(SEEN_FILE, JSON.stringify(arr));
}

function readLog(date) {
  const p = getLogPath(date);
  try {
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
  } catch {
    return [];
  }
}

function writeLog(date, entries) {
  fs.writeFileSync(getLogPath(date), JSON.stringify(entries, null, 2));
}

async function getAccessToken() {
  const res = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Auth failed: ' + JSON.stringify(data));
  return data.access_token;
}

async function poll() {
  try {
    const token = await getAccessToken();

    // Fetch last 24h to catch anything missed
    const start = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 19) + 'Z';
    const end = new Date().toISOString().slice(0, 19) + 'Z';

    const res = await fetch(
      `https://api-m.paypal.com/v1/reporting/transactions?start_date=${start}&end_date=${end}&fields=all&page_size=100`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const data = await res.json();

    const seen = loadSeen();
    let newCount = 0;

    for (const tx of (data.transaction_details || [])) {
      const info = tx.transaction_info;
      const id = info.transaction_id;
      const amount = parseFloat(info.transaction_amount?.value || 0);

      // Only completed incoming payments
      if (info.transaction_status !== 'S' || amount <= 0) continue;
      if (seen.has(id)) continue;

      seen.add(id);
      newCount++;

      const txDate = getBerlinDate(info.transaction_initiation_date);
      const payer = tx.payer_info || {};
      const entry = {
        id,
        amount: info.transaction_amount.value,
        currency: info.transaction_amount.currency_code,
        payer_email: payer.email_address || '',
        payer_name: [payer.payer_name?.given_name, payer.payer_name?.surname].filter(Boolean).join(' ') || '',
        time: info.transaction_initiation_date,
        source: 'API_POLL',
        verified: true
      };

      const log = readLog(txDate);
      // Avoid duplicates (IPN might have already logged it)
      if (!log.find(e => e.id === id)) {
        log.push(entry);
        writeLog(txDate, log);
        console.log(`[poller] New: €${entry.amount} from ${entry.payer_email} on ${txDate}`);
        await notifyTelegram(entry);
      }
    }

    saveSeen(seen);
    if (newCount === 0) console.log(`[poller] Poll OK — no new transactions`);
  } catch (e) {
    console.error('[poller] Error:', e.message);
  }
}

console.log('[poller] Starting PayPal API poller (every 5 min)');
poll(); // Run immediately on start
setInterval(poll, POLL_INTERVAL);
