#!/usr/bin/env python3
"""
Vault Sync Service
Automatically syncs bookmarks from Twitter and Instagram to the vault search index.
Follows the original schedule: SINGLE SYNC with SINGLE PROCESSING.
"""

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timedelta
from typing import Dict, List, Optional

import requests
from google.cloud import firestore
from google.cloud import storage
from google.cloud.secretmanager import SecretManagerServiceClient
from twscrape import API, TwitterScraper

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class VaultSyncService:
    def __init__(self):
        self.firestore_client = firestore.Client()
        self.storage_client = storage.Client()
        self.secret_client = SecretManagerServiceClient()
        
        # Vault API configuration
        self.vault_api_url = os.getenv('VAULT_API_URL', 'https://serve-vault-search-338789220059.asia-south1.run.app')
        self.sync_interval = int(os.getenv('SYNC_INTERVAL', '86400'))  # 24 hours instead of 1 hour
        
        # Twitter API credentials
        self.twitter_api_key = self._get_secret('twitter-api-key')
        self.twitter_api_secret = self._get_secret('twitter-api-secret')
        self.twitter_access_token = self._get_secret('twitter-access-token')
        self.twitter_access_token_secret = self._get_secret('twitter-access-token-secret')
        
        # Instagram configuration
        self.instagram_username = os.getenv('INSTAGRAM_USERNAME')
        self.instagram_password = self._get_secret('instagram-password')
        
        logger.info("VaultSyncService initialized - SINGLE SYNC mode")

    def _get_secret(self, secret_name: str) -> str:
        """Retrieve secret from Secret Manager"""
        try:
            name = f"projects/{os.getenv('GCP_PROJECT')}/secrets/{secret_name}/versions/latest"
            response = self.secret_client.access_secret_version(request={"name": name})
            return response.payload.data.decode("UTF-8")
        except Exception as e:
            logger.error(f"Failed to get secret {secret_name}: {e}")
            raise

    def get_sync_status(self) -> Dict:
        """Get current sync status from vault"""
        try:
            response = requests.get(f"{self.vault_api_url}/stats")
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logger.error(f"Failed to get sync status: {e}")
            return {}

    def should_sync(self) -> bool:
        """Check if sync should be based on last sync time"""
        try:
            # Get last sync time from Firestore
            doc_ref = self.firestore_client.collection('vault_sync').document('last_sync')
            doc = doc_ref.get()
            
            if not doc.exists:
                return True
            
            last_sync = doc.to_dict().get('timestamp')
            if not last_sync:
                return True
            
            last_sync_time = datetime.fromisoformat(last_sync)
            next_sync_time = last_sync_time + timedelta(seconds=self.sync_interval)
            
            return datetime.utcnow() >= next_sync_time
            
        except Exception as e:
            logger.error(f"Failed to check sync status: {e}")
            return True

    def sync_twitter_bookmarks(self) -> List[Dict]:
        """Sync Twitter bookmarks to vault - SINGLE PROCESSING MODE"""
        try:
            logger.info("Starting Twitter bookmark sync (SINGLE PROCESSING)")
            
            # Initialize Twitter scraper
            api = API(
                self.twitter_api_key,
                self.twitter_api_secret,
                self.twitter_access_token,
                self.twitter_access_token_secret
            )
            
            # Sync bookmarks from the last 3 days only (reduced frequency)
            since_date = datetime.utcnow() - timedelta(days=3)
            
            bookmarks = []
            for tweet in api.get_user_bookmarks():
                tweet_date = datetime.fromisoformat(tweet.created_at)
                if tweet_date >= since_date:
                    bookmark = {
                        'id': tweet.id,
                        'content': tweet.text,
                        'timestamp': tweet.created_at,
                        'type': 'twitter_tweet',
                        'url': f"https://x.com/{tweet.user.username}/status/{tweet.id}",
                        'entities': tweet.entities,
                        'metadata': {
                            'categories': ['bookmark', 'social_media'],
                            'source': 'twitter',
                            'user': tweet.user.username,
                            'sync_mode': 'single_processing'
                        }
                    }
                    bookmarks.append(bookmark)
            
            logger.info(f"Found {len(bookmarks)} Twitter bookmarks (SINGLE PROCESSING)")
            return bookmarks
            
        except Exception as e:
            logger.error(f"Failed to sync Twitter bookmarks: {e}")
            return []

    def sync_instagram_bookmarks(self) -> List[Dict]:
        """Sync Instagram bookmarks to vault - SINGLE PROCESSING MODE"""
        try:
            logger.info("Starting Instagram bookmark sync (SINGLE PROCESSING)")
            
            # This would use Instagram API scraping
            # For now, return empty list as Instagram API is limited
            return []
            
        except Exception as e:
            logger.error(f"Failed to sync Instagram bookmarks: {e}")
            return []

    def process_single_item(self, item: Dict) -> bool:
        """Process a single item to avoid blocking"""
        try:
            # Add item to vault with timeout
            response = requests.post(
                f"{self.vault_api_url}/add",
                json=item,
                headers={'Content-Type': 'application/json'},
                timeout=30  # Short timeout to avoid blocking
            )
            response.raise_for_status()
            
            logger.info(f"Successfully processed item: {item['id']}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to process item {item['id']}: {e}")
            return False

    def add_to_vault_single_processing(self, items: List[Dict]) -> bool:
        """Add items to vault with SINGLE PROCESSING to avoid blocking"""
        try:
            if not items:
                logger.info("No items to process (SINGLE PROCESSING)")
                return True
            
            logger.info(f"Starting single processing of {len(items)} items...")
            
            # Process items one by one to avoid blocking
            success_count = 0
            for i, item in enumerate(items, 1):
                logger.info(f"Processing item {i}/{len(items)}: {item['id']}")
                
                if self.process_single_item(item):
                    success_count += 1
                    
                    # Add delay between items to prevent blocking
                    time.sleep(1)
                    
                    # Log progress every 10 items
                    if i % 10 == 0:
                        logger.info(f"Processed {i} items so far...")
            
            logger.info(f"SINGLE PROCESSING completed: {success_count}/{len(items)} items processed")
            return success_count > 0
            
        except Exception as e:
            logger.error(f"SINGLE PROCESSING failed: {e}")
            return False

    def update_sync_status(self, success: bool, count: int = 0):
        """Update sync status in Firestore"""
        try:
            doc_ref = self.firestore_client.collection('vault_sync').document('last_sync')
            doc_ref.set({
                'timestamp': datetime.utcnow().isoformat(),
                'success': success,
                'items_synced': count,
                'service': 'vault-sync-single',
                'sync_mode': 'single_processing',
                'processing_time': datetime.utcnow().isoformat()
            })
            
            logger.info(f"Updated sync status: success={success}, count={count}")
            
        except Exception as e:
            logger.error(f"Failed to update sync status: {e}")

    async def sync_all(self) -> bool:
        """Perform single sync with single processing to avoid blocking"""
        try:
            logger.info("Starting SINGLE sync with SINGLE PROCESSING mode")
            
            # Check if sync should run
            if not self.should_sync():
                logger.info("Sync not needed yet (SINGLE PROCESSING)")
                return True
            
            # Sync all sources
            all_items = []
            
            # Twitter bookmarks
            twitter_items = self.sync_twitter_bookmarks()
            all_items.extend(twitter_items)
            
            # Instagram bookmarks
            instagram_items = self.sync_instagram_bookmarks()
            all_items.extend(instagram_items)
            
            if not all_items:
                logger.info("No new items to sync (SINGLE PROCESSING)")
                self.update_sync_status(True, 0)
                return True
            
            logger.info(f"Total items to process: {len(all_items)}")
            
            # Process with SINGLE PROCESSING to avoid blocking
            success = self.add_to_vault_single_processing(all_items)
            
            # Update status
            self.update_sync_status(success, len(all_items))
            
            if success:
                logger.info(f"SINGLE sync completed successfully: {len(all_items)} items processed")
            else:
                logger.error("SINGLE sync failed")
                
            return success
            
        except Exception as e:
            logger.error(f"SINGLE sync failed: {e}")
            self.update_sync_status(False, 0)
            return False

def main():
    """Main entry point"""
    service = VaultSyncService()
    
    try:
        # Run single sync
        success = asyncio.run(service.sync_all())
        
        if success:
            logger.info("SINGLE sync completed successfully")
            return 0
        else:
            logger.error("SINGLE sync failed")
            return 1
            
    except Exception as e:
        logger.error("SINGLE sync crashed: {e}")
        return 1

if __name__ == "__main__":
    exit(main())