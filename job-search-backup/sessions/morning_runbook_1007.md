# Morning Runbook — Oct 6 (fresh LinkedIn + iimjobs windows)

Target: close the 100-new gap (~63 remaining). Everything below is STAGED — run in order.

## 0. Preconditions
- [ ] Say "go" → relaunch session checks: headful Brave 9333 must be logged into LinkedIn + iimjobs (both tabs open).
- [ ] If session expired: relaunch headful with `/tmp/brave_main_copy_v2` profile (no --headless flag), user logs in, then continue.

## 1. LinkedIn EXT capture (~10 min, do FIRST — throttle is fresh)
```bash
nohup python3 -u /tmp/ext_capture_v2.py > /tmp/ext_cap_morning.log 2>&1 &
```
- 10 parked EXT roles in `/tmp/li_nonea_queue.json` (incl. GALE Associate Director Paid Social — whitelisted).
- If aria-label button absent again, wait 30 min post-login and retry (button renders after full session warm-up).
- Result → `/tmp/li_ext_captured.json` → fan out SubagentWorkflow agents on external ATS URLs (template: wf_457aea07764c).

## 2. iimjobs pass-6 (386-job queue, cap 45)
```bash
nohup python3 -u /tmp/iim_pass6_worker.py > /tmp/iim_pass6_morning.log 2>&1 &
```
- Monitor via `grep -cE ' APPLIED:' /tmp/iim_pass6_morning.log`
- Cap counts APPLIED only. Stop on 3 consecutive errors.
- Reconcile receipts after: IMAP `SINCE "06-Oct-2026" FROM "iimjobs.com"` (⚠️ TODAY IS Oct 6 now — SINCE must match).

## 3. Fresh LinkedIn alerts EA batch (after pass-6 or in parallel with EXT capture)
- Harvest: `python3 /tmp/li_alerts_harvest2.py` (pulls TODAY's alert emails → fresh jids → EA/EXT classify)
- Gate → `/tmp/li_ea_tasks_<date>.json` → run verify-runner:
```bash
sed "s#'/tmp/li_ea_tasks_alerts.json'#'/tmp/li_ea_tasks_$(date +%m%d).json'#" /tmp/li_ea_alerts_run.py > /tmp/li_ea_today.py
nohup python3 -u /tmp/li_ea_today.py > /tmp/ea_today.log 2>&1 &
```
- Cautious pacing: 200s gaps built in. EA daily throttle ≈110 modal opens — batch ≤40/day.

## 4. Parallel-agent non-EA applies
- After step 1 yields ATS URLs: SubagentWorkflow per role (see wf_457aea07764c script as template).
- ibaby EA paused on "years of Retail App experience" — needs USER's real answer before resubmitting.

## Gates reminder (unchanged)
- Seniority: head|director|vp|lead|principal|chief|manager|gm (+ Associate/Deputy DIRECTOR whitelist)
- Junior block: intern|trainee|executive|assistant|coordinator|associate|junior|fresher
- No pure-sales/collections; healthcare blocked; excluded: swiggy/groww/richpanel/jobgether
- CTC 46/expected 52/min 48 · notice Immediate · phone 7977110915
- NO emails without explicit user approval.

## Tonight (Oct 5) results for continuity
- 106 iimjobs receipts + 9 EA confirmed = ~115 applications Oct 5; tracker 1,447.
- EXT roles parked: GALE AD Paid Social, Gem3s Growth Head (phone-OTP caveat), Jainam AVP, AppKhichadi Affiliate Head, Altagic BizHead, DICHIT Growth Lead, TravClan GM + MICE Head. Night career-page blitz (wf_457aea07764c) covers these — check its results before re-hunting.
- Night agents hunt WITHOUT LinkedIn (career pages/ATS direct). Any login-walled ATS stays parked for LinkedIn-apply tomorrow.
