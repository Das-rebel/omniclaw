# FinWipe Cloud

Privacy-preserving email forwarding infrastructure for FinWipe.
Free tier: Cloudflare Workers + Mailgun.

## What It Does

```
Gmail Filter (you set up once)
    ↓ FORWARDS all financial emails
Mailgun (free: 5K/month)
    ↓ RECEIVES emails, extracts sender domain ONLY
Cloudflare Worker (free: 100K req/day)
    ↓ MATCHES domains → known FIs
    ↓ STORES discovery in KV (sender domain only)
FinWipe CLI (you run)
    ↓ PULLS discoveries via API
    ↓ CREATES deletion requests
```

## Privacy Guarantee

| Data | Stored? | Where |
|------|---------|-------|
| Email content | ❌ NEVER | N/A |
| Email addresses | ❌ NEVER | N/A |
| Your identity | ❌ NEVER | N/A |
| Sender domain | ✅ Yes | Your KV (only you can read) |
| Subject lines | ✅ Yes | Your KV (only you can read) |
| FI name | ✅ Yes | Your KV (only you can read) |

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  GMAIL FILTER (you configure once)                          │
│  Forward emails matching: bank OR loan OR EMI OR credit      │
│  To: <your-inbox>@inbox.finwipe.in                          │
└──────────────────────────────↓───────────────────────────────┘
                     email forwarded
┌──────────────────────────────────────────────────────────────┐
│  MAILGUN INBOUND (free tier)                                │
│  Receives forwarded email                                    │
│  Parses: sender domain, subject line                        │
│  Forwards metadata to: Cloudflare Worker                     │
│  ⚠️ Email body is NEVER stored                              │
└──────────────────────────────↓───────────────────────────────┘
                     webhook POST
┌──────────────────────────────────────────────────────────────┐
│  CLOUDFLARE WORKER (free tier)                              │
│  Endpoint: POST /api/forward                                │
│  - Verifies Mailgun webhook signature                        │
│  - Matches sender domain against 80+ known Indian FIs       │
│  - Stores in user's KV namespace (identified by hash)        │
│                                                              │
│  Endpoint: GET /api/discoveries?user_id=X&api_key=Y         │
│  - User polls for their discoveries                          │
│  - KV data is private to user's namespace                    │
└──────────────────────────────────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────┐
│  FINWIPE CLI                                                │
│  finwipe setup-forward → generates inbox + user hash        │
│  finwipe sync → fetches discoveries, shows FI list          │
│  finwipe sync --auto → auto-creates deletion requests       │
└──────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Deploy (takes 5 minutes)

```bash
cd apps/finwipe-cloud
./deploy.sh
```

The script will:
- Authenticate with Cloudflare
- Create KV namespace
- Deploy Worker
- Show your worker URL

### 2. Set Up Mailgun (free tier)

1. Sign up at https://mailgun.com (free: 5K emails/month)
2. Go to **Receiving** → **Inbound routes**
3. Create route:
   - **Filter**: `catch_all()`
   - **Forward to**: `https://<your-worker>.workers.dev/api/forward`
   - **Action**: Store and notify

4. Add your domain's MX records (Mailgun will guide you)

Or use **Sandbox mode** (no domain needed):
- In Mailgun dashboard → Receiving → Sandbox domain
- Use: `sandbox+<hash>@mailgun.org` as Gmail forward-to

### 3. Configure Gmail Filter (2 minutes)

```
Gmail → Settings → Filters → Create filter
  Has words: bank OR loan OR EMI OR credit OR insurance OR investment OR mutual fund
  Forward to: <your-inbox>@<your-domain>
  Create filter ✓
```

### 4. Test

```bash
# Check cloud is running
curl https://<your-worker>.workers.dev/api/health

# Set up FinWipe inbox
finwipe init
finwipe setup-forward

# After some emails come in, sync
finwipe sync
```

## API Endpoints

### `GET /api/health`
Health check.

```json
{ "status": "ok", "service": "finwipe-cloud", "timestamp": "..." }
```

