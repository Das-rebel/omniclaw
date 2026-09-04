#!/usr/bin/env python3
"""Apply to LinkedIn jobs by navigating to job page directly."""
import asyncio, json, re
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

async def apply_to_job(ctx, jid, tracker):
    """Navigate to job page and apply via EA."""
    page = await ctx.new_page()
    new_app = None
    try:
        await page.goto(f'https://www.linkedin.com/jobs/view/{jid}/', timeout=25000)
        await page.wait_for_timeout(5000)
        
        # Check if logged in
        body = await page.inner_text('body')
        if 'sign in' in body[:200].lower():
            print(f'  Not logged in')
            await page.close()
            return None
        
        # Try to find and click Easy Apply button using multiple methods
        clicked = False
        for method in ['get_by_text("Easy Apply").first', 
                       'locator("[aria-label^=\'Easy Apply to\']").first',
                       'get_by_text("Apply").first']:
            try:
                if 'get_by_text' in method:
                    if 'Easy Apply' in method:
                        ea = page.get_by_text("Easy Apply").first
                    else:
                        ea = page.get_by_text("Apply").first
                else:
                    ea = page.locator("[aria-label^='Easy Apply to']").first
                await ea.click(timeout=5000)
                clicked = True
                print(f'  Clicked via {method}')
                break
            except:
                pass
        
        if not clicked:
            # Check if already applied
            if 'applied' in body.lower()[:300]:
                print(f'  Already applied')
            else:
                print(f'  No EA button found')
            await page.close()
            return None
        
        await page.wait_for_timeout(4000)
        
        # Check if dialog/form opened
        selects = await page.locator('select').count()
        if selects < 2:
            print(f'  Form not opened (selects={selects})')
            try:
                await page.get_by_text("Dismiss").first.click(timeout=3000)
            except: pass
            await page.close()
            return None
        
        # Fill form - select first non-default option for each select
        for sel in await page.locator('select').all()[:8]:
            try:
                opts = await sel.locator('option').all()
                if len(opts) > 1:
                    await sel.select_option(index=1)
            except: pass
        await page.wait_for_timeout(600)
        
        # Navigate through form: keep clicking Next/Review until Submit or timeout
        for step in range(15):
            btns = await page.locator('button').all()
            action = None
            for b in btns:
                try:
                    t = (await b.text_content()).lower().strip()
                    aria = await b.get_attribute('aria-label') or ''
                    if 'submit application' in t:
                        action = b; print(f'  Step {step}: SUBMIT'); break
                    if 'review' in t and 'submit' not in t:
                        action = b; print(f'  Step {step}: REVIEW'); break
                    if ('next' in t or 'continue' in t) and not aria:
                        action = b; print(f'  Step {step}: NEXT'); break
                except: pass
            if action:
                await action.click()
                await page.wait_for_timeout(2500)
            else:
                break
        
        # Check result
        body = await page.inner_text('body')
        if 'success' in body.lower() or 'submitted' in body.lower() or 'application sent' in body.lower():
            # Get company/role from page
            try:
                title = await page.locator('.t-24').first.inner_text()
            except:
                title = ''
            try:
                company_el = await page.locator('.job-details-jobs-unified-top-card__company-name').first.inner_text()
            except:
                company_el = ''
            new_app = f'{company_el or "Unknown"} - {title[:50]}'
            print(f'  ✅ SUBMITTED: {new_app[:60]}')
        else:
            print(f'  ❌ No confirmation')
        
        # Dismiss dialog
        try:
            await page.get_by_text("Dismiss").first.click(timeout=3000)
            await page.wait_for_timeout(1000)
        except: pass
        
    except Exception as e:
        print(f'  ERR: {e}')
    finally:
        await page.close()
    
    return new_app

async def main():
    cookies = get_cookies()
    if not cookies:
        print('No cookies!'); return
    print(f'Cookies: {len(cookies)}, li_at={any(c["name"]=="li_at" for c in cookies)}')
    
    with open(TRACKER) as f:
        tracker = json.load(f)
    
    # Get job IDs from tracker that we haven't tried
    applied_ids = set()
    for a in tracker.get('applied_companies', []):
        m = re.search(r'(\d{10})', str(a))
        if m:
            applied_ids.add(m.group(1))
    
    # Job IDs to try (not all applied - these are high-relevance)
    # From earlier searches
    job_ids = [
        # India Director/VP/Head level
        '4458216350', '4458159328', '4456824235', '4456890123',
        # UAE
        '4458436794',  # Hire Rightt
        # Singapore
        '4456568623', '4456906740',
        # Fresh searches
    ]
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
        ctx = await browser.new_context()
        await ctx.add_cookies(cookies)
        
        # Verify login
        page = await ctx.new_page()
        await page.goto('https://www.linkedin.com/feed/', timeout=15000)
        await page.wait_for_timeout(3000)
        body = await page.inner_text('body')
        logged_in = 'sign in' not in body.lower()[:200]
        print(f'Logged in: {logged_in}')
        await page.close()
        
        if not logged_in:
            print('NOT LOGGED IN - check cookies')
            await browser.close()
            return
        
        total_new = 0
        for jid in job_ids:
            if jid in applied_ids:
                print(f'\n--- {jid} already applied, skipping')
                continue
            print(f'\n--- Trying {jid}')
            result = await apply_to_job(ctx, jid, tracker)
            if result:
                tracker.setdefault('applied_companies', []).append(result)
                total_new += 1
            await asyncio.sleep(2)
        
        await browser.close()
    
    tracker['applied_companies'] = list(set(tracker.get('applied_companies', [])))
    tracker['last_updated'] = '2026-08-27'
    with open(TRACKER, 'w') as f:
        json.dump(tracker, f, indent=2)
    
    print(f'\n=== DONE: {total_new} new ===')
    print(f'Total: {len(tracker["applied_companies"])}')

if __name__ == '__main__':
    asyncio.run(main())