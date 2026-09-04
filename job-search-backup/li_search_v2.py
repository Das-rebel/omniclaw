#!/usr/bin/env python3
"""Apply to LinkedIn EA jobs - one at a time from search results."""
import asyncio, json, subprocess
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

def preflight(company, role, tracker):
    applied = tracker.get('applied_companies', [])
    EXCL = ['amazon','google','microsoft','meta','facebook','twitter','netflix',
             'flipkart','swiggy','zomato','ola','uber','meesho','phonepe',
             'razorpay','cred','bharatpe','khatabook','groww','tcs','infosys',
             'wipro','accenture','school','university','college','institute',
             'academy','education','iim','iit','bits','nit','b-school']
    SKIP_ROLES = ['junior','intern','entry level','fresher','trainee']
    
    cl = (company or '').lower().strip()
    if not cl or cl == 'unknown': return True, 'pass'
    for e in EXCL:
        if e in cl: return False, f'excl:{e}'
    for a in applied:
        al = a.lower()
        if 'unknown' in al: continue
        key = al.split(' -')[0].split(' (')[0].strip()
        if cl == key or cl.startswith(key + ' '): return False, 'applied'
    rl = (role or '').lower()
    if any(s in rl for s in SKIP_ROLES) and not any(s in rl for s in ['senior','associate']):
        return False, 'r8'
    return True, 'pass'

def extract_jobs_from_search(search_text):
    """Extract job info from cmd-headless search output."""
    lines = search_text.split('\n')
    jobs = []
    current_role = current_company = None
    
    for line in lines:
        line = line.strip()
        if not line: continue
        
        # Skip navigation
        nav = ['skip to', 'sign in', 'join now', 'linkedin', 'home', 'my network',
               'jobs', 'messaging', 'notifications', 'for business', 'advertise',
               'people', 'more', 'search', 'clear', 'filter', 'sort', 'saved',
               'set alert', 'where are', 'get notified', 'past week', 'company',
               'easy apply', 'under 10 applicants', 'be an early applicant',
               'actively hiring', 'days ago', 'hours ago']
        lw = line.lower()
        if any(n in lw for n in nav): continue
        
        # Look for job titles
        sr = ['director', 'head', 'vp', 'chief', 'agm', 'svp', 'cmo', 'president',
              'gm', 'principal', 'avp', 'associate director']
        rl = role.lower() if role else ''
        if any(s in lw for s in sr) and len(line) > 3 and len(line) < 100:
            if not current_role:
                current_role = line
            elif not current_company:
                current_company = line
    
    if current_role and current_company:
        jobs.append((current_role, current_company))
    return jobs

async def apply_from_search_via_click(ctx, url, tracker):
    """Use cmd-headless to click EA button, Playwright for form."""
    # First use cmd-headless to click EA
    result = subprocess.run(['cmd-headless', '--json', f'go to {url}'], 
                          capture_output=True, text=True, timeout=30)
    
    # Parse output to find job info
    text = result.stdout
    
    # Check if EA button exists
    if 'Easy Apply' not in text:
        return []
    
    # Use Playwright to do the actual apply
    page = await ctx.new_page()
    new_apps = []
    try:
        await page.goto(url, timeout=25000)
        await page.wait_for_timeout(6000)
        
        # Find and click EA button
        try:
            ea = page.locator('[aria-label^="Easy Apply to"]').first
            await ea.click(timeout=8000)
        except:
            await page.close()
            return []
        
        await page.wait_for_timeout(4000)
        
        selects = await page.locator('select').count()
        if selects < 2:
            await page.close()
            return []
        
        # Fill selects
        sel_els = await page.locator('select[aria-required="true"]').all()
        for sel in sel_els[:6]:
            try:
                opts = await sel.locator('option').all()
                if len(opts) > 1:
                    await sel.select_option(index=1)
            except: pass
        await page.wait_for_timeout(600)
        
        # Navigate form
        for _ in range(12):
            btns = await page.locator('button').all()
            action = None
            for b in btns:
                try:
                    t = (await b.text_content()).lower().strip()
                    aria_b = await b.get_attribute('aria-label') or ''
                    if 'submit application' in t:
                        action = b; break
                    if 'review' in t and 'submit' not in t:
                        action = b; break
                    if ('next' in t or 'continue' in t) and not aria_b:
                        action = b; break
                except: pass
            if action:
                await action.click()
                await page.wait_for_timeout(2000)
            else:
                break
        
        body = await page.inner_text('body')
        if 'success' in body.lower() or 'submitted' in body.lower():
            # Extract company/role from aria-label or page
            aria = await page.get_attribute('[aria-label^="Easy Apply to"]', 'aria-label')
            if aria:
                parts = aria.replace('Easy Apply to ', '').split(' at ')
                if len(parts) == 2:
                    new_apps.append(f'{parts[1].strip()} - {parts[0].strip()}')
                    print(f'  ✅ SUBMITTED!')
        
    except Exception as e:
        print(f'  ERR: {e}')
    finally:
        await page.close()
    
    return new_apps

async def main():
    cookies = get_cookies()
    if not cookies: print('No cookies!'); return
    print(f'Cookies: {len(cookies)}, li_at={any(c["name"]=="li_at" for c in cookies)}')
    
    with open(TRACKER) as f:
        tracker = json.load(f)
    
    searches = [
        ('Dir Mkt India', 'https://www.linkedin.com/jobs/search/?keywords=Marketing%20Director%20India&location=India&f_TPR=r604800&easyApply=true'),
        ('Head Mkt India', 'https://www.linkedin.com/jobs/search/?keywords=Head%20Marketing%20India&location=India&f_TPR=r604800&easyApply=true'),
        ('Growth Mkt India', 'https://www.linkedin.com/jobs/search/?keywords=Growth%20Marketing%20India&location=India&f_TPR=r604800&easyApply=true'),
        ('Digital Mkt India', 'https://www.linkedin.com/jobs/search/?keywords=Digital%20Marketing%20Head%20India&location=India&f_TPR=r604800&easyApply=true'),
        ('VP Mkt India', 'https://www.linkedin.com/jobs/search/?keywords=VP%20Marketing%20India&location=India&f_TPR=r604800&easyApply=true'),
        ('Dir Mkt UAE', 'https://www.linkedin.com/jobs/search/?keywords=Marketing%20Director%20UAE&location=UAE&f_TPR=r604800&easyApply=true'),
        ('Dir Mkt Singapore', 'https://www.linkedin.com/jobs/search/?keywords=Marketing%20Director%20Singapore&location=Singapore&f_TPR=r604800&easyApply=true'),
    ]
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=['--no-sandbox','--disable-dev-shm-usage'])
        ctx = await browser.new_context()
        await ctx.add_cookies(cookies)
        
        # Verify login
        page = await ctx.new_page()
        await page.goto('https://www.linkedin.com/feed/', timeout=15000)
        await page.wait_for_timeout(3000)
        body = await page.inner_text('body')
        print(f'Logged in: {"sign in" not in body.lower()[:200]}')
        await page.close()
        
        total_new = 0
        for name, url in searches:
            print(f'\n=== {name} ===')
            new = await apply_from_search_via_click(ctx, url, tracker)
            total_new += len(new)
            for a in new:
                tracker.setdefault('applied_companies', []).append(a)
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