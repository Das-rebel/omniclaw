#!/usr/bin/env python3
"""LinkedIn search + apply with FIXED extraction + geo targeting."""
import asyncio, json, re
from playwright.async_api import async_playwright
import browser_cookie3

TRACKER = '/Users/Subho/Desktop/applied_companies_tracker.json'

def get_cookies():
    cj = browser_cookie3.brave(domain_name='linkedin.com')
    cookies = []
    for c in cj:
        cookies.append({
            'name': c.name, 'value': c.value, 'domain': c.domain, 'path': c.path,
            'secure': bool(c.has_nonstandard_attr('secure')),
            'expires': getattr(c, 'expires', -1) or -1,
            'httpOnly': bool(c.has_nonstandard_attr('httpOnly'))
        })
    return cookies

def preflight(company, role):
    with open(TRACKER) as f:
        tracker = json.load(f)
    applied = [a.lower() for a in tracker.get('applied_companies', [])]
    EXCL = ['amazon','google','microsoft','meta','facebook','twitter','netflix',
             'flipkart','swiggy','zomato','ola','uber','meesho','phonepe',
             'razorpay','cred','bharatpe','khatabook','groww','tcs','infosys',
             'wipro','accenture','school','university','college','institute',
             'academy','education','iim','iit','bits','nit','b-school']
    SKIP = ['junior','intern','entry level','fresher','trainee','associate']
    cl = (company or '').lower().strip()
    if not cl or cl == 'unknown': return None  # skip unknown
    for e in EXCL:
        if e in cl: return None  # skip excluded
    for a in applied:
        key = a.split(' -')[0].split(' (')[0].strip()
        if cl == key or cl.startswith(key + ' '): return None  # already applied
    rl = (role or '').lower()
    if any(s in rl for s in ['junior','intern','entry']) and not any(s in rl for s in ['senior','sr','head','director','vp','chief','lead']):
        return None  # too junior
    return company  # pass

async def main():
    cookies = get_cookies()
    if not cookies: print('No cookies!'); return
    print(f'Cookies: {len(cookies)}, li_at={any(c["name"]=="li_at" for c in cookies)}')
    
    searches = [
        # India metro searches
        ('Mkt Dir Mumbai', 'https://www.linkedin.com/jobs/search/?keywords=Marketing%20Director&location=Mumbai%2C%20Maharashtra%2C%20India&f_TPR=r604800&easyApply=true'),
        ('Mkt Dir Bangalore', 'https://www.linkedin.com/jobs/search/?keywords=Marketing%20Director&location=Bangalore%2C%20Karnataka%2C%20India&f_TPR=r604800&easyApply=true'),
        ('Mkt Dir Pune', 'https://www.linkedin.com/jobs/search/?keywords=Marketing%20Director&location=Pune%2C%20Maharashtra%2C%20India&f_TPR=r604800&easyApply=true'),
        ('Head Mkt Delhi', 'https://www.linkedin.com/jobs/search/?keywords=Head%20Marketing&location=Delhi%2C%20India&f_TPR=r604800&easyApply=true'),
        ('VP Mkt Hyderabad', 'https://www.linkedin.com/jobs/search/?keywords=VP%20Marketing&location=Hyderabad%2C%20Telangana%2C%20India&f_TPR=r604800&easyApply=true'),
        # UAE
        ('Mkt Dir Dubai', 'https://www.linkedin.com/jobs/search/?keywords=Marketing%20Director&location=Dubai%2C%20UAE&f_TPR=r604800&easyApply=true'),
        # Singapore
        ('Mkt Dir SG', 'https://www.linkedin.com/jobs/search/?keywords=Marketing%20Director&location=Singapore&f_TPR=r604800&easyApply=true'),
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
        
        new_total = 0
        for name, url in searches:
            print(f'\n=== {name} ===')
            page = await ctx.new_page()
            try:
                await page.goto(url, timeout=30000)
                await page.wait_for_timeout(8000)
                
                # Scroll to load jobs
                for _ in range(4):
                    await page.evaluate('window.scrollBy(0, 300)')
                    await page.wait_for_timeout(800)
                
                # Find EA buttons - look for the specific aria-label pattern
                ea_buttons = []
                try:
                    btns = await page.locator('button').all()
                    for btn in btns:
                        try:
                            aria = await btn.get_attribute('aria-label') or ''
                            if 'Easy Apply to ' in aria:
                                ea_buttons.append(aria)
                        except: pass
                except Exception as e:
                    print(f'  Button scan error: {e}')
                
                print(f'  Found {len(ea_buttons)} EA buttons')
                
                for aria in ea_buttons[:8]:
                    try:
                        rest = aria.replace('Easy Apply to ', '')
                        parts = rest.split(' at ')
                        if len(parts) != 2: continue
                        role, company = parts[0].strip(), parts[1].strip()
                        
                        result = preflight(company, role)
                        if not result:
                            print(f'  SKIP: {company[:30]} - {role[:30]}')
                            continue
                        
                        print(f'  APPLYING: {company} - {role[:40]}')
                        
                        # Click the button
                        try:
                            btn = page.locator(f'[aria-label="{aria}"]')
                            await btn.click(timeout=5000)
                        except:
                            try:
                                await page.evaluate(f'document.querySelector(\'[aria-label="{aria}"]\').click()')
                            except:
                                print(f'    Could not click')
                                continue
                        
                        await page.wait_for_timeout(5000)
                        
                        # Fill form
                        try:
                            sels = await page.locator('select').all()
                            for sel in sels[:6]:
                                opts = await sel.locator('option').all()
                                if len(opts) > 1:
                                    await sel.select_option(index=1)
                                    await page.wait_for_timeout(300)
                        except: pass
                        
                        # Click through steps
                        for step in range(12):
                            btns = await page.locator('button').all()
                            clicked = False
                            for b in btns:
                                try:
                                    t = (await b.text_content()).lower().strip()
                                    if 'submit application' in t:
                                        await b.click()
                                        await page.wait_for_timeout(2000)
                                        clicked = True
                                        print(f'    SUBMITTED!')
                                        break
                                    elif ('next' in t or 'continue' in t or 'review' in t):
                                        await b.click()
                                        await page.wait_for_timeout(2000)
                                        clicked = True
                                except: pass
                            if not clicked: break
                        
                        # Check for success
                        body = await page.inner_text('body')
                        if 'success' in body.lower() or 'submitted' in body.lower():
                            with open(TRACKER) as f:
                                t = json.load(f)
                            t.setdefault('applied_companies', []).append(f'{company} - {role[:50]} (LinkedIn EA)')
                            t['last_updated'] = '2026-08-27'
                            with open(TRACKER, 'w') as f:
                                json.dump(t, f, indent=2)
                            new_total += 1
                            print(f'    SAVED!')
                        
                        # Dismiss
                        try:
                            d = page.get_by_text('Dismiss').first
                            await d.click(timeout=2000)
                            await page.wait_for_timeout(1000)
                        except: pass
                        await asyncio.sleep(2)
                        
                    except Exception as e:
                        print(f'  ERR: {e}')
                        try:
                            d = page.get_by_text('Dismiss').first
                            await d.click(timeout=2000)
                        except: pass
                        
            except Exception as e:
                print(f'  Page error: {e}')
            finally:
                await page.close()
            
            await asyncio.sleep(3)
        
        await browser.close()
    
    print(f'\n=== DONE: {new_total} new applications ===')

if __name__ == '__main__':
    asyncio.run(main())
