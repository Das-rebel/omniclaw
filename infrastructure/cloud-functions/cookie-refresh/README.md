# OmniClaw Cookie Refresh System

## 🎯 Purpose

Automatically refresh Instagram and Twitter cookies from your browser to keep VM scrapers working without manual intervention.

## 🏗️ Architecture

```
User's Browser (logged in)
    ↓
Cookie Extractor Page/Extension
    ↓ (POST with cookies)
Cloud Function (cookieRefresh)
    ↓ (stores in GCS)
gs://omniclaw-knowledge-graph/vault/cookies/
    ↓ (reads every sync)
VM Scrapers (instagram_scraper.py, twitter_scraper.py)
```

## 📦 Components

### 1. Cookie Extractor (`cookie-extractor.html`)
- Browser extension or standalone HTML page
- Extracts cookies from authenticated browser sessions
- One-click upload to Cloud Function

### 2. Cloud Function (`index.js`)
- Receives cookie updates via HTTP POST
- Validates and stores in GCS
- Supports Instagram and Twitter

### 3. VM Scraper Updates
- Modified scrapers read fresh cookies from GCS
- Automatic cookie refresh every sync cycle

## 🚀 Quick Start

### Step 1: Deploy Cloud Function

```bash
cd infrastructure/cloud-functions/cookie-refresh

# Install dependencies
npm install

# Deploy to GCP
npm run deploy
```

### Step 2: Load Cookie Extractor

**Option A: As Browser Extension** (Recommended)
1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select this directory
5. Open Instagram and Twitter in separate tabs and log in
6. Click the extension icon and click "Refresh All Cookies"

**Option B: As Standalone Page**
1. Open `cookie-extractor.html` in your browser
2. Open Instagram in a new tab and log in
3. Come back to the extractor page and click "Extract Cookies" for Instagram
4. Click "Upload to Cloud"
5. Repeat for Twitter

### Step 3: Update VM Scrapers

The scrapers are already updated to read from GCS. Just run:

```bash
# Test the cookie refresh
gcloud compute ssh --tunnel-through-iap ubuntu@omniclaw-whatsapp --zone=asia-south1-b \
  "cd ~/vault_scraper && bash vm_sync.sh"
```

## 🔐 Security

- API key authentication (set via `COOKIE_REFRESH_API_KEY` env var)
- Cookies stored in GCS with proper IAM permissions
- Only VM service account can read cookies
- Cookies expire after 7 days

## 📋 API Endpoints

### POST `/instagram`
Upload Instagram cookies
```json
{
  "cookies": {
    "sessionid": "...",
    "csrftoken": "...",
    "ds_user_id": "...",
    "mid": "...",
    "ig_did": "..."
  },
  "browserCookies": [
    {
      "name": "sessionid",
      "value": "...",
      "domain": ".instagram.com",
      "path": "/",
      "secure": true,
      "httpOnly": true,
      "sameSite": "None"
    }
  ],
  "timestamp": "2026-04-17T..."
}
```

For Instagram, the full `browserCookies` array is the preferred format. The simple `cookies` map is kept as a convenience index, but the browser-session scraper depends on the full cookie jar.

### POST `/twitter`
Upload Twitter cookies
```json
{
  "cookies": {
    "auth_token": "...",
    "ct0": "...",
    "twid": "..."
  },
  "timestamp": "2026-04-17T..."
}
```

### GET `/health`
Health check endpoint

### GET `/status`
Get current cookie status

## 🔄 Automation

### Cron Job (Every 6 Hours)
Already configured on VM:
```bash
# Crontab entry
0 3 * * * cd ~/vault_scraper && bash vm_sync.sh >> sync.log 2>&1
```

### Manual Cookie Refresh
Users can refresh cookies anytime by:
1. Opening the cookie extractor page/extension
2. Clicking "Refresh All Cookies"
3. Cookies are uploaded to GCS
4. Next sync cycle uses fresh cookies

## 🛠️ Troubleshooting

### Cloud Function returns 401 Unauthorized
- Check API key in request headers: `X-API-Key: omniclaw-cookie-refresh-2024`
- Verify `COOKIE_REFRESH_API_KEY` env var is set in Cloud Function

### Scrapers still fail with cookie errors
- Check GCS bucket has cookie files:
  ```bash
  gsutil ls gs://omniclaw-knowledge-graph/vault/cookies/
  ```
- Verify cookie files are not expired:
  ```bash
  gsutil cat gs://omniclaw-knowledge-graph/vault/cookies/instagram_cookies.json
  ```

### Cookie extractor can't read cookies
- Make sure you're logged into Instagram/Twitter in the browser
- Check browser permissions for the extension
- Try manual cookie extraction from Developer Tools

## 📊 Monitoring

Check cookie status anytime:
```bash
# Via Cloud Function
curl "https://asia-south1-omniclaw-personal-assistant.cloudfunctions.net/cookieRefresh/status"

# Via GCS
gsutil cat gs://omniclaw-knowledge-graph/vault/cookies/instagram_cookies.json
```

## 🔄 Update Frequency

- **Cookie refresh**: Manual (user clicks button) - recommended weekly
- **VM sync**: Every 6 hours (automatic via cron)
- **Cookie expiry**: 7 days (auto-enforced)

## 🎉 Benefits

✅ **No more expired cookie errors** - refresh cookies from your browser in one click
✅ **Secure** - API key authentication, proper IAM permissions
✅ **Automatic** - Scrapers pick up fresh cookies automatically
✅ **No cost** - Uses existing GCP infrastructure
✅ **Reliable** - Works with browser cookies, bypasses Cloudflare

## 📞 Support

For issues or questions:
1. Check Cloud Function logs: `gcloud functions logs read cookieRefresh`
2. Check VM sync logs: `gcloud compute ssh ubuntu@omniclaw-whatsapp --cat ~/vault_scraper/sync.log`
3. Check GCS cookie files: `gsutil ls gs://omniclaw-knowledge-graph/vault/cookies/`
