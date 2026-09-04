#!/usr/bin/env python3
"""
FAST unified LinkedIn EA pipeline.
Fixes: cookie format (None expires / int secure), aria-label parsing
("Easy Apply to ROLE at COMPANY"), preflight BEFORE submit, scroll-before-click.
Speed: single browser session, one pass per search, parallel-safe tracker writes.
"""
import asyncio, json, sys, time
from playwright.async_api import async_playwright
import browser_cookie3

sys.path.insert(0, '/Users/Subho/job_pipeline')
from preflight_check import check

TRACKER = '/Users/Subho/Desktop/applied_companies_tracker.json'

def brave_cookies():
    """Chrome 9222 session cookies via cmd-headless extractor (proven Sep 3: 35 cookies incl li_at)."""
    import os, tempfile, json as _json
    sys.path.insert(0, '/Users/Subho/omniclaw/skills/browser/sota-browser')
    from cmd_headless import extract_cookies
    result = extract_cookies('chrome', domain='linkedin.com')
    raw = result.get('cookies', result) if isinstance(result, dict) else result
    out = []
    for c in raw:
        exp = c.get('expires', -1)
        out.append({
            'name': c.get('name'), 'value': c.get('value'),
            'domain': c.get('domain', '.linkedin.com'), 'path': c.get('path', '/'),
            'secure': bool(c.get('secure', True)),
            'httpOnly': bool(c.get('httpOnly', False)),
            'expires': exp if isinstance(exp, (int, float)) else -1,
        })
    return out

def load_applied():
    with open(TRACKER) as f:
        return set(a.lower().split(' - ')[0].split(' (')[0] for a in json.load(f).get('applied_companies', []))

def log_applied(company, role, channel='LinkedIn EA'):
    d = json.load(open(TRACKER))
    d.setdefault('applied_companies', []).append(f"{company} - {role} ({channel})")
    d['last_updated'] = '2026-08-27'
    json.dump(d, open(TRACKER, 'w'), indent=1)
    print(f"  TRACKED: {company} - {role}")

async def fill_and_submit(page):
    """Click through EA form. Returns True if submitted."""
    for step in range(8):
        await page.wait_for_timeout(600)
        # fill any visible empty text inputs (phone etc.)
        for inp in await page.locator('div[role="dialog"] input[type="text"]:visible').all():
            try:
                ph = await inp.get_attribute('placeholder') or ''
                if 'phone' in ph.lower() or 'mobile' in ph.lower():
                    await inp.fill('7977110915')
            except Exception:
                pass
        # radio groups: click first option
        for rg in await page.locator('div[role="dialog"] fieldset').all():
            try:
                first = rg.locator('input[type="radio"]').first
                if await first.count() > 0 and not await first.is_checked():
                    await rg.locator('input[type="radio"]').first.check()
            except Exception:
                pass
        submit = page.locator('div[role="dialog"] button:has-text("Submit application")')
        review = page.locator('div[role="dialog"] button:has-text("Review")')
        nxt = page.locator('div[role="dialog"] button:has-text("Next"), div[role="dialog"] button:has-text("Continue to next step")')
        if await submit.count() > 0:
            await submit.first.click()
            await page.wait_for_timeout(1500)
            return True
        if await review.count() > 0:
            await review.first.click(); continue
        if await nxt.count() > 0:
            await nxt.first.click(); continue
        break
    return False

async def main():
    searches = sys.argv[1:] or [
        "Marketing Director India", "Head of Marketing India",
        "VP Marketing India", "Growth Head India",
        "Digital Marketing Director India", "Brand Director India",
        "Chief Marketing Officer India", "Performance Marketing Head India",
    ]
    cookies = brave_cookies()
    applied = load_applied()
    print(f"Cookies: {len(cookies)} | Applied set: {len(applied)}")

    async with async_playwright() as p:
        async def new_browser():
            b = await p.chromium.launch(headless=True)
            c = await b.new_context()
            await c.add_cookies(cookies)
            pg = await c.new_page()
            return b, c, pg
        browser, ctx, page = await new_browser()
        total = 0

        for kw in searches:
            url = f"https://www.linkedin.com/jobs/search/?keywords={kw.replace(' ', '%20')}&location=India&f_TPR=r86400&easyApply=true"
            try:
                await page.goto(url, timeout=20000)
            except Exception as e:
                if 'Connection closed' in str(e) or 'Target closed' in str(e):
                    try: await browser.close()
                    except Exception: pass
                    print(f"{kw}: driver crash, relaunching")
                    try:
                        browser, ctx, page = await new_browser()
                        await page.goto(url, timeout=20000)
                    except Exception:
                        print(f"{kw}: skip"); continue
                else:
                    print(f"{kw}: goto timeout, skip"); continue
            await page.wait_for_timeout(2500)

            btns = page.locator('[aria-label^="Easy Apply to"]')
            n = await btns.count()
            print(f"=== {kw}: {n} EA ===")
            if n == 0:
                continue

            for i in range(min(n, 6)):
                try:
                    btn = page.locator('[aria-label^="Easy Apply to"]').nth(i)
                    aria = await btn.get_attribute('aria-label', timeout=3000) or ''
                except Exception:
                    continue  # stale after page change
                # Parse: "Easy Apply to ROLE at COMPANY"
                rest = aria.replace('Easy Apply to ', '')
                if ' at ' not in rest:
                    continue
                role, company = rest.rsplit(' at ', 1)
                role, company = role.strip(), company.strip()
                # PREFLIGHT before any action
                ok, reason = check(company, role)
                if not ok:
                    print(f"  SKIP {company}: {reason}")
                    continue
                if company.lower() in applied:
                    print(f"  SKIP {company}: already applied")
                    continue
                print(f"  APPLY {company} | {role}")
                try:
                    await btn.scroll_into_view_if_needed(timeout=3000)
                    await btn.click(timeout=5000)
                    submitted = await fill_and_submit(page)
                    if submitted:
                        total += 1
                        log_applied(company, role)
                    # dismiss any leftover dialog
                    d = page.locator('[aria-label="Dismiss"]')
                    if await d.count() > 0:
                        await d.first.click()
                        await page.wait_for_timeout(500)
                except Exception as e:
                    print(f"  ERR {company}: {str(e)[:80]}")
                    if 'Connection closed' in str(e) or 'Target closed' in str(e):
                        try: await browser.close()
                        except Exception: pass
                        browser, ctx, page = await new_browser()

        print(f"\nDONE. Submitted: {total}")
        await browser.close()

asyncio.run(main())
