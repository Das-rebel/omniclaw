"""
Bookmark Vault Scheduler - Twitter & Instagram Scraping
GCP Cloud Function entry points (Gen 2)
"""

import asyncio
import json
import os
from datetime import datetime

# Configuration
VAULT_DIR = os.getenv("VAULT_DIR", "/workspace/data")
TWITTER_OUTPUT = os.path.join(VAULT_DIR, "twitter_bookmarks_automated.json")
INSTAGRAM_OUTPUT = os.path.join(VAULT_DIR, "instagram_scrape.json")
VAULT_FILE = os.path.join(VAULT_DIR, "bookmarks_vault.json")


def log(msg):
    print(f"[SCHEDULER] {datetime.now().isoformat()} {msg}", flush=True)


async def twitter_scrape_async():
    """Async Twitter scraper wrapper"""
    log("=== Twitter Scraper Started ===")
    try:
        from twitter_scraper import scrape_twitter_bookmarks
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, scrape_twitter_bookmarks)
        log(f"=== Twitter scrape completed: {result} ===")
        return result
    except Exception as e:
        log(f"Twitter scrape error: {e}")
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}


async def instagram_scrape_async():
    """Async Instagram scraper"""
    log("=== Instagram Scraper Started ===")
    try:
        from instagram_scraper import scrape_instagram_saved
        result = await scrape_instagram_saved()
        log(f"=== Instagram scrape completed: {result} ===")
        return result
    except Exception as e:
        log(f"Instagram scrape error: {e}")
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}


# GCP Cloud Functions entry points
def twitter_scrape(event=None, context=None):
    """Entry point for Twitter scraper Cloud Function"""
    return asyncio.run(twitter_scrape_async())


def instagram_scrape(event=None, context=None):
    """Entry point for Instagram scraper Cloud Function"""
    return asyncio.run(instagram_scrape_async())


def scheduler(event=None, context=None):
    """Entry point for combined scheduler"""
    log("=== Bookmark Vault Scheduler Started ===")

    try:
        from twitter_scraper_gcs import scrape_twitter_bookmarks
        from instagram_scraper_gcs import scrape_instagram_saved

        # Run Twitter and Instagram in parallel using thread executor
        # This way if one blocks, the other can still complete
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        def run_twitter():
            return scrape_twitter_bookmarks()

        def run_instagram():
            return scrape_instagram_saved()

        # Run both in parallel with a shared executor
        from concurrent.futures import ThreadPoolExecutor
        executor = ThreadPoolExecutor(max_workers=2)

        twitter_future = loop.run_in_executor(executor, run_twitter)
        instagram_future = loop.run_in_executor(executor, run_instagram)

        # Wait for both with timeout
        twitter_result = None
        instagram_result = None
        try:
            # Get Twitter result with timeout (don't let it block forever)
            twitter_result = loop.run_until_complete(
                asyncio.wait_for(twitter_future, timeout=60)
            )
        except asyncio.TimeoutError:
            log("Twitter scrape timed out after 60 seconds")
            twitter_result = {"success": False, "error": "Timeout"}
        except Exception as e:
            log(f"Twitter scrape error: {e}")
            twitter_result = {"success": False, "error": str(e)}

        try:
            instagram_result = loop.run_until_complete(
                asyncio.wait_for(instagram_future, timeout=60)
            )
        except asyncio.TimeoutError:
            log("Instagram scrape timed out after 60 seconds")
            instagram_result = {"success": False, "error": "Timeout"}
        except Exception as e:
            log(f"Instagram scrape error: {e}")
            instagram_result = {"success": False, "error": str(e)}

        executor.shutdown(wait=False)
        loop.close()

        os.makedirs(VAULT_DIR, exist_ok=True)
        vault = {
            "lastUpdated": datetime.now().isoformat(),
            "twitterSuccess": twitter_result.get("success", False) if twitter_result else False,
            "instagramSuccess": instagram_result.get("success", False) if instagram_result else False,
            "twitterNewBookmarks": twitter_result.get("count", 0) if twitter_result else 0,
            "instagramNewPosts": instagram_result.get("count", 0) if instagram_result else 0,
            "source": "bookmark-vault-scheduler"
        }

        with open(VAULT_FILE, "w") as f:
            json.dump(vault, f, indent=2)

        log(f"=== Scheduler completed: {vault} ===")
        return vault

    except Exception as e:
        log(f"Scheduler error: {e}")
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}


# Aliases
main = scheduler