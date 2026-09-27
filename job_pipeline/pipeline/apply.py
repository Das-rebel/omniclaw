"""
Application Module
=================
Applies to jobs via iimjobs browser automation.

Usage:
    from pipeline.apply import apply_job
    
    result = apply_job(page, url, title)
"""

import time
import sys
sys.path.insert(0, '/Users/Subho/omniclaw/skills/browser/sota-browser')


def apply_job(page, url, title, timeout=45):
    """
    Apply to a single job via iimjobs.
    
    Args:
        page: Playwright page object
        url: Job URL
        title: Job title for logging
    
    Returns:
        'success', 'already', 'video_req', 'failed', 'error'
    """
    print(f"\n=== {title} ===")
    
    try:
        page.goto(url, timeout=timeout*1000)
        time.sleep(4)
        
        content = page.inner_text('body')
        if 'Already applied' in content or 'Applied' in content:
            print("⏭ Already applied")
            return 'already'
        
        if 'closed' in content.lower() or 'removed' in content.lower():
            print("❌ Job closed/removed")
            return 'closed'
        
        # Click Apply
        page.evaluate("""
            () => {
                const btn = Array.from(document.querySelectorAll('button')).find(
                    b => b.innerText.match(/apply/i) && !b.innerText.match(/submit/i)
                );
                if (btn) btn.click();
            }
        """)
        time.sleep(8)
        
        content = page.inner_text('body')
        
        # Check for video/audio requirement
        if ('audio' in content.lower() or 'video' in content.lower()) and 'record' in content.lower():
            print("📹 Requires video/audio - skipping")
            return 'video_req'
        
        # Fill experience fields
        for inp in page.query_selector_all('input[type="number"]'):
            try: inp.fill("11")
            except: pass
        for ta in page.query_selector_all('textarea'):
            try: ta.fill("11 years experience in growth marketing")
            except: pass
        time.sleep(2)
        
        # Click Next
        page.evaluate("""
            () => {
                const btn = Array.from(document.querySelectorAll('button')).find(
                    b => b.innerText.match(/next/i)
                );
                if (btn) btn.click();
            }
        """)
        time.sleep(3)
        
        # Fill again
        for inp in page.query_selector_all('input[type="number"]'):
            try: inp.fill("11")
            except: pass
        
        # Submit
        page.evaluate("""
            () => {
                const btn = Array.from(document.querySelectorAll('button')).find(
                    b => b.innerText.match(/submit|send|apply/i)
                );
                if (btn) btn.click();
            }
        """)
        time.sleep(5)
        
        content = page.inner_text('body')
        if 'success' in content.lower() or 'submitted' in content.lower() or 'applied' in content.lower():
            print("✅ SUCCESS!")
            return 'success'
        
        print("❌ Failed - no confirmation")
        return 'failed'
            
    except Exception as e:
        print(f"❌ Error: {e}")
        return 'error'


def apply_batch(jobs, cookies=None, brave_path="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"):
    """
    Apply to multiple jobs.
    
    Args:
        jobs: list of dicts with url, title keys
        cookies: optional cookies to inject
        brave_path: path to Brave browser
    
    Returns:
        dict of results
    """
    from playwright.sync_api import sync_playwright
    from cmd_headless import extract_cookies
    
    results = {'success': 0, 'already': 0, 'failed': 0, 'video_req': 0, 'error': 0, 'closed': 0}
    
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=brave_path,
            headless=True,
            args=['--disable-blink-features=AutomationControlled']
        )
        ctx = browser.new_context(viewport={'width': 1440, 'height': 900})
        
        # Inject cookies if provided
        if cookies is None:
            try:
                result = extract_cookies("brave", domain="iimjobs.com")
                ctx.add_cookies(result['cookies'])
            except:
                pass
        
        page = ctx.new_page()
        
        for job in jobs:
            res = apply_job(page, job.get('url'), job.get('title'))
            results[res] = results.get(res, 0) + 1
            
            status_icon = {'success': '✅', 'already': '⏭', 'failed': '❌', 
                         'video_req': '📹', 'error': '💥', 'closed': '🚫'}
            print(f"{status_icon.get(res, '?')} {job.get('title')}")
        
        browser.close()
    
    return results


def update_tracker(company, title, source='iimjobs'):
    """Update tracker after successful application."""
    import json
    
    TRACKER = '/Users/Subho/Desktop/applied_companies_tracker.json'
    
    with open(TRACKER) as f:
        tracker = json.load(f)
    
    tracker['applications'].append({
        'company': company,
        'title': title,
        'applied_date': '2026-09-25',
        'source': source
    })
    tracker['total_applications'] = len(tracker['applications'])
    
    with open(TRACKER, 'w') as f:
        json.dump(tracker, f, indent=2)
    
    print(f"✅ Tracker updated: {company} - {title}")


if __name__ == '__main__':
    # Test
    test_jobs = [
        {'url': 'https://www.iimjobs.com/j/some-job-123', 'title': 'Test Job'}
    ]
    print("Run apply_batch() with actual jobs to apply")