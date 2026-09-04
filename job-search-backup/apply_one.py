#!/usr/bin/env python3
"""Quick apply - go to search page first."""
import asyncio, json
from playwright.async_api import async_playwright
import browser_cookie3

TRACKER = '/Users/Subho/Desktop/applied_companies_tracker.json'

def get_cookies():
    cj = browser_cookie3.brave(domain_name='linkedin.com')
    cookies = []
    for c in cj:
        cookies.append({'name': c.name, 'value': c.value, 'domain': c.domain, 'path': c.path,
                      'secure': bool(c.has_nonstandard_attr('secure')),
                      'expires': getattr(c, 'expires', -1) or -1,
                      'httpOnly': bool(c.has_nonstandard_attr('httpOnly'))})
    return cookies

def preflight(company, tracker):
    applied = tracker.get('applied_companies', [])
    EXCL = ['amazon','google','microsoft','meta','facebook','twitter','netflix',
             'flipkart','swiggy','zomato','ola','uber','meesho','phonepe',
             'razorpay','cred','bharatpe','khatabook','groww','tcs','infosys',
             'wipro','accenture','school','university','college','institute',
             'academy','education','iim','iit','bits','nit','b-school']
    cl = (company or '').lower().strip()
    if not cl or cl == 'unknown': return True
    for e in EXCL:
        if e in cl: return False
    for a in applied:
        al = a.lower()
        if 'unknown' in al: continue
        key = al.split(' -')[0].split(' (')[0].strip()
        if cl == key or cl.startswith(key + ' '): return False
    return True

async def apply_one(ctx, url):
    page = await ctx.new_page()
    new_app = None
    try:
        await page.goto(url, timeout=30000)
        await page.wait_for_timeout(8000)
        
        # Get all EA buttons
        btns = await page.locator('[aria-label^="Easy Apply to"]').all()
        print(f'Found {len(btns)} EA buttons')
        
        for btn in btns[:5]:
            try:
                aria = await btn.get_attribute('aria-label')
                parts = aria.replace('Easy Apply to ', '').split(' at ')
                if len(parts) == 2:
                    role, company = parts[0].strip(), parts[1].strip()
                    print(f'  {company}: {role[:40]}')
                    if not preflight(company, {}):
                        print(f'    SKIP (preflight)')
                        continue
                    
                    # Click it
                    await btn.scroll_into_view_if_needed()
                    await btn.click(timeout=8000)
                    await page.wait_for_timeout(5000)
                    
                    selects = await page.locator('select[aria-required="true"]').count()
                    if selects < 2:
                        print(f'    No form (selects={selects})')
                        try:
                            await page.get_by_text('Dismiss').first.click(timeout=3000)
                            await page.wait_for_timeout(1000)
                        except: pass
                        continue
                    
                    # Fill form
                    for sel in await page.locator('select[aria-required="true"]').all()[:6]:
                        try:
                            opts = await sel.locator('option').all()
                            if len(opts) > 1:
                                await sel.select_option(index=1)
                        except: pass
                    await page.wait_for_timeout(600)
                    
                    # Navigate to submit
                    for step in range(10):
                        btns2 = await page.locator('button').all()
                        action = None
                        for b in btns2:
                            try:
                                t = (await b.text_content()).lower().strip()
                                if 'submit application' in t:
                                    action = b; break
                                if 'review' in t and 'submit' not in t:
                                    action = b; break
                                if 'next' in t:
                                    action = b; break
                            except: pass
                        if action:
                            await action.click()
                            await page.wait_for_timeout(2500)
                        else:
                            break
                    
                    body = await page.inner_text('body')
                    if 'success' in body.lower() or 'submitted' in body.lower():
                        new_app = f'{company} - {role[:50]}'
                        print(f'    ✅ SUBMITTED!')
                        break
                    else:
                        print(f'    ❌ No confirmation')
                    
                    try:
                        await page.get_by_text('Dismiss').first.click(timeout=3000)
                        await page.wait_for_timeout(1000)
                    except: pass
                    
            except Exception as e:
                print(f'  ERR: {e}')
                try:
                    await page.get_by_text('Dismiss').first.click(timeout=2000)
                except: pass
        
    except Exception as e:
        print(f'Page error: {e}')
    finally:
        await page.close()
    
    return new_app

async def main():
    cookies = get_cookies()
    if not cookies: return
    print(f'li_at={any(c["name"]=="li_at" for c in cookies)}')
    
    with open(TRACKER) as f:
        tracker = json.load(f)
    
    searches = [
        ('CMO', 'https://www.linkedin.com/jobs/search/?keywords=CMO%20India&location=India&f_TPR=r604800&easyApply=true'),
        ('Chief Mkt', 'https://www.linkedin.com/jobs/search/?keywords=Chief%20Marketing%20Officer%20India&location=India&f_TPR=r604800&easyApply=true'),
        ('Marketing Leader', 'https://www.linkedin.com/jobs/search/?keywords=Marketing%20Leader%20India&location=India&f_TPR=r604800&easyApply=true'),
        ('Growth Leader', 'https://www.linkedin.com/jobs/search/?keywords=Growth%20Leader%20India&location=India&f_TPR=r604800&easyApply=true'),
    ]
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=['--no-sandbox'])
        ctx = await browser.new_context()
        await ctx.add_cookies(cookies)
        
        total_new = 0
        for name, url in searches:
            print(f'\n=== {name} ===')
            result = await apply_one(ctx, url)
            if result:
                tracker.setdefault('applied_companies', []).append(result)
                total_new += 1
            await asyncio.sleep(3)
        
        await browser.close()
    
    tracker['applied_companies'] = list(set(tracker.get('applied_companies', [])))
    tracker['last_updated'] = '2026-08-27'
    with open(TRACKER, 'w') as f:
        json.dump(tracker, f, indent=2)
    
    print(f'\n=== DONE: {total_new} new ===')
    print(f'Total: {len(tracker["applied_companies"])}')

asyncio.run(main())