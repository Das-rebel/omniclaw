#!/bin/bash
# ============================================================
# RealFast Job Alert - Cloud Scheduler Setup
# ============================================================
# This script creates a GCP Cloud Scheduler job to trigger
# the RealFast Job Alert service daily at 9 AM IST.
#
# Usage:
#   chmod +x cloud-scheduler-setup.sh
#   ./cloud-scheduler-setup.sh
#
# Prerequisites:
#   - GCP SDK installed and configured (gcloud auth login)
#   - Cloud Run service already deployed
#   - PROJECT_ID and SERVICE_URL environment variables set
# ============================================================

set -e

# ---------- Configuration ----------
PROJECT_ID="${PROJECT_ID:-}"
SERVICE_URL="${SERVICE_URL:-}"
TIMEZONE="Asia/Kolkata"
SCHEDULE="0 9 * * *"  # 9:00 AM daily
JOB_NAME="realfast-job-alert-daily"
DESCRIPTION="Daily RealFast AI job alert trigger for Subhajit Das"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ---------- Helper Functions ----------
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_command() {
    if ! command -v gcloud &> /dev/null; then
        log_error "gcloud CLI not found. Install Google Cloud SDK: https://cloud.google.com/sdk/docs/install"
        exit 1
    fi
}

# ---------- Main Setup ----------
main() {
    echo "=========================================="
    echo "RealFast Job Alert - Cloud Scheduler Setup"
    echo "=========================================="
    echo ""

    # Check gcloud
    check_command
    
    # Get project ID if not set
    if [ -z "$PROJECT_ID" ]; then
        PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
        if [ -z "$PROJECT_ID" ]; then
            log_error "PROJECT_ID not set. Either pass it or run: gcloud config set project YOUR_PROJECT_ID"
            exit 1
        fi
        log_info "Using project: $PROJECT_ID"
    fi

    # Get service URL if not set
    if [ -z "$SERVICE_URL" ]; then
        log_warn "SERVICE_URL not provided"
        log_info "Deploy the Cloud Run service first, then run this script with:"
        log_info "  SERVICE_URL=https://realfast-job-alert-xxxx.asia-south1.run.app ./cloud-scheduler-setup.sh"
        echo ""
        
        # Try to find existing service
        EXISTING_URL=$(gcloud run services describe realfast-job-alert --region asia-south1 --format 'value(status.url)' 2>/dev/null || true)
        if [ -n "$EXISTING_URL" ]; then
            log_info "Found existing service: $EXISTING_URL"
            SERVICE_URL="$EXISTING_URL"
        else
            log_error "No existing service found. Deploy the service first."
            exit 1
        fi
    fi

    echo ""
    log_info "Configuration:"
    echo "  Project: $PROJECT_ID"
    echo "  Service URL: $SERVICE_URL"
    echo "  Schedule: $SCHEDULE ($TIMEZONE)"
    echo ""

    # ---------- Create Service Account ----------
    SA_EMAIL="realfast-job-alert@${PROJECT_ID}.iam.gserviceaccount.com"
    
    log_info "Creating service account..."
    gcloud iam service-accounts create realfast-job-alert \
        --display-name "RealFast Job Alert" \
        --project "$PROJECT_ID" 2>/dev/null || log_warn "Service account may already exist"

    log_info "Granting Cloud Run Invoker role..."
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member "serviceAccount:$SA_EMAIL" \
        --role "roles/run.invoker" \
        --project "$PROJECT_ID" 2>/dev/null || log_warn "Role binding may already exist"

    # ---------- Create Scheduler Job ----------
    log_info "Creating Cloud Scheduler job..."
    
    # Delete existing job if it exists (idempotent)
    gcloud scheduler jobs delete "$JOB_NAME" \
        --project "$PROJECT_ID" \
        --quiet 2>/dev/null || true

    # Create the HTTP job
    gcloud scheduler jobs create http "$JOB_NAME" \
        --schedule "$SCHEDULE" \
        --uri "$SERVICE_URL" \
        --http-method POST \
        --headers "Content-Type=application/json" \
        --message-body "{}" \
        --time-zone "$TIMEZONE" \
        --description "$DESCRIPTION" \
        --project "$PROJECT_ID"

    log_info "Cloud Scheduler job created successfully!"
    echo ""

    # ---------- Verification ----------
    log_info "Verifying setup..."
    echo ""
    
    echo "--- Cloud Run Service ---"
    gcloud run services describe realfast-job-alert \
        --region asia-south1 \
        --format "table(status.url,status.conditions[0].status,metadata.name)"

    echo ""
    echo "--- Scheduler Job ---"
    gcloud scheduler jobs describe "$JOB_NAME" \
        --project "$PROJECT_ID" \
        --format "table(name,schedule,state,httpTarget.uri)"

    echo ""
    echo "=========================================="
    log_info "Setup complete!"
    echo ""
    echo "The job will run daily at 9 AM IST."
    echo "To test manually: gcloud scheduler jobs run $JOB_NAME --project $PROJECT_ID"
    echo "To view logs: gcloud run logs read realfast-job-alert --region asia-south1"
    echo "=========================================="
}

# Run main
main "$@"