#!/usr/bin/env python3
"""
FAST LinkedIn EA via existing Chrome CDP (port 9222) — logged-in session.
Same rules as fast_apply.py: aria-label parse (R20), preflight-first (R17).
Usage: python3 fast_apply_cdp.py "search 1" "search 2" ...
"""
import asyncio, json, sys, time
from playwright.async_api import async_playwright

sys.path.insert(0, '/Users/Subho/job_pipeline')
from preflight_check import check

TRACKER = '/Users/Subho/Desktop/applied_companies_tracker.json'
CDP = 'http://127.0.0.1:9222'

def load_applied():
    with open(TRACKER) as f:
        d = json.load(f)
    return set(a.lower().split(' - ')[0].split(' (')[0] for a in d.get('applied_companies', []))

def log_applied(company, role, channel='LinkedIn EA'):
    d = json.load(open(TRACKER))
    d.setdefault('applied_companies', []).append(f"{company} - {role} ({channel})")
    d['last_updated'] = time.strftime('%Y-%m-%d')
    d['applied_companies_count'] = len(d['applied_companies'])
    json.dump(d, open(TRACKER, 'w'), indent=1)
    print(f"  TRACKED: {company} - {role}")

async def fill_and_submit(page):
    """Click through EA form. Returns True if submitted."""
    for step in range(8):
        await page.wait_for_timeout(700)
        for inp in await page.locator('div[role="dialog"] input[type="text"]:visible').all():
            try:
                ph = await inp.get_attribute('placeholder') or ''
                if 'phone' in ph.lower() or 'mobile' in ph.lower():
                    await inp.fill('7977110915')
            except Exception:
                pass
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
    ]
    applied = load_applied()
    print(f"Applied set: {len(applied)}")

    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(CDP)
        ctx = browser.contexts[0]
        page = await ctx.new_page()
        total = 0

        for kw in searches:
            url = f"https://www.linkedin.com/jobs/search/?keywords={kw.replace(' ', '%20')}&location=India&f_TPR=r86400&f_AL=true"
            try:
                await page.goto(url, timeout=25000)
            except Exception as e:
                print(f"{kw}: goto fail {str(e)[:60]}"); continue
            await page.wait_for_timeout(3000)

            # verify logged in
            body = (await page.inner_text('body'))[:400]
            if 'Sign in' in body and 'Join now' in body:
                print(f"{kw}: NOT LOGGED IN via CDP — abort")
                break

            btns = page.locator('[aria-label^="Easy Apply to"]')
            n = await btns.count()
            print(f"=== {kw}: {n} EA ===")
            if n == 0:
                continue

            for i in range(min(n, 8)):
                try:
                    btn = page.locator('[aria-label^="Easy Apply to"]').nth(i)
                    aria = await btn.get_attribute('aria-label', timeout=3000) or ''
                except Exception:
                    continue
                rest = aria.replace('Easy Apply to ', '')
                if ' at ' not in rest:
                    continue
                role, company = rest.rsplit(' at ', 1)
                role, company = role.strip(), company.strip()
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
                    d = page.locator('[aria-label="Dismiss"]')
                    if await d.count() > 0:
                        await d.first.click()
                        await page.wait_for_timeout(500)
                except Exception as e:
                    print(f"  ERR {company}: {str(e)[:80]}")

        print(f"\nDONE. Submitted: {total}")

if __name__ == '__main__':
    asyncio.run(main())
