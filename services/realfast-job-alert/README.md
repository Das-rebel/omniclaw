# RealFast AI Job Alert Service

Automated daily job matching service that queries RealFast AI for positions matching Subhajit Das's profile and sends email alerts.

## Features

- **Daily automated job matching** via GCP Cloud Scheduler
- **Smart scoring algorithm** based on skills, title keywords, location, and domain
- **Duplicate prevention** - won't alert for positions seen in previous runs
- **Beautiful HTML emails** with match scores and reasoning
- **GCP Cloud Run deployment** for reliability and cost efficiency

## Prerequisites

1. **Node.js 18+** locally for testing
2. **GCP account** with Cloud Run and Cloud Scheduler APIs enabled
3. **Gmail App Password** (not regular password) - see setup below

## Setup Instructions

### 1. Generate Gmail App Password

Gmail requires an "App Password" for third-party apps (not your regular password):

1. Go to [Google Account Security](https://myaccount.google.com/security)
2. Enable **2-Step Verification** if not already enabled
3. Navigate to **App passwords** (under "Signing in to Google")
4. Select app: "Mail", Select device: "Other (Custom name)"
5. Enter "RealFast Job Alert" and click Generate
6. **Copy the 16-character password** - you'll need this for the next step
7. The password looks like: `abcd efgh ijkl mnop` (with spaces)

### 2. Local Development Setup

```bash
cd services/realfast-job-alert

# Copy environment template
cp .env.example .env

# Edit .env with your Gmail App Password
nano .env

# Test locally
npm install
npm start
```

### 3. Deploy to GCP Cloud Run

```bash
# Build and push container
gcloud builds submit \
  --tag gcr.io/PROJECT_ID/realfast-job-alert:latest \
  --project PROJECT_ID

# Deploy to Cloud Run
gcloud run deploy realfast-job-alert \
  --image gcr.io/PROJECT_ID/realfast-job-alert:latest \
  --platform managed \
  --region asia-south1 \
  --allow-unauthenticated \
  --port 8080 \
  --memory 256Mi \
  --cpu 1 \
  --max-instances 1 \
  --min-instances 0 \
  --project PROJECT_ID

# Make note of the service URL, e.g.:
# https://realfast-job-alert-xxxxx.asia-south1.run.app
```

### 4. Set Up Cloud Scheduler

After deploying, run the setup script:

```bash
chmod +x cloud-scheduler-setup.sh
./cloud-scheduler-setup.sh
```

Or manually:

```bash
# Create service account with Cloud Run Invoker role
gcloud iam service-accounts create realfast-job-alert \
  --display-name "RealFast Job Alert" \
  --project PROJECT_ID

gcloud projects add-iam-policy-binding PROJECT_ID \
  --member "serviceAccount:realfast-job-alert@PROJECT_ID.iam.gserviceaccount.com" \
  --role "roles/run.invoker"

# Create the daily cron job at 9 AM IST
gcloud scheduler jobs create http realfast-job-alert-daily \
  --schedule "0 9 * * *" \
  --uri "SERVICE_URL" \
  --http-method POST \
  --headers "Content-Type=application/json" \
  --message-body "{}" \
  --time-zone "Asia/Kolkata" \
  --description "Daily RealFast AI job alert for Subhajit" \
  --project PROJECT_ID
```

## Matching Logic

Positions are scored (0-100) based on:

| Factor | Weight | Description |
|--------|--------|-------------|
| Title keywords | 25 pts each | growth, strategy, partnerships, AI, product, fintech |
| Skills match | 15 pts each | lending, fintech, marketing, CRM, AI/ML, etc. |
| Location | 10 pts | Bangalore, India, Remote, Hybrid |
| Seniority | 5 pts | Lead/Manager/Director level roles |
| Fintech domain | 10 pts | Fintech/Banking/Lending company or description |

**Minimum threshold: 30 points** for email alert.

## File Structure

```
realfast-job-alert/
├── index.js           # Main service (fetch, score, email)
├── package.json       # Dependencies
├── Dockerfile         # Cloud Run container
├── .env.example       # Environment template
├── .env               # Your secrets (git-ignored)
├── .gitignore         # Excludes .env and logs/
├── README.md          # This file
├── cloud-scheduler-setup.sh  # GCP scheduler setup
└── previous_positions.json   # Position tracking (auto-created)
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SMTP_HOST` | smtp.gmail.com | Gmail SMTP server |
| `SMTP_PORT` | 465 | SSL port (or 587 for TLS) |
| `SMTP_SECURE` | true | Use SSL/TLS |
| `SMTP_USER` | sdas22@gmail.com | Your Gmail address |
| `SMTP_PASS` | (required) | 16-char Gmail App Password |
| `EMAIL_FROM` | sdas22@gmail.com | From address |
| `EMAIL_TO` | sdas22@gmail.com | To address |

## Testing

```bash
# Test the service locally
npm test

# Or run manually
node index.js

# Check logs
tail -f alert.log
```

## Troubleshooting

### "535 Authentication failed"
- **Cause**: Wrong password or Gmail blocking
- **Fix**: Generate a new App Password and ensure 2-Step Verification is enabled

### "MCP request failed"
- **Cause**: RealFast AI MCP endpoint issue
- **Fix**: Check if the endpoint `https://join.realfast.ai/mcp/core` is accessible

### Cloud Scheduler not triggering
- **Cause**: Service account lacks permissions
- **Fix**: Ensure service account has `roles/run.invoker` on the Cloud Run service

### No positions found
- **Cause**: RealFast may have returned empty list
- **Fix**: Check `alert.log` for MCP response details

## Monitoring

- **Cloud Run logs**: `gcloud run logs read realfast-job-alert --region asia-south1`
- **Scheduler logs**: `gcloud scheduler jobs list` to see last run status
- **Local logs**: `tail -f alert.log` in the service directory