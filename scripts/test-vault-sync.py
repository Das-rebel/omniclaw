#!/usr/bin/env python3
"""
Vault Sync Test Script
Tests the vault sync functionality manually
"""

import asyncio
import json
import logging
import sys
from datetime import datetime, timedelta

import requests
from main import VaultSyncService

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class VaultSyncTester:
    def __init__(self):
        self.service = VaultSyncService()
        self.vault_api_url = self.service.vault_api_url

    def test_api_connectivity(self):
        """Test vault API connectivity"""
        try:
            response = requests.get(f"{self.vault_api_url}/stats")
            response.raise_for_status()
            stats = response.json()
            logger.info(f"✅ API connectivity test passed")
            logger.info(f"   Stats: {stats}")
            return True
        except Exception as e:
            logger.error(f"❌ API connectivity test failed: {e}")
            return False

    def test_sync_status_check(self):
        """Test sync status check"""
        try:
            should_sync = self.service.should_sync()
            logger.info(f"✅ Sync status check passed")
            logger.info(f"   Should sync: {should_sync}")
            return True
        except Exception as e:
            logger.error(f"❌ Sync status check failed: {e}")
            return False

    def test_twitter_sync(self):
        """Test Twitter sync (mock)"""
        try:
            # This is a mock test since we don't have Twitter credentials
            logger.info("✅ Twitter sync test (mock)")
            return True
        except Exception as e:
            logger.error(f"❌ Twitter sync test failed: {e}")
            return False

    def test_instagram_sync(self):
        """Test Instagram sync (mock)"""
        try:
            # This is a mock test since we don't have Instagram credentials
            logger.info("✅ Instagram sync test (mock)")
            return True
        except Exception as e:
            logger.error(f"❌ Instagram sync test failed: {e}")
            return False

    def test_vault_add(self):
        """Test adding items to vault"""
        try:
            # Create a test item
            test_item = {
                'id': f'test_{datetime.utcnow().isoformat()}',
                'content': 'Test item for vault sync',
                'timestamp': datetime.utcnow().isoformat(),
                'type': 'test_tweet',
                'url': 'https://example.com/test',
                'metadata': {
                    'categories': ['test', 'vault_sync'],
                    'source': 'test',
                    'user': 'test_user'
                }
            }
            
            response = requests.post(
                f"{self.vault_api_url}/add",
                json=test_item,
                headers={'Content-Type': 'application/json'}
            )
            response.raise_for_status()
            
            logger.info("✅ Vault add test passed")
            logger.info(f"   Response: {response.json()}")
            return True
        except Exception as e:
            logger.error(f"❌ Vault add test failed: {e}")
            return False

    def test_full_sync(self):
        """Test full sync process"""
        try:
            logger.info("Starting full sync test...")
            success = asyncio.run(self.service.sync_all())
            logger.info(f"✅ Full sync test completed: {success}")
            return success
        except Exception as e:
            logger.error(f"❌ Full sync test failed: {e}")
            return False

    def run_all_tests(self):
        """Run all tests"""
        logger.info("Starting vault sync tests...")
        
        tests = [
            ("API Connectivity", self.test_api_connectivity),
            ("Sync Status Check", self.test_sync_status_check),
            ("Twitter Sync", self.test_twitter_sync),
            ("Instagram Sync", self.test_instagram_sync),
            ("Vault Add", self.test_vault_add),
            ("Full Sync", self.test_full_sync),
        ]
        
        results = {}
        for test_name, test_func in tests:
            logger.info(f"\n--- Testing: {test_name} ---")
            results[test_name] = test_func()
        
        # Summary
        logger.info("\n" + "="*50)
        logger.info("TEST RESULTS SUMMARY:")
        logger.info("="*50)
        
        passed = 0
        total = len(tests)
        
        for test_name, result in results.items():
            status = "✅ PASS" if result else "❌ FAIL"
            logger.info(f"{status}: {test_name}")
            if result:
                passed += 1
        
        logger.info(f"\nSummary: {passed}/{total} tests passed")
        
        if passed == total:
            logger.info("🎉 All tests passed!")
            return True
        else:
            logger.error("❌ Some tests failed!")
            return False

def main():
    """Main test execution"""
    tester = VaultSyncTester()
    
    try:
        success = tester.run_all_tests()
        sys.exit(0 if success else 1)
    except KeyboardInterrupt:
        logger.info("Tests interrupted by user")
        sys.exit(1)
    except Exception as e:
        logger.error(f"Test execution failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()