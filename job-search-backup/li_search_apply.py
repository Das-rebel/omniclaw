#!/usr/bin/env python3
"""LinkedIn EA - fixed version."""
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

async def apply_one(ctx, jid, company, role, tracker):
    """Apply to job from search results using aria-label button."""
    page = await ctx.new_page()
    new_app = None
    try:
        await page.goto(f'https://www.linkedin.com/jobs/view/{jid}/', timeout=20000)
        await page.wait_for_timeout(4000)
        
        # Click the aria-label button if on search results page
        try:
            ea = page.locator(f'[aria-label="Easy Apply to {role[:30]} at {company[:20]}"]').first
            await ea.click(timeout=5000)
        except:
            try:
                ea = page.locator('[aria-label^="Easy Apply to"]').first
                await ea.click(timeout=5000)
            except:
                await page.close()
                return False
        
        await page.wait_for_timeout(3500)
        
        selects = await page.locator('select').count()
        if selects < 2:
            await page.close()
            return False
        
        # Fill required selects
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
            new_app = f'{company} - {role[:50]}'
            print(f'  ✅ SUBMITTED!')
        else:
            print(f'  ❌ No confirmation')
        
        # Dismiss
        try:
            dismiss = page.get_by_text('Dismiss').first
            await dismiss.click(timeout=3000)
            await page.wait_for_timeout(1000)
        except: pass
        
    except Exception as e:
        print(f'  ERR: {e}')
    finally:
        await page.close()
    
    return new_app

async def apply_from_search(ctx, url, tracker):
    """Go to search results, click each aria-label button."""
    page = await ctx.new_page()
    new_apps = []
    try:
        await page.goto(url, timeout=25000)
        await page.wait_for_timeout(6000)
        
        btns = await page.locator('[aria-label^="Easy Apply to"]').all()
        print(f'Found {len(btns)} EA buttons')
        
        for btn in btns[:20]:
            try:
                aria = await btn.get_attribute('aria-label') or ''
                parts = aria.replace('Easy Apply to ', '').split(' at ')
                if len(parts) != 2: continue
                role, company = parts[0].strip(), parts[1].strip()
                
                passes, reason = preflight(company, role, tracker)
                if not passes:
                    print(f'  SKIP {company}: {reason}'); continue
                
                print(f'  → {company}: {role[:40]}')
                
                # Scroll btn into view and click
                await btn.scroll_into_view_if_needed()
                await btn.click()
                await page.wait_for_timeout(4000)
                
                selects = await page.locator('select[aria-required="true"]').count()
                if selects < 2:
                    try:
                        dismiss = page.get_by_text('Dismiss').first
                        await dismiss.click()
                        await page.wait_for_timeout(1000)
                    except: pass
                    continue
                
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
                    btns2 = await page.locator('button').all()
                    action = None
                    for b in btns2:
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
                    new_apps.append(f'{company} - {role[:50]}')
                    print(f'    ✅ SUBMITTED!')
                else:
                    print(f'    ❌ No confirmation')
                
                try:
                    dismiss = page.get_by_text('Dismiss').first
                    await dismiss.click()
                    await page.wait_for_timeout(1200)
                except: pass
                
                await asyncio.sleep(2)
                
            except Exception as e:
                print(f'    ERR: {e}')
                try:
                    dismiss = page.get_by_text('Dismiss').first
                    await dismiss.click()
                    await page.wait_for_timeout(800)
                except: pass
        
        await page.close()
    except Exception as e:
        print(f'Page error: {e}')
        await page.close()
    
    return new_apps

async def main():
    cookies = get_cookies()
    if not cookies: print('No cookies!'); return
    print(f'Cookies: {len(cookies)}, li_at={any(c["name"]=="li_at" for c in cookies)}')
    
    with open(TRACKER) as f:
        tracker = json.load(f)
    
    searches = [
        ('India', 'https://www.linkedin.com/jobs/search/?keywords=Marketing%20Director%20India&f_TPR=r604800&easyApply=true&f_LCR=IN&f_E=2'),
        ('India VP', 'https://www.linkedin.com/jobs/search/?keywords=VP%20Head%20Marketing%20India&f_TPR=r604800&easyApply=true&f_LCR=IN&f_E=2'),
        ('UAE', 'https://www.linkedin.com/jobs/search/?keywords=Marketing%20Director%20UAE&f_TPR=r604800&easyApply=true&f_LCR=AE'),
        ('Singapore', 'https://www.linkedin.com/jobs/search/?keywords=Marketing%20Director%20Singapore&f_TPR=r604800&easyApply=true'),
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
            new = await apply_from_search(ctx, url, tracker)
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