#!/usr/bin/env python3
"""Debug LinkedIn page content."""
import asyncio
from playwright.async_api import async_playwright
import browser_cookie3

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context()
        
        cookies = list(browser_cookie3.brave(domain_name='linkedin.com'))
        for c in cookies[:35]:
            try:
                await ctx.add_cookies([{'name': c.name, 'value': c.value, 'domain': c.domain, 'path': c.path, 'secure': c.secure}])
            except: pass
        
        page = await ctx.new_page()
        
        url = 'https://www.linkedin.com/jobs/search/?keywords=Growth%20Marketing%20Director%20India&location=India&f_TPR=r86400&easyApply=true'
        await page.goto(url, timeout=30000)
        await page.wait_for_timeout(5000)
        
        content = await page.content()
        print(f'URL: {page.url}')
        print(f'Content length: {len(content)}')
        
        # Check for signs of blocking
        if 'unavailable' in content.lower():
            print('UNAVAILABLE detected!')
        if 'verify' in content.lower():
            print('VERIFY detected!')
        if 'sign in' in content.lower() and 'password' in content.lower():
            print('LOGIN PAGE detected!')
        
        # Show some of the page text
        text = await page.inner_text('body')
        print(f'Body text preview: {text[:500]}')
        
        await browser.close()

asyncio.run(main())
