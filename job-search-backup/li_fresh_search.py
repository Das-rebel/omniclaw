#!/usr/bin/env python3
"""Fresh LinkedIn EA search with different keywords."""
import asyncio, json, time, re
from playwright.async_api import async_playwright
import browser_cookie3

TRACKER = '/Users/Subho/Desktop/applied_companies_tracker.json'

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context()
        
        # Load cookies from Brave
        try:
            cookies = list(browser_cookie3.brave(domain_name='linkedin.com'))
            print(f'Found {len(cookies)} cookies')
            for c in cookies[:35]:
                try:
                    await ctx.add_cookies([{
                        'name': c.name,
                        'value': c.value,
                        'domain': c.domain,
                        'path': c.path,
                        'secure': c.secure,
                    }])
                except Exception as e:
                    pass
            print(f'Added cookies')
        except Exception as e:
            print(f'Cookie error: {e}')
            await browser.close()
            return
        
        page = await ctx.new_page()
        
        # Fresh searches with different terms
        searches = [
            ('Growth Marketing Lead India', 'India'),
            ('Demand Generation Manager India SaaS', 'India'),
            ('Performance Marketing Manager India', 'India'),
            ('Brand Strategy Director India', 'India'),
        ]
        
        for kw, loc in searches:
            print(f'\n=== {kw} @ {loc} ===')
            url = f'https://www.linkedin.com/jobs/search/?keywords={kw.replace(" ", "%20")}&location={loc}&f_TPR=r86400&easyApply=true'
            try:
                await page.goto(url, timeout=30000)
                await page.wait_for_timeout(5000)
                
                # Look for EA buttons
                ea_locator = page.locator('span:text-is("Easy Apply")')
                count = await ea_locator.count()
                print(f'  EA buttons: {count}')
                
            except Exception as e:
                print(f'  Error: {e}')
            
            await asyncio.sleep(3)
        
        await browser.close()

asyncio.run(main())
