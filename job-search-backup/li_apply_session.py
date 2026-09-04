#!/usr/bin/env python3
"""Apply to LinkedIn jobs using Playwright with brave cookies - persistent browser."""
import asyncio, json, sys
from playwright.async_api import async_playwright
import browser_cookie3

TRACKER = '/Users/Subho/Desktop/applied_companies_tracker.json'
COOKIES_FILE = '/tmp/li_cookies_brave.json'

def get_cookies():
    """Get cookies from Brave."""
    try:
        cj = browser_cookie3.brave(domain_name='linkedin.com')
        cookies = []
        for c in cj:
            cookies.append({
                'name': c.name, 'value': c.value,
                'domain': c.domain, 'path': c.path,
                'secure': bool(c.has_nonstandard_attr('secure')),
                'expires': getattr(c, 'expires', -1) or -1,
                'httpOnly': bool(c.has_nonstandard_attr('httpOnly'))
            })
        with open(COOKIES_FILE, 'w') as f:
            json.dump(cookies, f)
        return cookies
    except Exception as e:
        print(f'Cookie error: {e}')
        return []

async def apply_one(ctx, jid):
    """Apply to job by ID."""
    page = await ctx.new_page()
    try:
        await page.goto(f'https://www.linkedin.com/jobs/view/{jid}/', timeout=25000)
        await page.wait_for_timeout(5000)
        
        # Check if logged in
        if 'sign in' in (await page.inner_text('body')).lower()[:200]:
            print(f'  Not logged in')
            await page.close()
            return False
        
        # Try aria-label approach
        try:
            ea = page.locator('[aria-label^="Easy Apply to"]').first
            await ea.click()
        except:
            # Fallback: get_by_text
            try:
                ea = page.get_by_text('Easy Apply', exact=True).first
                await ea.click()
            except:
                await page.close()
                return False
        
        await page.wait_for_timeout(3500)
        
        # Check form opened
        selects = await page.locator('select').count()
        if selects < 2:
            await page.close()
            return False
        
        # Fill selects with first option
        for sel in await page.locator('select[aria-required="true"]').all()[:4]:
            try:
                opts = await sel.locator('option').all()
                if len(opts) > 1:
                    await sel.select_option(index=1)
            except: pass
        await page.wait_for_timeout(500)
        
        # Navigate form
        for _ in range(10):
            btns = await page.locator('button').all()
            action = None
            for btn in btns:
                try:
                    t = (await btn.text_content()).lower().strip()
                    if 'submit application' in t:
                        action = btn; break
                    elif 'review' in t:
                        action = btn; break
                    elif 'next' in t:
                        action = btn; break
                except: pass
            if action:
                await action.click()
                await page.wait_for_timeout(2000)
            else:
                break
        
        # Check success
        body = await page.inner_text('body')
        await page.close()
        return 'success' in body.lower() or 'submitted' in body.lower()
    except Exception as e:
        print(f'ERR {jid}: {e}')
        await page.close()
        return False

async def main():
    cookies = get_cookies()
    if not cookies:
        print('No cookies!'); return
    print(f'Cookies: {len(cookies)} (li_at={any(c["name"]=="li_at" for c in cookies)})')
    
    with open(TRACKER) as f:
        tracker = json.load(f)
    applied = tracker.get('applied_companies', [])
    
    # Jobs to try - from our discoveries
    jobs = [
        ('4457287256', 'Qrusible Talent Network', 'Head of Digital Revenue Network'),
        # Add jobs that have the aria-label button
    ]
    
    async with async_playwright() as p:
        # Launch with args that help with stability
        browser = await p.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-setuid-sandbox']
        )
        ctx = await browser.new_context()
        await ctx.add_cookies(cookies)
        
        # Test login
        page = await ctx.new_page()
        await page.goto('https://www.linkedin.com/feed/', timeout=15000)
        await page.wait_for_timeout(3000)
        body = await page.inner_text('body')
        logged_in = 'sign in' not in body.lower()[:300]
        print(f'Logged in: {logged_in}')
        await page.close()
        
        if not logged_in:
            print('NOT LOGGED IN - cookies may be expired')
            await browser.close()
            return
        
        # Apply to jobs
        for jid, company, role in jobs:
            key = f"{company.lower()[:20]}|{role.lower()[:30]}"
            if any(key in a.lower() for a in applied):
                print(f'SKIP {company}: already')
                continue
            
            print(f'Apply: {company} - {role[:30]}')
            ok = await apply_one(ctx, jid)
            if ok:
                applied.append(f'{company} - {role[:40]}')
                print(f'  ✅ Submitted!')
            else:
                print(f'  ❌ Failed')
            await asyncio.sleep(3)
        
        await browser.close()
    
    tracker['applied_companies'] = applied
    tracker['last_updated'] = '2026-08-27'
    with open(TRACKER, 'w') as f:
        json.dump(tracker, f, indent=2)
    print(f'\nTotal: {len(applied)}')

if __name__ == '__main__':
    asyncio.run(main())