### `POST /api/forward`
Mailgun webhook. Receives email metadata only.

**Headers:**
- `Mailgun-Signature` — webhook verification

**Body (form-encoded):**
- `sender` — sender email address
- `subject` — email subject
- `recipient` — your inbox address (user_id extracted from this)

**Response:**
```json
{
  "processed": true,
  "matched": true,
  "userId": "u4a3b2c1d0e",
  "fi": "HDFC Bank",
  "category": "bank"
}
```

### `GET /api/discoveries?user_id=X&api_key=Y`

Fetch all discoveries for a user.

**Response:**
```json
{
  "userId": "u4a3b2c1d0e",
  "count": 12,
  "discoveries": [
    {
      "name": "HDFC Bank",
      "category": "bank",
      "domain": "hdfcbank.com",
      "matchType": "domain",
      "firstSeen": "2026-07-01T...",
      "lastSeen": "2026-07-25T...",
      "count": 47
    }
  ],
  "timestamp": "..."
}
```

**Delete all discoveries:**
```
GET /api/discoveries?user_id=X&api_key=Y&delete=true
```

## Known FI Database

The worker matches against 80+ Indian financial institutions:

- **12 Banks**: HDFC, ICICI, Axis, Kotak, SBI, Yes, IndusInd, IDBI, BoB, PNB, Canara, Federal, RBL, Bandhan
- **20+ NBFCs**: Bajaj Finserv, Tata Capital, Aditya Birla Finance, L&T Finance, Muthoot, Cholamandalam, HDB, Stashfin, Rupeek, KreditBee, Navi, OfBusiness, EarlySalary, Slice, Uni, Moneyview
- **15+ Fintechs**: PhonePe, Paytm, CRED, Paisabazaar, BankBazaar, IndMoney, Groww, Zerodha, Upstox, Angel One, PolicyBazaar
- **15+ Insurers**: LIC, HDFC Life, SBI Life, ICICI Prudential, Bajaj Allianz, TATA AIA, Max Life, Star Health, Niva Bupa, Digit, HDFC ERGO, Tata AIG
- **Brokers/Demat**: CDSL, NSDL, KFintech

## Environment Variables

Set via `npx wrangler secret put`:

| Variable | Description |
|----------|-------------|
| `MAILGUN_WEBHOOK_KEY` | Mailgun webhook verification key |

## Free Tier Limits

| Service | Free Tier |
|---------|-----------|
| Cloudflare Workers | 100K requests/day, 10ms CPU/req |
| Cloudflare KV | 1M reads/day, 1K writes/day, 1GB |
| Mailgun | 5,000 emails/month |

For personal use, this is effectively unlimited.

## Cost (if exceeded)

| Service | Paid Tier |
|---------|-----------|
| Cloudflare Workers | $5/month for 10M requests |
| Cloudflare KV | $5/month for 1GB |
| Mailgun | $50/month for 50K emails |

## Troubleshooting

**Cloud not receiving emails:**
```bash
# Test webhook manually
curl -X POST https://<worker>.workers.dev/api/forward \
  -d "sender=test@hdfcbank.com" \
  -d "subject=EMI Statement" \
  -d "recipient=u123@inbox.finwipe.in"
```

**Worker not deploying:**
```bash
# Check for errors
npx wrangler deploy --env production --verbose

# Test locally first
npx wrangler dev --env production
```

**KV data not persisting:**
```bash
# Check KV
npx wrangler kv key list --env production

# Manual delete
npx wrangler kv key delete <key> --env production
```

## Security Notes

1. **Webhook verification**: Mailgun webhooks are signed with HMAC-SHA256. Set `MAILGUN_WEBHOOK_KEY` in Cloudflare secrets.

2. **User isolation**: Each user is identified by a SHA256 hash of their email + salt. The cloud never sees your actual email.

3. **No PII stored**: Even if Cloudflare is compromised, the KV only contains:
   - Anonymized user hash
   - FI names and domains
   - Email counts

4. **Data deletion**: User can delete all their data at any time via `finwipe sync --delete` or the API `?delete=true` parameter.
