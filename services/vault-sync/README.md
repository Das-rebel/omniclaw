# Vault Sync Service - SINGLE SYNC MODE

The Vault Sync Service automates the process of syncing bookmarks from Twitter and Instagram to the Omniclaw vault search index using **SINGLE SYNC with SINGLE PROCESSING** to avoid blocking issues.

## ⚠️ Important: SINGLE SYNC Mode

This implementation follows your requirement to **avoid blocking issues**:
- **Only ONE sync per day** (at 1 AM IST)
- **SINGLE processing** of items to prevent API blocking
- **Limited timeframe** (last 3 days only)
- **No hourly sync** to prevent overload

## Overview

- **Purpose**: Automatically sync social media bookmarks to the vault search system
- **Schedule**: **Once per day** at 1:00 AM IST (avoiding peak hours)
- **Sources**: Twitter, Instagram
- **Processing**: SINGLE PROCESSING mode (one item at a time)
- **Timeframe**: Last 3 days only to reduce load

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Twitter API   │───▶│  Vault Sync     │───▶│  Vault Search   │
│   (Limited to   │    │     Service     │    │     Index        │
│    last 3 days)  │    │ (SINGLE SYNC)   │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                              │
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│ Instagram API   │───▶│                 │    │                 │
│   (Limited to   │    │                 │    │                 │
│    last 3 days)  │    │                 │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## Key Features

### 🔒 SINGLE SYNC Mode (No Blocking)
- **Daily Sync**: Only once per day at 1:00 AM IST
- **Single Processing**: Items processed one by one with 1-second delays
- **Limited Timeframe**: Only last 3 days of bookmarks to reduce API load
- **Short Timeouts**: 30-second timeout per item to prevent hanging

### 🛡️ Blocking Prevention
- **No Hourly Sync**: Eliminates blocking from frequent requests
- **Processing Delays**: 1-second delay between items
- **Timeout Controls**: Short timeouts prevent hanging
- **Retry Limit**: Maximum 1 retry only
- **Resource Limits**: Minimal CPU/memory usage

## Deployment

### Prerequisites

1. GCP Project with enabled APIs
2. Cloud Run enabled
3. Secret Manager configured
4. Twitter/Instagram API credentials

### Quick Deployment

```bash
# Update the deployment script with your project ID
sed -i 's/\[YOUR_GCP_PROJECT_ID\]/your-project-id/g' scripts/deploy-vault-sync.sh

# Deploy the service (SINGLE SYNC mode)
chmod +x scripts/deploy-vault-sync.sh
./scripts/deploy-vault-sync.sh
```

### Manual Deployment

```bash
# Build and push Docker image
gcloud builds submit --tag us-central1-docker.pkg.dev/PROJECT_ID/omniclaw/vault-sync:latest

# Deploy Cloud Run service
gcloud run deploy vault-sync-single \
  --image us-central1-docker.pkg.dev/PROJECT_ID/omniclaw/vault-sync:latest \
  --platform managed \
  --region asia-south1 \
  --memory 256Mi \
  --cpu 500m \
  --max-instances 1 \
  --set-env-vars GCP_PROJECT=PROJECT_ID,VAULT_API_URL=https://serve-vault-search-338789220059.asia-south1.run.app,SYNC_INTERVAL=86400

# Set up Cloud Scheduler (SINGLE JOB)
gcloud scheduler jobs create http vault-sync-single-daily \
  --schedule "0 1 * * *" \
  --http-method POST \
  --uri $(gcloud run services describe vault-sync-single --platform managed --region asia-south1 --format='status.url') \
  --time-zone Asia/Kolkata \
  --max-retry-attempts 1
```

## Configuration

### Environment Variables

- `GCP_PROJECT`: Google Cloud project ID
- `VAULT_API_URL`: URL of the vault search API
- `SYNC_INTERVAL`: 86400 (24 hours) - **No hourly sync**
- `INSTAGRAM_USERNAME`: Instagram username
- `TWITTER_USERNAME`: Twitter username

### Secret Manager Secrets

- `twitter-api-key`: Twitter API key
- `twitter-api-secret`: Twitter API secret
- `twitter-access-token`: Twitter access token
- `twitter-access-token-secret`: Twitter access token secret
- `instagram-password`: Instagram password

## Testing

### Run Tests

```bash
# Test the sync functionality (SINGLE PROCESSING mode)
python scripts/test-vault-sync.py

# Trigger manual emergency sync (SINGLE PROCESSING mode)
python scripts/emergency-sync.py

# Just check health
python scripts/emergency-sync.py health
```

### Test Endpoints

- **Health Check**: `GET /health`
- **Ready Check**: `GET /ready`
- **Sync Status**: `GET /stats`
- **Manual Trigger**: `POST /sync/manual` (emergency use only)

## Monitoring

### Metrics

- `vault_sync_duration`: Time taken for sync operations
- `vault_sync_count`: Number of items synced (limited to ~6 items)
- `vault_sync_errors`: Number of sync errors

### Alerts

- **Sync Failure**: Alerts when sync jobs fail
- **Vault API Uptime**: Monitors vault service availability
- **Performance Degradation**: Alerts for slow sync operations

### Logs

Sync logs are available in:
- Cloud Run service logs
- Cloud Logging sink
- BigQuery export for long-term analysis

## Troubleshooting

### Common Issues

1. **Sync not running**
   - Check Cloud Scheduler job status
   - Verify Cloud Run service health
   - Check IAM permissions

2. **No bookmarks synced**
   - Verify API credentials in Secret Manager
   - Check for rate limits
   - Review sync logs for errors

3. **Vault API errors**
   - Check vault service health
   - Verify API connectivity
   - Review network policies

### Debug Commands

```bash
# Check service status
gcloud run services describe vault-sync-single --platform managed --region asia-south1

# Check scheduler job
gcloud scheduler jobs describe vault-sync-single-daily

# View logs
gcloud logging read "resource.type=cloud_run_service AND serviceName=vault-sync-single"

# Test vault API
curl -s https://serve-vault-search-338789220059.asia-south1.run.app/stats
```

## Scaling

- **Horizontal Scaling**: Limited to 1 instance to prevent overload
- **Vertical Scaling**: Minimal resources (500m CPU, 256Mi memory)
- **Rate Limiting**: Built-in single retry and processing delays
- **Timeframe Limitation**: Only 3 days of bookmarks to reduce load

## Security

- **Authentication**: OAuth 2.0 for Google Cloud services
- **Authorization**: IAM roles and permissions
- **Secret Management**: Secret Manager for sensitive credentials
- **Network Security**: VPC Service Controls (if configured)

## Support

For issues and questions:
- Check the troubleshooting section
- Review Cloud Run logs
- Monitor Cloud Scheduler status
- Contact the development team

## Schedule

- **Sync Time**: 1:00 AM IST daily
- **Processing Mode**: Single processing with 1-second delays
- **Timeframe**: Last 3 days only
- **Retry Limit**: Maximum 1 retry only
- **No Hourly Sync**: Prevents blocking issues