#!/usr/bin/env python3
"""
Emergency Vault Sync Script - SINGLE PROCESSING MODE
Manual sync for when the cron job fails - SINGLE PROCESSING to avoid blocking
"""

import asyncio
import json
import logging
import sys
from datetime import datetime, timedelta

import requests

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class EmergencyVaultSync:
    def __init__(self):
        self.vault_api_url = "http://159.65.10.49:8080"
        self.sync_interval = 86400  # 24 hours
        self.processing_delay = 1  # 1 second delay between items

    def get_stats(self):
        """Get current vault statistics"""
        try:
            response = requests.get(f"{self.vault_api_url}/stats")
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logger.error(f"Failed to get stats: {e}")
            return None

    def get_recent_bookmarks(self, days=3):
        """Get recent bookmarks - SINGLE PROCESSING MODE"""
        # This is a placeholder - in production, you'd call Twitter/Instagram APIs
        # Only fetch last 3 days to reduce load
        mock_bookmarks = [
            {
                'id': f'mock_tweet_{i}',
                'content': f'Mock tweet content {i} - SINGLE PROCESSING MODE',
                'timestamp': (datetime.utcnow() - timedelta(days=min(i, 3))).isoformat(),
                'type': 'twitter_tweet',
                'url': f'https://twitter.com/user/status/mock_tweet_{i}',
                'metadata': {
                    'categories': ['bookmark', 'social_media'],
                    'source': 'twitter',
                    'processing_mode': 'single_processing'
                }
            }
            for i in range(1, min(6, days + 1))  # Limit to 6 items
        ]
        return mock_bookmarks

    def process_single_item(self, item):
        """Process a single item with timeout to avoid blocking"""
        try:
            response = requests.post(
                f"{self.vault_api_url}/add",
                json=item,
                headers={'Content-Type': 'application/json'},
                timeout=30  # Short timeout to prevent blocking
            )
            response.raise_for_status()
            logger.info(f"✅ Successfully processed: {item['id']}")
            return True
        except Exception as e:
            logger.error(f"❌ Failed to process {item['id']}: {e}")
            return False

    def add_bookmarks_to_vault_single_processing(self, bookmarks):
        """Add bookmarks to vault with SINGLE PROCESSING to avoid blocking"""
        logger.info(f"🔧 Starting single processing of {len(bookmarks)} items...")
        
        success_count = 0
        for i, bookmark in enumerate(bookmarks, 1):
            logger.info(f"📝 Processing item {i}/{len(bookmarks)}: {bookmark['id']}")
            
            if self.process_single_item(bookmark):
                success_count += 1
                
                # Add delay between items to prevent blocking
                if i < len(bookmarks):  # Don't delay after last item
                    import time
                    time.sleep(self.processing_delay)
                
                # Log progress
                if i % 5 == 0:
                    logger.info(f"📊 Progress: {i}/{len(bookmarks)} items processed")
        
        logger.info(f"✅ Single processing completed: {success_count}/{len(bookmarks)} items")
        return success_count

    def emergency_sync(self):
        """Perform emergency sync with SINGLE PROCESSING"""
        logger.info("🔧 Starting emergency vault sync (SINGLE PROCESSING mode)...")

        # Get current stats
        stats = self.get_stats()
        if stats:
            logger.info(f"📊 Current vault stats: {stats}")
        else:
            logger.warning("⚠️ Could not retrieve vault stats")

        # Get recent bookmarks (limited to 3 days, max 6 items)
        logger.info("🔍 Fetching recent bookmarks (SINGLE PROCESSING mode)...")
        bookmarks = self.get_recent_bookmarks()
        logger.info(f"📁 Found {len(bookmarks)} recent bookmarks")

        if not bookmarks:
            logger.info("ℹ️ No new bookmarks to process")
            return 0

        # Add to vault with SINGLE PROCESSING
        logger.info("🚀 Adding bookmarks to vault (SINGLE PROCESSING mode)...")
        success_count = self.add_bookmarks_to_vault_single_processing(bookmarks)
        logger.info(f"✅ Successfully processed {success_count}/{len(bookmarks)} bookmarks")

        # Get final stats
        final_stats = self.get_stats()
        if final_stats:
            logger.info(f"📈 Final vault stats: {final_stats}")

        return success_count

    def check_sync_health(self):
        """Check if sync is working correctly"""
        logger.info("🔍 Checking sync health (SINGLE PROCESSING mode)...")

        # Check vault API
        try:
            response = requests.get(f"{self.vault_api_url}/stats", timeout=10)
            response.raise_for_status()
            logger.info("✅ Vault API is healthy")
        except Exception as e:
            logger.error(f"❌ Vault API is not healthy: {e}")
            return False

        # Check for recent content
        stats = self.get_stats()
        if stats and stats.get('index_built'):
            logger.info("✅ Vault index is built")
            logger.info(f"📊 Total nodes: {stats.get('total', 0)}")
            logger.info(f"📊 Twitter nodes: {stats.get('twitter', 0)}")
            logger.info(f"📊 Instagram nodes: {stats.get('instagram', 0)}")
        else:
            logger.error("❌ Vault index is not properly built")
            return False

        logger.info("✅ Sync health check passed (SINGLE PROCESSING mode)")
        return True

def main():
    sync = EmergencyVaultSync()

    if len(sys.argv) > 1 and sys.argv[1] == "health":
        # Just check health
        success = sync.check_sync_health()
        sys.exit(0 if success else 1)
    elif len(sys.argv) > 1 and sys.argv[1] == "sync":
        # Just perform sync
        success_count = sync.emergency_sync()
        logger.info(f"📊 Sync completed: {success_count} bookmarks processed")
        sys.exit(0)
    else:
        # Both check health and sync
        logger.info("🔧 Performing emergency vault sync (SINGLE PROCESSING mode)...")
        
        # First check health
        if not sync.check_sync_health():
            logger.error("❌ Health check failed, aborting sync")
            sys.exit(1)

        # Then perform sync
        success_count = sync.emergency_sync()
        logger.info(f"✅ Emergency sync completed: {success_count} bookmarks processed")
        
        sys.exit(0)

if __name__ == "__main__":
    main()