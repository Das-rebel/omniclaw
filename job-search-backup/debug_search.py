#!/usr/bin/env python3
"""Debug: see what's actually in search results."""
import asyncio, json
from playwright.async_api import async_playwright
import browser_cookie3

def get_cookies():
    cj = browser_cookie3.brave(domain_name='linkedin.com')
    cookies = []
    for c in cj:
        cookies.append({'name': c.name, 'value': c.value, 'domain': c.domain, 'path': c.path,
                      'secure': bool(c.has_nonstandard_attr('secure')),
                      'expires': getattr(c, 'expires', -1) or -1,
                      'httpOnly': bool(c.has_nonstandard_attr('httpOnly'))})
    return cookies

async def debug_search(ctx):
    page = await ctx.new_page()
    
    # Broader search
    url = 'https://www.linkedin.com/jobs/search/?keywords=marketing%20director%20india&f_TPR=r604800&easyApply=true&f_LCR=IN'
    await page.goto(url, timeout=25000)
    await page.wait_for_timeout(5000)
    
    # Count EA buttons
    btns = await page.locator('[aria-label^="Easy Apply to"]').all()
    print(f'EA buttons: {len(btns)}')
    
    for btn in btns[:10]:
        try:
            aria = await btn.get_attribute('aria-label')
            print(f'  {aria}')
        except: pass
    
    # Also check aria labels with just "Easy Apply"
    ea2 = await page.locator('[aria-label*="Easy Apply"]').all()
    print(f'Aria *Easy Apply: {len(ea2)}')
    
    # Get body text
    body = await page.inner_text('body')
    # Find job listings in body
    lines = body.split('\n')
    jobs = []
    for line in lines:
        line = line.strip()
        if line and len(line) > 5 and not any(n in line.lower() for n in ['skip','sign in','linkedin','filter','sort']):
            if any(c in line for c in ['Director','Head','VP','Chief','Marketing','Manager']):
                jobs.append(line)
    
    print(f'Job-related lines: {len(jobs)}')
    for j in jobs[:15]:
        print(f'  {j[:80]}')
    
    await page.close()

async def main():
    cookies = get_cookies()
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=['--no-sandbox'])
        ctx = await browser.new_context()
        await ctx.add_cookies(cookies)
        await debug_search(ctx)
        await browser.close()

asyncio.run(main())