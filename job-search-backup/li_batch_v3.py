#!/usr/bin/env python3
"""LinkedIn EA batch with fixed extraction + metro geo-targeting."""
import asyncio, json, time, re
from playwright.async_api import async_playwright
import browser_cookie3

TRACKER = '/Users/Subho/Desktop/applied_companies_tracker.json'

def get_cookies():
    cj = browser_cookie3.brave(domain_name='linkedin.com')
    return [{'name':c.name,'value':c.value,'domain':c.domain,'path':c.path,
             'secure':bool(c.has_nonstandard_attr('secure')),
             'expires':getattr(c,'expires',-1) or -1,
             'httpOnly':bool(c.has_nonstandard_attr('httpOnly'))} for c in cj]

def preflight(company, role, applied):
    EXCL = ['amazon','google','microsoft','meta','facebook','twitter','netflix',
             'flipkart','swiggy','zomato','ola','uber','meesho','phonepe',
             'razorpay','cred','bharatpe','khatabook','groww','tcs','infosys',
             'wipro','accenture','school','university','college','institute',
             'academy','education','iim','iit','bits','nit','b-school']
    SKIP_R8 = ['junior','intern','entry level','fresher','trainee']
    cl = (company or '').lower().strip()
    if not cl or cl == 'unknown': return None
    if any(e in cl for e in EXCL): return None
    for a in applied:
        al = a.lower()
        if 'unknown' in al: continue
        key = al.split(' -')[0].split(' (')[0].strip()
        if cl == key or cl.startswith(key + ' '): return None
    rl = (role or '').lower()
    if any(s in rl for s in SKIP_R8) and not any(s in rl for s in ['senior','sr','head','director','vp','chief','lead']):
        return None
    return True

async def apply_one(ctx, company, role):
    page = await ctx.new_page()
    submitted = False
    try:
        # Navigate to LinkedIn jobs search for this company/role
        query = f'{role} {company}'.replace(' ', '%20')
        url = f'https://www.linkedin.com/jobs/search/?keywords={query}&f_TPR=r604800&easyApply=true'
        await page.goto(url, timeout=25000)
        await page.wait_for_timeout(6000)
        
        # Find EA buttons
        btns = await page.locator('button').all()
        ea = None
        for b in btns:
            try:
                aria = await b.get_attribute('aria-label') or ''
                if 'Easy Apply to ' in aria and company.lower() in aria.lower():
                    ea = b
                    break
            except: pass
        
        if not ea:
            # Try any EA button on page
            try:
                ea = page.locator('[aria-label^="Easy Apply to "]').first
                await ea.wait_for(timeout=3000)
            except: ea = None
        
        if not ea:
            await page.close()
            return False
        
        await ea.click(timeout=5000)
        await page.wait_for_timeout(4000)
        
        # Fill form
        sels = await page.locator('select').all()
        for sel in sels[:6]:
            try:
                opts = await sel.locator('option').all()
                if len(opts) > 1:
                    await sel.select_option(index=1)
                    await page.wait_for_timeout(200)
            except: pass
        
        # Navigate steps
        for _ in range(15):
            btns = await page.locator('button').all()
            clicked = False
            for b in btns:
                try:
                    t = (await b.text_content()).lower().strip()
                    if 'submit application' in t:
                        await b.click()
                        await page.wait_for_timeout(2500)
                        clicked = True
                        submitted = True
                        break
                    elif any(x in t for x in ['next','continue','review']):
                        await b.click()
                        await page.wait_for_timeout(1800)
                        clicked = True
                        break
                except: pass
            if not clicked or submitted: break
        
        # Dismiss
        try:
            d = page.get_by_text('Dismiss').first
            await d.click(timeout=2000)
        except: pass
    except Exception as e:
        print(f'    ERR: {e}')
    finally:
        await page.close()
    return submitted

