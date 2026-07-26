#!/bin/bash
# FinWipe Cloud — Deployment Script
# Sets up Cloudflare Worker + Mailgun inbound email
# Free tier: Cloudflare Workers (100K req/day) + Mailgun (5K emails/month)

set -e

echo "╔════════════════════════════════════════════════════════════╗"
echo "║         FinWipe Cloud — Deployment                    ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo

# Check prerequisites
command -v npx >/dev/null 2>&1 || { echo "❌ npx required (install Node.js)"; exit 1; }

echo "📋 PREREQUISITES:"
echo "   1. Cloudflare account (free: https://dash.cloudflare.com)"
echo "   2. Mailgun account (free: https://mailgun.com)"
echo "   3. A domain (optional — can use workers.dev subdomain)"
echo

# ─────────────────────────────────────────────────────────────────
# STEP 1: Authenticate with Cloudflare
# ─────────────────────────────────────────────────────────────────
echo "────────────────────────────────────────────────────────────────"
echo "STEP 1 — Cloudflare Authentication"
echo "────────────────────────────────────────────────────────────────"
if npx wrangler whoami >/dev/null 2>&1; then
    echo "   ✅ Already logged in to Cloudflare"
else
    echo "   Opening browser for login..."
    npx wrangler login
    echo "   After login, run this script again"
    exit 0
fi

# ─────────────────────────────────────────────────────────────────
# STEP 2: Create KV namespace
# ─────────────────────────────────────────────────────────────────
echo
echo "────────────────────────────────────────────────────────────────"
echo "STEP 2 — Create KV Namespace"
echo "────────────────────────────────────────────────────────────────"

# Create namespace and extract ID
KV_OUTPUT=$(npx wrangler kv namespace create finwipe_kv --env production 2>&1 || true)
echo "$KV_OUTPUT"

KV_ID=$(echo "$KV_OUTPUT" | grep -oP '(?<="id":")[^"]+' | head -1)
if [ -z "$KV_ID" ]; then
    echo "   ⚠️  Could not auto-detect KV ID"
    echo "   The namespace was created. Look for 'id' in the output above"
    echo "   Or run: npx wrangler kv namespace list"
    KV_ID="YOUR_KV_ID"
else
    echo "   ✅ KV Namespace ID: $KV_ID"
fi

# ─────────────────────────────────────────────────────────────────
# STEP 3: Update wrangler.toml with KV ID
# ─────────────────────────────────────────────────────────────────
echo
echo "────────────────────────────────────────────────────────────────"
echo "STEP 3 — Update wrangler.toml"
echo "────────────────────────────────────────────────────────────────"
if [ "$KV_ID" != "YOUR_KV_ID" ]; then
    # Update production env with KV id
    sed -i '' "s/id = \"PENDING_CREATE\"/id = \"$KV_ID\"/" wrangler.toml
    echo "   ✅ Updated wrangler.toml with KV ID"
else
    echo "   ⚠️  Manually update wrangler.toml:"
    echo "      Change: id = \"PENDING_CREATE\""
    echo "      To:     id = \"<your-kv-id>\""
fi

# ─────────────────────────────────────────────────────────────────
# STEP 4: Deploy Worker
# ─────────────────────────────────────────────────────────────────
echo
echo "────────────────────────────────────────────────────────────────"
echo "STEP 4 — Deploy Cloudflare Worker"
echo "────────────────────────────────────────────────────────────────"
echo "   Worker URL will be: https://finwipe-cloud.<account>.workers.dev"
echo "   Or set custom domain in Cloudflare dashboard"
echo
read -p "   Deploy now? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    npx wrangler deploy --env production
    echo "   ✅ Deployed!"
fi

# ─────────────────────────────────────────────────────────────────
# STEP 5: Get worker URL
# ─────────────────────────────────────────────────────────────────
echo
echo "────────────────────────────────────────────────────────────────"
echo "STEP 5 — Get Your Cloud Endpoint"
echo "────────────────────────────────────────────────────────────────"
WORKER_URL=$(npx wrangler deployments list --env production 2>&1 | grep -oP 'https://[^ ]+workers\.dev' | head -1)
if [ -z "$WORKER_URL" ]; then
    echo "   ⚠️  Could not auto-detect worker URL"
    echo "   Check Cloudflare dashboard or run: npx wrangler deployments list"
    echo "   Format: https://finwipe-cloud.<account>.workers.dev"
    WORKER_URL="https://finwipe-cloud.YOUR_ACCOUNT.workers.dev"
else
    echo "   ✅ Worker URL: $WORKER_URL"
fi

# ─────────────────────────────────────────────────────────────────
# STEP 6: Mailgun Setup
# ─────────────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════════════════════════════"
echo "STEP 6 — Mailgun Inbound Email (free tier)"
echo "════════════════════════════════════════════════════════════════"
echo
echo "   Mailgun free: 5,000 emails/month"
echo
echo "   a) Go to: https://app.mailgun.com/app/inbox"
echo "   b) Create a inbox: e.g., finwipe@YOUR_DOMAIN"
echo "   c) Set up DNS MX records for YOUR_DOMAIN pointing to Mailgun"
echo
echo "   OR use Mailgun's sandbox mode (no domain required):"
echo "   - In Mailgun dashboard → Receiving → Sandbox domain"
echo "   - Use: sandboxID.mailgun.org (provided by Mailgun)"
echo
read -p "   Enter your Mailgun inbound email domain (or 'sandbox'): " MAILGUN_DOMAIN
echo
if [ "$MAILGUN_DOMAIN" = "sandbox" ] || [ -z "$MAILGUN_DOMAIN" ]; then
    echo "   Using sandbox mode"
    echo "   Add this as Gmail forward-to address:"
    echo "   sandbox+<your_hash>@mailgun.org"
else
    echo "   Set up Mailgun route to forward ALL emails to:"
    echo "   $WORKER_URL/api/forward"
fi

# ─────────────────────────────────────────────────────────────────
# STEP 7: Update FinWipe CLI config
# ─────────────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════════════════════════════"
echo "STEP 7 — Configure FinWipe CLI"
echo "════════════════════════════════════════════════════════════════"
CLOUD_ENDPOINT=${WORKER_URL:-"https://finwipe-cloud.YOUR_ACCOUNT.workers.dev"}
echo "   Your FinWipe cloud endpoint:"
echo "   $CLOUD_ENDPOINT"
echo
echo "   Run: finwipe setup-forward"
echo "   This will generate your unique inbox address"
echo

# ─────────────────────────────────────────────────────────────────
# COMPLETE!
# ─────────────────────────────────────────────────────────────────
echo "╔════════════════════════════════════════════════════════════╗"
echo "║         SETUP COMPLETE                                  ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo
echo "NEXT STEPS:"
echo "   1. finwipe init                      # If not done"
echo "   2. finwipe setup-forward             # Get your inbox address"
echo "   3. Set Gmail filter → forward to inbox"
echo "   4. finwipe sync                      # Pull discoveries"
echo
echo "TEST THE CLOUD:"
echo "   curl ${CLOUD_ENDPOINT}/api/health"
echo
echo "DOCUMENTATION:"
echo "   apps/finwipe-cloud/README.md"
