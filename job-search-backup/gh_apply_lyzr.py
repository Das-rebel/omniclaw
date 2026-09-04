#!/usr/bin/env python3
"""Apply to Lyzr AI via Greenhouse or direct."""
import asyncio, json, re
from playwright.async_api import async_playwright

async def main():
    # Try Lyzr AI on Greenhouse
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context()
        page = await ctx.new_page()
        
        gh_url = 'https://boards.greenhouse.io/lyzr/jobs'
        try:
            resp = await page.goto(gh_url, timeout=15000)
            content = await page.content()
            print(f'GH status: {resp.status if resp else None}')
            if 'Page not found' in content[:500]:
                print('Not found on Greenhouse')
            else:
                # Look for job listings
                print(f'Content preview: {content[500:800]}')
        except Exception as e:
            print(f'GH error: {e}')
        
        await browser.close()

if __name__ == '__main__':
    asyncio.run(main())