async def main():
    cookies = get_cookies()
    if not cookies: print('No cookies!'); return
    print(f'Cookies: {len(cookies)}')
    
    with open(TRACKER) as f:
        tracker = json.load(f)
    applied = tracker.get('applied_companies', [])
    
    searches = [
        ('Mkt Dir Mumbai', 'Marketing Director', 'Mumbai'),
        ('Mkt Dir Bangalore', 'Marketing Director', 'Bangalore'),
        ('Mkt Dir Pune', 'Marketing Director', 'Pune'),
        ('Mkt Dir Delhi NCR', 'Marketing Director', 'Delhi NCR'),
        ('Head Mkt Hyderabad', 'Head Marketing', 'Hyderabad'),
        ('VP Mkt Bangalore', 'VP Marketing', 'Bangalore'),
        ('Mkt Dir Chennai', 'Marketing Director', 'Chennai'),
        ('Mkt Dir Gurgaon', 'Marketing Director', 'Gurgaon'),
    ]
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=['--no-sandbox'])
        ctx = await browser.new_context()
        await ctx.add_cookies(cookies)
        
        page = await ctx.new_page()
        await page.goto('https://www.linkedin.com/feed/', timeout=12000)
        await page.wait_for_timeout(2000)
        body = await page.inner_text('body')
        print(f'Logged in: {"YES" if "sign in" not in body.lower()[:200] else "NO"}')
        await page.close()
        
        new_total = 0
        for name, role, loc in searches:
            print(f'\n=== {name} ===')
            page = await ctx.new_page()
            try:
                url = f'https://www.linkedin.com/jobs/search/?keywords={role.replace(" ", "%20")}%20{loc.replace(" ", "%20")}&f_TPR=r604800&easyApply=true'
                await page.goto(url, timeout=25000)
                await page.wait_for_timeout(7000)
                
                # Scroll
                for _ in range(3):
                    await page.evaluate('window.scrollBy(0, 400)')
                    await page.wait_for_timeout(600)
                
                btns = await page.locator('button').all()
                ea_list = []
                for b in btns:
                    try:
                        aria = await b.get_attribute('aria-label') or ''
                        if 'Easy Apply to ' in aria:
                            ea_list.append(aria)
                    except: pass
                
                print(f'  Found {len(ea_list)} EA buttons')
                applied_this = 0
                for aria in ea_list[:6]:
                    try:
                        rest = aria.replace('Easy Apply to ', '')
                        parts = rest.split(' at ')
                        if len(parts) != 2: continue
                        raw_company = parts[1].strip()
                        raw_role = parts[0].strip()
                        # parts[0] is often the ROLE, parts[1] is the COMPANY
                        # e.g. "AGM - Marketing at Bonito Designs" -> role=AGM-Marketing, company=Bonito Designs
                        # Heuristic: if parts[0] has senior keywords, it's role; else use search keyword
                        SENIOR_PAT = r'\b(director|head|vp|chief|manager|lead|senior|president|founder|owner)\b'
                        if re.search(SENIOR_PAT, raw_role.lower()):
                            c = raw_company  # parts[1] is company
                            r = f'{raw_role} at {loc}'
                        else:
                            c = raw_company  # parts[1] is company
                            r = f'{role} at {loc}'
                        
                        if not preflight(c, r, applied):
                            print(f'  SKIP: {c[:25]}')
                            continue
                        
                        print(f'  -> {c} - {r[:35]}')
                        
                        if await apply_one(ctx, c, r):
                            app_str = f'{c} - {r[:50]}'
                            tracker.setdefault('applied_companies', []).append(app_str)
                            applied.append(app_str.lower())
                            applied_this += 1
                            new_total += 1
                            print(f'    SUBMITTED!')
                        
                        try:
                            d = page.get_by_text('Dismiss').first
                            await d.click(timeout=2000)
                            await page.wait_for_timeout(1000)
                        except: pass
                        await asyncio.sleep(2)
                    except Exception as e:
                        print(f'    ERR: {e}')
                print(f'  Applied {applied_this} from this search')
            except Exception as e:
                print(f'  Page error: {e}')
            finally:
                await page.close()
            
            await asyncio.sleep(4)
        
        await browser.close()
    
    tracker['last_updated'] = '2026-08-27'
    with open(TRACKER, 'w') as f:
        json.dump(tracker, f, indent=2)
    print(f'\n=== DONE: {new_total} new applications ===')
    print(f'Total tracker: {len(tracker["applied_companies"])}')

if __name__ == '__main__':
    asyncio.run(main())
