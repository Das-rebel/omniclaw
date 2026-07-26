#!/bin/bash
# Vault Sync Deployment Script - SINGLE SYNC MODE
# Deploys the vault sync service with SINGLE PROCESSING to avoid blocking

set -e

# Configuration
PROJECT_ID="[YOUR_GCP_PROJECT_ID]"
REGION="asia-south1"
SERVICE_NAME="vault-sync-single"
IMAGE_NAME="vault-sync"
VAULT_API_URL="https://serve-vault-search-338789220059.asia-south1.run.app"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging function
log() {
    echo -e "${NC}[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log_error() {
    echo -e "${RED}[ERROR] $1${NC}"
}

log_success() {
    echo -e "${GREEN}[SUCCESS] $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}[WARNING] $1${NC}"
}

log_info() {
    echo -e "${BLUE}[INFO] $1${NC}"
}

# Check prerequisites
check_prerequisites() {
    log "Checking prerequisites..."
    
    # Check gcloud
    if ! command -v gcloud &> /dev/null; then
        log_error "gcloud CLI is not installed"
        exit 1
    fi
    
    # Check project
    gcloud config get-value project | grep -q "$PROJECT_ID" || {
        log_warning "Project $PROJECT_ID not active. Setting project..."
        gcloud config set project "$PROJECT_ID" || {
            log_error "Failed to set project to $PROJECT_ID"
            exit 1
        }
    }
    
    # Check region
    gcloud compute regions describe "$REGION" &> /dev/null || {
        log_error "Region $REGION not available"
        exit 1
    }
    
    log_success "Prerequisites met"
}

# Build Docker image
build_image() {
    log "Building Docker image for SINGLE SYNC mode..."
    
    IMAGE_TAG="us-central1-docker.pkg.dev/$PROJECT_ID/omniclaw/$IMAGE_NAME:latest"
    
    docker build -f /Users/Subho/omniclaw/services/vault-sync/Dockerfile \
        -t "$IMAGE_TAG" \
        /Users/Subho/omniclaw/services/vault-sync || {
        log_error "Failed to build Docker image"
        exit 1
    }
    
    docker push "$IMAGE_TAG" || {
        log_error "Failed to push Docker image"
        exit 1
    }
    
    log_success "Docker image built and pushed: $IMAGE_TAG"
}

# Deploy Cloud Run service for SINGLE SYNC
deploy_service() {
    log "Deploying Cloud Run service (SINGLE SYNC mode)..."
    
    IMAGE_TAG="us-central1-docker.pkg.dev/$PROJECT_ID/omniclaw/$IMAGE_NAME:latest"
    
    gcloud run deploy "$SERVICE_NAME" \
        --image "$IMAGE_TAG" \
        --platform=managed \
        --region="$REGION" \
        --no-allow-unauthenticated \
        --memory=256Mi \
        --cpu=500m \
        --max-instances=1 \
        --min-instances=0 \
        --set-env-vars="GCP_PROJECT=$PROJECT_ID,VAULT_API_URL=$VAULT_API_URL,SYNC_INTERVAL=86400" \
        --set-secrets="INSTAGRAM_USERNAME=instagram-credentials:username,TWITTER_USERNAME=twitter-credentials:username" \
        --labels="app=vault-sync,sync=single,processing_mode=single_processing" \
        --format="value(status.url)" || {
        log_error "Failed to deploy Cloud Run service"
        exit 1
    }
    
    log_success "Cloud Run service deployed (SINGLE SYNC mode)"
}

# Configure Cloud Scheduler (SINGLE JOB)
setup_scheduler() {
    log "Setting up Cloud Scheduler (SINGLE JOB mode)..."
    
    # Service URL
    SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
        --platform=managed \
        --region="$REGION" \
        --format="status.url")
    
    if [ -z "$SERVICE_URL" ]; then
        log_error "Could not get service URL"
        exit 1
    fi
    
    log_info "Service URL: $SERVICE_URL"
    
    # Create SINGLE daily job (at 1 AM IST to avoid peak hours)
    log "Creating daily sync job (1 AM IST)..."
    
    gcloud scheduler jobs create http vault-sync-single-daily \
        --schedule="0 1 * * *" \
        --http-method=POST \
        --uri="$SERVICE_URL" \
        --oauth-service-account-email="$PROJECT_ID@appspot.gserviceaccount.com" \
        --oidc-service-account-email="$PROJECT_ID@appspot.gserviceaccount.com" \
        --time-zone="Asia/Kolkata" \
        --attempt-deadline=30s \
        --max-backoff=300s \
        --max-retry-attempts=1 \
        --description="Single daily sync with single processing to avoid blocking" || {
        log_warning "Daily job already exists or failed to create"
    }
    
    log_success "Cloud Scheduler configured (SINGLE JOB mode)"
}

# Remove any existing hourly jobs
remove_hourly_jobs() {
    log "Removing existing hourly jobs to prevent blocking..."
    
    if gcloud scheduler jobs describe vault-sync-hourly &> /dev/null; then
        gcloud scheduler jobs delete vault-sync-hourly --quiet
        log_success "Removed hourly sync job"
    fi
    
    if gcloud scheduler jobs describe vault-sync-daily &> /dev/null; then
        gcloud scheduler jobs describe vault-sync-daily --quiet
        log_success "Removed daily sync job"
    fi
}

# Verify deployment
verify_deployment() {
    log "Verifying deployment..."
    
    # Check Cloud Run service
    log_info "Checking Cloud Run service..."
    SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
        --platform=managed \
        --region="$REGION" \
        --format="status.url")
    
    if [ -z "$SERVICE_URL" ]; then
        log_error "Cloud Run service not found"
        exit 1
    fi
    
    log_info "Service URL: $SERVICE_URL"
    
    # Check if service is responding
    if curl -f -s "$SERVICE_URL" > /dev/null; then
        log_success "Cloud Run service is responding"
    else
        log_warning "Cloud Run service is not responding"
    fi
    
    # Check scheduler job
    log_info "Checking scheduler job..."
    
    if gcloud scheduler jobs describe vault-sync-single-daily &> /dev/null; then
        log_success "Single daily scheduler job exists"
    else
        log_error "Single daily scheduler job not found"
        exit 1
    fi
    
    # Verify no hourly jobs exist
    if gcloud scheduler jobs describe vault-sync-hourly &> /dev/null; then
        log_error "Hourly job still exists - this will cause blocking!"
        exit 1
    fi
    
    log_success "Deployment verification completed"
}

# Main execution
main() {
    log "Starting vault sync deployment (SINGLE SYNC mode)..."
    
    # Check prerequisites
    check_prerequisites
    
    # Remove existing blocking jobs
    remove_hourly_jobs
    
    # Build and deploy
    build_image
    deploy_service
    setup_scheduler
    
    # Verify
    verify_deployment
    
    log_success "Vault sync deployment completed successfully (SINGLE SYNC mode)!"
    log_info "Service URL: $SERVICE_URL"
    log_info "Schedule: Daily at 1 AM IST (Asia/Kolkata)"
    log_info "Processing: Single processing to avoid blocking"
    log_info "Next sync: Tomorrow at 1:00 AM IST"
}

# Run main function
main "$@"