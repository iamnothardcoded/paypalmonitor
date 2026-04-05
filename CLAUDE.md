# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PayPal webhook/IPN receiver and payment monitor. A Node.js Express server that:
- Receives PayPal IPN (form-encoded) and Webhook (JSON) notifications
- Logs payments to daily JSON files (`logs/YYYY-MM-DD.json`) in Berlin timezone
- Serves a PIN-protected dashboard showing the last payment
- Provides API endpoint for payment data
- Optional background poller as webhook fallback

## Commands

```bash
# Install dependencies
npm install

# Run the webhook server
node server.js

# Run the backup poller (separate process)
node poller.js

# Docker build and run
docker-compose up -d --build

# View Docker logs
docker logs paypal-webhook -f
```

## Architecture

### Core Components

- **server.js** - Main Express app (port 3000, binds to 127.0.0.1)
  - `POST /` - Webhook endpoint (receives both IPN and JSON webhooks)
  - `GET /dashboard` - Serves PIN-protected HTML dashboard
  - `GET /api/payments/today` - Returns today's payments (or specific date via `?date=YYYY-MM-DD`)
  - Verifies PayPal webhook signatures via PayPal API
  - In-memory rate limiting (30 req/min per IP)

- **poller.js** - Standalone PayPal API poller
  - Polls PayPal Transaction API every 5 minutes
  - Tracks seen transactions in `logs/.seen_transactions.json`
  - Deduplicates against existing log entries
  - Optional Telegram notifications

- **dashboard.html** - Single-page payment display
  - PIN-protected (default: `1234`, stored in localStorage)
  - Polls `/api/payments/today` every 3 seconds
  - Beep + vibration on new payment

### Data Flow

1. PayPal sends IPN/webhook → server.js receives on POST /
2. Server parses IPN (form-encoded) or Webhook (JSON)
3. For webhooks: signature verified via PayPal API
4. Only `Completed` IPN or `PAYMENT.CAPTURE.COMPLETED`/`PAYMENT.SALE.COMPLETED` events logged
5. Transaction appended to `logs/YYYY-MM-DD.json` (date based on payment_date, Berlin TZ)

### Environment Variables

```
PAYPAL_WEBHOOK_ID     - PayPal webhook ID for signature verification
PAYPAL_CLIENT_ID      - PayPal API credentials
PAYPAL_CLIENT_SECRET  - PayPal API credentials
TELEGRAM_BOT_TOKEN    - Optional: for notifications
TELEGRAM_CHAT_ID      - Optional: for notifications
```

### Log Format

Each daily log file contains an array of transaction objects:
```json
{
  "id": "transaction_id",
  "amount": "10.00",
  "currency": "EUR",
  "payer_email": "buyer@example.com",
  "payer_name": "John Doe",
  "time": "2026-03-04T10:30:00Z",
  "source": "IPN" | "API_POLL",
  "verified": true
}
```
