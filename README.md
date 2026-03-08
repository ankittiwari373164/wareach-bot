# WAReach Bot v4.0

WhatsApp DM automation using Baileys (direct API — no browser needed).

## Setup

```bash
# 1. Install Node.js 18+ from nodejs.org

# 2. Install dependencies
npm install

# 3. Start the bot
node bot.js
```

## First Run
- A QR code appears in the terminal
- Scan with WhatsApp: Settings → Linked Devices → Link a Device
- Session saved to ./session — auto-reconnects on restart

## API Endpoints
- GET  /ping                    → health check
- GET  /status                  → connection status
- GET  /qr                      → get QR code string
- GET  /api/campaigns           → list campaigns
- POST /api/campaigns           → create campaign
- POST /api/campaigns/:id/start → start campaign
- POST /api/campaigns/:id/stop  → stop campaign
- GET  /api/numbers             → list numbers
- POST /api/numbers             → add numbers (array)
- GET  /api/logs                → activity logs
- GET  /api/stats?campaignId=X  → campaign stats

## Console
The bot logs all activity to console with timestamps.
