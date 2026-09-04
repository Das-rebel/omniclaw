#!/usr/bin/env python3
"""Wellfound applier: opens job, clicks Apply, writes note, submits."""
import asyncio, sys, json
from playwright.async_api import async_playwright
import browser_cookie3
sys.path.insert(0, '/Users/Subho/job_pipeline')
from preflight_check import check

TRACKER = '/Users/Subho/Desktop/applied_companies_tracker.json'
NOTE = ("I'm a growth marketing leader with 10+ years scaling fintech and consumer "
        "businesses (Paytm, Groww, Niro - 2x-7x growth, ₹70Cr+/month P&L). I build "
        "AI-led growth systems end-to-end: acquisition, lifecycle, retention and "
        "monetization. Excited about this role - happy to share specifics.")

def wf_cookies():
    return [{
        'name': c.name, 'value': c.value, 'domain': c.domain, 'path': c.path,
        'secure': bool(getattr(c, 'secure', True)),
        'httpOnly': bool(getattr(c, 'http_only', False)),
        'expires': c.expires if isinstance(getattr(c, 'expires', -1), (int, float)) else -1,
    } for c in browser_cookie3.brave(domain_name='wellfound.com')]

def log_applied(company, role):
    d = json.load(open(TRACKER))
    d.setdefault('applied_companies', []).append(f"{company} - {role} (Wellfound)")
    json.dump(d, open(TRACKER, 'w'), indent=1)
    print(f"  TRACKED: {company} - {role}")

async def main():
    targets = sys.argv[1:] or [
        "4617915-director-product-marketing",
        "4424543-director-digital-marketing",
        "4275954-growth-marketing-director",
        "4594826-head-of-marketing",
        "4627606-vp-integrated-marketing",
        "4391596-vp-product-marketing",
        "4307670-vice-president-of-growth",
        "4627506-lifecycle-marketing-lead",
        "4589637-performance-marketing-lead",
    ]
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        ctx = await b.new_context()
        await ctx.add_cookies(wf_cookies())
        pg = await ctx.new_page()
        applied = 0

        for t in targets:
            url = f"https://wellfound.com/jobs/{t}"
            try:
                await pg.goto(url, timeout=20000)
            except Exception:
                print(f"{t}: goto err"); continue
            await pg.wait_for_timeout(3000)
            title = await pg.title()
            # company from title: "Role at Company • ..."
            company = ''
            if ' at ' in title:
                company = title.split(' at ')[1].split(' •')[0].split(' |')[0].strip()
            role = title.split(' at ')[0].split(' •')[0].strip()
            ok, reason = check(company, role)
            if not ok:
                print(f"SKIP {company or '?'}: {reason}"); continue
            print(f"=== {role[:40]} @ {company}")
            try:
                # close any open notification panel/overlay first
                try:
                    for sel in ['button:has-text("RECENT NOTIFICATIONS")', '[aria-label="Close"]', '[data-test="close"]', 'button:has-text("Mark all as read")']:
                        el = pg.locator(sel).first
                        if await el.count() > 0 and await el.is_visible():
                            await pg.keyboard.press('Escape', timeout=2000)
                            break
                except Exception:
                    pass
                await pg.wait_for_timeout(500)
                # click Apply via text-exact locator with fallback to JS
                try:
                    await pg.get_by_role('button', name='Apply', exact=True).first.click(timeout=8000)
                except Exception:
                    await pg.evaluate("""() => {
                        const bts = Array.from(document.querySelectorAll('button'));
                        const a = bts.find(x => (x.textContent||'').trim() === 'Apply');
                        if (a) a.click();
                    }""")
                await pg.wait_for_timeout(3500)
                for step in range(4):
                    # answer all visible radio groups: pick 'Yes' if present else first
                    radios = pg.locator('input[type="radio"]:visible')
                    answered = set()
                    nr = await radios.count()
                    for i in range(nr):
                        r = radios.nth(i)
                        try:
                            nm = await r.get_attribute('name', timeout=1500) or f'g{i}'
                            if nm in answered: continue
                            val = (await r.get_attribute('value', timeout=1500) or '').lower()
                            if val != 'yes':
                                # try to find a 'yes' sibling in same group
                                grp = pg.locator(f'input[type="radio"][name="{nm}"]')
                                picked = False
                                for j in range(await grp.count()):
                                    if (await grp.nth(j).get_attribute('value') or '').lower() == 'yes':
                                        await grp.nth(j).check(timeout=2000); picked = True; break
                                if not picked:
                                    await r.check(timeout=2000)
                            else:
                                await r.check(timeout=2000)
                            answered.add(nm)
                        except Exception:
                            pass
                    # fill note: last visible textarea
                    tas = pg.locator('textarea:visible')
                    if await tas.count() > 0:
                        try:
                            await tas.nth(await tas.count() - 1).fill(NOTE, timeout=4000)
                        except Exception:
                            pass
                    # advance if there's a Next/Continue
                    adv = pg.locator('button:has-text("Next"), button:has-text("Continue")')
                    if await adv.count() > 0 and step < 3:
                        await adv.first.click(timeout=3000)
                        await pg.wait_for_timeout(1500)
                    else:
                        break
                send = pg.locator('button:has-text("Send application")')
                if await send.count() > 0:
                    await send.first.click()
                    await pg.wait_for_timeout(3000)
                    body = await pg.inner_text('body')
                    if 'applied' in body.lower() or 'success' in body.lower():
                        print("  SUBMITTED!")
                        applied += 1
                        log_applied(company, role)
                    else:
                        # check if button gone (= submitted)
                        if await send.count() == 0:
                            print("  SUBMITTED (btn gone)")
                            applied += 1
                            log_applied(company, role)
                        else:
                            print("  unsure - check manually")
                else:
                    print("  no Send button")
            except Exception as e:
                print(f"  ERR: {str(e)[:80]}")
        print(f"\nDONE: {applied} submitted")
        await b.close()

asyncio.run(main())
