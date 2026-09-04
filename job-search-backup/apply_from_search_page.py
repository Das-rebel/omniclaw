#!/usr/bin/env python3
"""Apply from LinkedIn SEARCH RESULTS page - fixed."""
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

def preflight(company, role, tracker):
    applied = tracker.get('applied_companies', [])
    EXCL = ['amazon','google','microsoft','meta','facebook','twitter','netflix',
             'flipkart','swiggy','zomato','ola','uber','meesho','phonepe',
             'razorpay','cred','bharatpe','khatabook','groww','tcs','infosys',
             'wipro','accenture','school','university','college','institute',
             'academy','education','iim','iit','bits','nit','b-school']
    SKIP = ['junior','intern','entry level','fresher','trainee']
    cl = (company or '').lower().strip()
    if not cl or cl == 'unknown': return True, 'unknown'
    for e in EXCL:
        if e in cl: return False, f'excl:{e}'
    for a in applied:
        al = a.lower()
        if 'unknown' in al: continue
        key = al.split(' -')[0].split(' (')[0].strip()
        if cl == key or cl.startswith(key + ' '): return False, 'applied:'+key
    rl = (role or '').lower()
    if any(s in rl for s in SKIP) and not any(s in rl for s in ['senior','associate']):
        return False, 'r8:'+rl[:20]
    return True, 'pass'

async def apply_from_search_page(ctx, url, tracker):
    page = await ctx.new_page()
    new_apps = []
    try:
        await page.goto(url, timeout=30000)
        await page.wait_for_timeout(8000)
        
        for _ in range(3):
            await page.evaluate('window.scrollBy(0, 500)')
            await page.wait_for_timeout(1000)
        
        ea_locator = page.locator('[aria-label^="Easy Apply to"]')
        count = await ea_locator.count()
        print(f'Found {count} EA buttons')
        
        for i in range(min(count, 25)):
            try:
                btn = ea_locator.nth(i)
                aria_label = await btn.get_attribute('aria-label') or ''
                
                if 'Easy Apply to ' not in aria_label:
                    continue
                rest = aria_label.replace('Easy Apply to ', '')
                parts = rest.split(' at ')
                if len(parts) != 2:
                    continue
                role, company = parts[0].strip(), parts[1].strip()
                
                passes, reason = preflight(company, role, tracker)
                if not passes:
                    print(f'  SKIP [{i}] {company}: {reason}')
                    continue
                
                print(f'  [{i}] -> {company}: {role[:35]}')
                
                try:
                    await btn.click(timeout=5000)
                except:
                    try:
                        await btn.click(timeout=5000, force=True)
                    except:
                        print(f'    Could not click')
                        continue
                
                await page.wait_for_timeout(5000)
                
                sels_list = await page.locator('select').all()
                selects = len(sels_list)
                if selects < 2:
                    print(f'    No form (selects={selects})')
                    try:
                        d = page.get_by_text("Dismiss").first
                        await d.click(timeout=3000)
                        await page.wait_for_timeout(1000)
                    except: pass
                    continue
                
                for sel in sels_list[:8]:
                    try:
                        opts = await sel.locator('option').all()
                        if len(opts) > 1:
                            await sel.select_option(index=1)
                    except: pass
                await page.wait_for_timeout(600)
                
                for step in range(15):
                    btns = await page.locator('button').all()
                    action = None
                    for b in btns:
                        try:
                            t = (await b.text_content()).lower().strip()
                            aria_b = await b.get_attribute('aria-label') or ''
                            if 'submit application' in t:
                                action = b
                                print(f'    Step {step}: SUBMIT')
                                break
                            if 'review' in t and 'submit' not in t:
                                action = b
                                print(f'    Step {step}: REVIEW')
                                break
                            if ('next' in t or 'continue' in t) and not aria_b:
                                action = b
                                print(f'    Step {step}: NEXT')
                                break
                        except: pass
                    if action:
                        await action.click()
                        await page.wait_for_timeout(2500)
                    else:
                        break
                
                body = await page.inner_text('body')
                if 'success' in body.lower() or 'submitted' in body.lower():
                    app_str = f'{company} - {role[:50]}'
                    new_apps.append(app_str)
                    print(f'    SUBMITTED!')
                else:
                    print(f'    No confirmation')
                
                try:
                    d = page.get_by_text("Dismiss").first
                    await d.click(timeout=3000)
                    await page.wait_for_timeout(1200)
                except: pass
                await asyncio.sleep(2)
                
            except Exception as e:
                print(f'    ERR [{i}]: {e}')
                try:
                    d = page.get_by_text("Dismiss").first
                    await d.click(timeout=2000)
                except: pass
        
        await page.close()
    except Exception as e:
        print(f'Page error: {e}')
        await page.close()
    
    return new_apps

async def main():
    cookies = get_cookies()
    if not cookies:
        print('No cookies!')
        return
    print(f'Cookies: {len(cookies)}, li_at={any(c["name"]=="li_at" for c in cookies)}')
    
    with open(TRACKER) as f:
        tracker = json.load(f)
    
    searches = [
        ('Dir Mkt IN', 'https://www.linkedin.com/jobs/search/?keywords=Marketing%20Director%20India&location=India&f_TPR=r604800&easyApply=true'),
        ('Head Mkt IN', 'https://www.linkedin.com/jobs/search/?keywords=Head%20Marketing%20India&location=India&f_TPR=r604800&easyApply=true'),
        ('VP Mkt IN', 'https://www.linkedin.com/jobs/search/?keywords=VP%20Marketing%20India&location=India&f_TPR=r604800&easyApply=true'),
        ('Dir Mkt UAE', 'https://www.linkedin.com/jobs/search/?keywords=Marketing%20Director%20UAE&location=UAE&f_TPR=r604800&easyApply=true'),
        ('Dir Mkt SG', 'https://www.linkedin.com/jobs/search/?keywords=Marketing%20Director%20Singapore&location=Singapore&f_TPR=r604800&easyApply=true'),
        ('Dir Mkt AU', 'https://www.linkedin.com/jobs/search/?keywords=Marketing%20Director%20Australia&location=Australia&f_TPR=r604800&easyApply=true'),
    ]
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=['--no-sandbox','--disable-dev-shm-usage'])
        ctx = await browser.new_context()
        await ctx.add_cookies(cookies)
        
        page = await ctx.new_page()
        await page.goto('https://www.linkedin.com/feed/', timeout=15000)
        await page.wait_for_timeout(3000)
        body = await page.inner_text('body')
        print(f'Logged in: {"sign in" not in body.lower()[:200]}')
        await page.close()
        
        total_new = 0
        for name, url in searches:
            print(f'\n=== {name} ===')
            new = await apply_from_search_page(ctx, url, tracker)
            total_new += len(new)
            for a in new:
                tracker.setdefault('applied_companies', []).append(a)
            await asyncio.sleep(3)
        
        await browser.close()
    
    tracker['applied_companies'] = list(set(tracker.get('applied_companies', [])))
    tracker['last_updated'] = '2026-08-27'
    with open(TRACKER, 'w') as f:
        json.dump(tracker, f, indent=2)
    
    print(f'\n=== DONE: {total_new} new ===')
    print(f'Total: {len(tracker["applied_companies"])}')

if __name__ == '__main__':
    asyncio.run(main())
