# PayPal Payment Monitor

A Node.js server that receives PayPal IPN/webhook notifications and displays them on a PIN-protected dashboard.

## Features

- Receives PayPal IPN (form-encoded) and Webhook (JSON) notifications
- Logs payments to daily JSON files (`logs/YYYY-MM-DD.json`)
- PIN-protected dashboard showing the last payment
- Optional Telegram notifications
- Optional backup poller that queries PayPal API every 5 minutes

## Quick Start with Docker

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/paypalmonitor.git
cd paypalmonitor

# Copy and edit the config
cp docker-compose.example.yml docker-compose.yml
nano docker-compose.yml  # Add your PayPal credentials

# Build and run
docker-compose up -d --build

# Check logs
docker logs paypal-webhook -f
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PAYPAL_WEBHOOK_ID` | Yes | Your PayPal webhook ID |
| `PAYPAL_CLIENT_ID` | Yes | PayPal API client ID |
| `PAYPAL_CLIENT_SECRET` | Yes | PayPal API client secret |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token for notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat ID for notifications |

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /dashboard` | PIN-protected payment display (default PIN: `1234`) |
| `GET /api/payments/today` | JSON list of today's payments |
| `GET /api/payments/today?date=YYYY-MM-DD` | Payments for a specific date |
| `POST /` | Webhook endpoint for PayPal |

## Synology NAS Deployment

1. Upload the project to your Synology via SSH or File Station
2. Open Container Manager
3. Go to Project → Create
4. Select the folder containing docker-compose.yml
5. Build and start

## Dashboard

The dashboard is PIN-protected (default: `1234`). Change it in `dashboard.html`.

- Shows the last payment amount and payer
- Beeps and vibrates on new payments
- Hold the payment card to see today's total
