#!/bin/bash
# Vault Sync Trigger Script
# This script manually triggers the vault sync process

set -e

# Configuration
VAULT_API_URL="http://159.65.10.49:8080"
SYNC_TYPE="manual"
TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%SZ)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
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

# Check if vault API is accessible
check_vault_api() {
    log "Checking vault API accessibility..."
    
    if curl -s -f "$VAULT_API_URL/stats" > /dev/null; then
        log_success "Vault API is accessible"
        return 0
    else
        log_error "Vault API is not accessible"
        return 1
    fi
}

# Get current sync status
get_sync_status() {
    log "Getting current sync status..."
    
    if curl -s "$VAULT_API_URL/stats" | jq . 2>/dev/null; then
        log_success "Successfully retrieved sync status"
    else
        log_warning "Could not retrieve detailed sync status"
    fi
}

# Trigger manual sync
trigger_sync() {
    log "Triggering $SYNC_TYPE sync..."
    
    SYNC_PAYLOAD='{
        "sync_type": "'$SYNC_TYPE'",
        "timestamp": "'$TIMESTAMP'",
        "sources": ["twitter", "instagram"]
    }'
    
    # Try different endpoints
    ENDPOINTS=("/sync/manual" "/trigger-sync" "/api/sync")
    
    for endpoint in "${ENDPOINTS[@]}"; do
        log "Trying endpoint: $endpoint"
        
        if curl -s -X POST \
            -H "Content-Type: application/json" \
            -d "$SYNC_PAYLOAD" \
            "$VAULT_API_URL$endpoint" | jq . 2>/dev/null; then
            log_success "Sync triggered successfully via $endpoint"
            return 0
        fi
    done
    
    log_error "Could not trigger sync through any known endpoint"
    return 1
}

# Monitor sync progress
monitor_sync() {
    log "Monitoring sync progress..."
    
    # Wait a bit for sync to start
    sleep 10
    
    # Check sync status every 30 seconds
    for i in {1..6}; do
        log "Checking sync status (attempt $i/6)..."
        
        if curl -s "$VAULT_API_URL/stats" | jq .nodes 2>/dev/null; then
            log_success "Sync is progressing"
        else
            log_warning "Could not check sync status"
        fi
        
        sleep 30
    done
}

# Main execution
main() {
    log "Starting vault sync process..."
    
    # Check prerequisites
    if ! check_vault_api; then
        log_error "Prerequisites not met. Aborting."
        exit 1
    fi
    
    # Get current status
    get_sync_status
    
    # Trigger sync
    if trigger_sync; then
        log_success "Sync trigger successful"
        
        # Monitor progress (optional)
        read -p "Do you want to monitor sync progress? (y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            monitor_sync
        fi
    else
        log_error "Failed to trigger sync"
        exit 1
    fi
    
    log "Vault sync process completed"
}

# Run main function
main "$@"