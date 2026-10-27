# Pipeline Decision Graph v3

## Canonical Resume → SUPERSEDED (Oct 2 jd_routing_rule)
**3 VARIANT PDFs, routed per JD** by `pipeline_v2/common.py:route_resume()`:
- `AI_GTM` → `/Users/Subho/Downloads/Subhajit_Das_AI_GTM_Growth_Systems.pdf` (AI/LLM/agentic/ML JDs)
- `DigitalBiz` → `/Users/Subho/Downloads/Subhajit_Das_Growth_Digital_Business.pdf` (Head/VP Growth, partnerships, BD, GTM)
- `MarTech` → `/Users/Subho/Downloads/Subhajit_Das_Growth_Marketing_MarTech.pdf` (marketing/CRM/lifecycle/demand-gen; DEFAULT fallback)
Tie-break: 'marketing' in title → MarTech. All 3 verified 212KB %PDF-1.4 (Oct 2).
Legacy single-resume `Sub_tara.pdf` (338KB) only in pre-Oct-2 scripts (li_batch_v3, greenhouse_apply, monid_blitz) — do not use for new applies.

## Tracker (CANONICAL — updated Oct 27)
`/Users/Subho/omniclaw/applied_companies_tracker.json` (gzip; 1754 entries, 22 on 2026-10-27). Desktop copy merged in Oct 26 consolidation — do not treat as canonical. Dedupe: `~/omniclaw/dedupe.json` (1518 companies / 110 urls).

## End-to-End Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│  PIPELINE START                                                          │
│  Resume: /Users/Subho/Downloads/Sub_tara.pdf                             │
│  Tracker: /Users/Subho/Desktop/applied_companies_tracker.json            │
│  Monid Budget: $4.95 (Sep 28)                                            │
└──────────────────────────┬──────────────────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  STAGE 1: MULTI-SOURCE DISCOVERY                                         │
│  Sources (parallel):                                                     │
│    1. LinkedIn Guest API (FREE) — 12 queries, f_AL=true                  │
│    2. Lever public API (FREE) — 47+ companies                            │
│    3. Greenhouse boards API (FREE) — 23+ companies                       │
│    4. Ashby posting API (FREE) — 12 companies                            │
│    5. Gmail IMAP alerts                                                  │
│    6. Naukri Gulf scrape                                                 │
│    7. Wellfound scrape                                                   │
│    8. Workable API                                                       │
│  Output: /tmp/multi_source_jobs.json                                     │
│  Script: pipeline/multi_source/multi_source_harvest.py                   │
└──────────────┬───────────────────────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  STAGE 2: PREFLIGHT GATES (v3 — RIGOROUS)                                │
│  R25: reject if company in EXCLUDE_COMPANIES (swiggy, groww, etc.)       │
│  R25b: reject if IRRELEVANT_KEYWORDS match (b2b, saas, cloud, etc.)     │
│  R8:  reject if title has JUNIOR_KW (intern, junior, associate...)       │
│  R7:  reject if NO SENIOR_TITLES (head, director, vp, chief, GM...)     │
│  R7b: reject if NO RELEVANT_KEYWORDS (growth, marketing, gtm, ai...)    │
│  R11: reject if salary < 35 LPA (when known)                            │
│  R14: reject if experience < 8 yrs (Director) or < 10 yrs (VP)          │
│  R22: DEDUP — company already in tracker                                │
│  Location: TIER2_BLOCK (jaipur, lucknow, nagpur, indore, mohali...)    │
│  Output: passing jobs → apply queue                                     │
└──────────────┬───────────────────────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  STAGE 3: APPLY (Multi-channel)                                          │
│  Priority:                                                               │
│    1. LinkedIn Easy Apply (CDP + cookies)                                │
│    2. Lever ATS (public form)                                            │
│    3. Greenhouse ATS (public form)                                       │
│    4. iimjobs (browser automation)                                       │
│    5. Humanbit/Scrabble ATS                                             │
│    6. Email outreach (E1-E4 rules)                                      │
│  Resume: /Users/Subho/Downloads/Sub_tara.pdf (attached on EA/email)     │
│  Throttle: 60-120s between submits (R28)                                │
│  R27: Single-writer — one browser at a time                             │
└──────────────┬───────────────────────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  STAGE 4: OUTREACH (if applied, not responded)                           │
│  1. Find contacts via Happenstance (2215 connections)                    │
│  2. Match contacts to applied companies (strict match)                   │
│  3. Email lookup via Monid/Hunter.io ($0.024/lookup)                    │
│  4. Generate Minto-Pyramid email (R21 metrics only)                     │
│  5. Humanizer check (score ≥ 8)                                         │
│  6. User approval → send via Gmail SMTP                                │
│  Resume: /Users/Subho/Downloads/Sub_tara.pdf (attached)                 │
│  Skip list: Tanmay Sahani, Syed Zulfiqar Ali                            │
└──────────────┬───────────────────────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  STAGE 5: MONITOR                                                        │
│  Tracker: update applied_companies_tracker.json                         │
│  Log: /tmp/channel_results/blitz.jsonl (append-only)                    │
│  Metrics: applications count, unique companies, response rate           │
└─────────────────────────────────────────────────────────────────────────┘
```

## KEY RULES (ALL LOCKED)

### R21-R28 (Sep 8, non-negotiable)
- **R21 TRUE-STORY**: Only the 8 timeline entries. NO Paytm. Signature: `Growth Leader | IIM Trichy | Fintech & D2C`
- **R22 COMPANY-LEVEL DEDUP**: Match company name across tracker entries
- **R23 CANONICAL GATE**: preflight_check.check() mandatory on ALL paths
- **R24 NAMED-EMAIL ONLY**: careers@/hr@/talent@ BANNED. Priority: EA > named person > ATS
- **R25 DOMAIN GUARD**: BLOCK b2b/saas/cloud/software + hospitality/edtech/design/real estate
- **R26 EA ANSWER BANK**: exp=11+ | CTC curr=**45L** | CTC exp=**50L** | notice=Immediate | email=sdas22@gmail.com
  - **User-confirmed Oct 23: expected 50 LPA, current 45 LPA.** An earlier revision of this line said `exp=45L` and was wrong — do not "correct" it back.
  - Field matching: current → `/^current.*(ctc|salary|package|compensation)/` → "45 LPA"; expected → `/^expected.*(...)/` → "50 LPA". Never fill both fields with the same value.
- **R27 SINGLE-WRITER**: One browser at a time on LinkedIn
- **R28 TEST-FIRST EA**: Verify first application before batch. Delays 60-120s

### E1-E4 (Email Rules)
- **E1**: NO mass email to careers@ without verified opening
- **E2**: NO generic aliases (info@, contact@, hr@)
- **E3**: Named person only (firstname.lastname@company.com)
- **E4**: All 5 checks before send: verified opening + named contact + senior role + real company + relevance ≥ 7

### NEW Sep 28 (R29 updated Oct 21)
- **R29 CANONICAL RESUME (SUPERSEDED Oct 2)**: single `Sub_tara.pdf` replaced by 3-variant routing (`route_resume()`); applies must attach the routed variant, never a hardcoded path
- **R30 SKIP LIST**: Tanmay Sahani, Syed Zulfiqar Ali (do not contact)
- **R31 DEDUP TRACKER**: Log sent emails to prevent duplicate sends
- **R32 MULTI-SOURCE HARVEST**: Use all 8 sources (LinkedIn + Lever + GH + Ashby + Gmail + Naukri + Wellfound + Workable)

### NEW Oct 23 (iimjobs batch campaign — R33-R38)
- **R33 iimjobs SERVER-SIDE APPLIED-STATE CHECK (NEW, highest-impact)**: before applying, read the button state on the job page — `/^applied/i` means the account already applied in a *prior session* → SKIP, and never count it as a new application. Local-ledger dedup (R22) is NOT sufficient: a freshly discovered 195-role queue turned out ~100% already-applied. Discovery must therefore dedup against applied state, not just `/tmp/iim_results.jsonl`.
- **R34 iimjobs APPLY MECHANICS (proven 50+ applies)**: (a) the apply button is the **LAST** `/^apply$/i` match — the first match is a decoy; (b) React requires the full pointer chain `pointerdown→mousedown→pointerup→mouseup→click`; (c) **trusted fills only** (`page.fill`) — JS `value`-setters leave `Next` permanently `disabled`; (d) notice period is a **checkbox** ("15 days or less"), not a radio; (e) relocate/consent radios are per-group `label[for=id]` clicks — answer Yes only when truthful (R26 honesty); otherwise PAUSE.
- **R35 LinkedIn HEADLESS SESSION GATE**: immediately after cookie injection the first navigations serve the **language-picker interstitial** (0 job cards). Warm up with one navigation and assert `.base-search-card` count > 5 before harvesting. `/jobs/recommended` is **not available** on the headless profile (language picker only) → harvest `/jobs/search/` and split EA vs non-EA client-side via card text ("Easy Apply"). Non-EA = external ATS = the only LinkedIn roles headless-applicable.
- **R36 LinkedIn SOFT-THROTTLE**: rapid multi-query harvesting (84 query×location combos) triggers soft-throttling that returns near-empty pages while the same URL still works in a fresh tab. On `cards == 0`: wait 8s and retry once, else skip the query — never treat an empty page as "no jobs".
- **R37 TRACKER DATE INTEGRITY**: cumulative append-only result logs with **no per-row timestamps** must not be back-dated. Identify the current session's rows by append-order tail and flag the remainder `date_confidence=unverified-no-timestamp-in-cumulative-log`.
- **R38 VERIFIED-TALLY DEFINITION**: only `ok=true` ledger rows (or tracker rows explicitly dated today) count as applications. `wizard-pause`, `no-apply-btn`, `already-applied-prior`, and `err` rows are NOT applications and must never inflate the count.
- **R39 NO MANAGER-LEVEL ROLES (NEW Oct 24)**: never apply to roles whose title contains "manager" (case-insensitive, includes Senior Manager / Assistant Manager / Manager-Senior Manager). Enforced in three places: (a) discovery-time filter, (b) runtime skip inside the iimjobs applier's `for e in QUEUE:` loop via `MANAGER_TITLE_GUARD`, (c) ATS queue build drops manager-titled roles before the lane starts. Rationale: the seniority ladder is Head / Director / VP / AVP / Chief / GM — "Manager" is an IC level the user does not want. 5 manager-titled applications had already been submitted on Oct 23 before this rule existed (Director/Senior Manager-GCC Growth, Sigma Staffing-Sr Manager-Demand Planning, Exotel-Sr Manager-Growth Marketing, Compunnel-Sr Manager-Growth & Client Acquisition, Headsup-Manager/Sr Manager-Brand Partnerships); they are not reversible, so they are recorded and excluded going forward.
- **R26 COMPLIANCE NOTE (CORRECTED Oct 23)**: automation must fill **45 current / 50 expected**. This rule line itself was wrong (`exp=45L`), and a batch was then "fixed" to 45/45 — the wrong direction. User confirmed expected=50. Applications submitted while the 45/45 bank was live carry expected=45; see docs/RUN_2026_10_23.md. Confirm this bank with the user before any bulk run.

## OUTREACH APPROVED FORMAT (Sep 24 - 8/8 success)
```
Subject: Referral Request - Senior Marketing/Growth Leadership | {company}
Body: 
  Hi {name},
  Hope you're doing well!
  I'm Subhajit, exploring senior marketing & growth leadership opportunities...
  [references their role at company]
  [11+ years AI-driven growth, demand generation, team leadership]
  [interested in {company} opportunities]
  [request referral/guidance]
  [offer brief call]
  Best regards,
  Subhajit Das
  +91 79771 10915
  {linkedin_url}
```

## MONID CONFIG
```
API Key: monid_live_5AkYMC0GCPc5eOh7Mi6LFJIS
Balance: $4.95 (Sep 28)
Endpoints:
  - hunterio/email-finder: $0.024/lookup
  - hunterio/people/find: $0.005/lookup
  - the-companies-api/find_company_email_patterns: $0.01
  - clay/enrichment/work-email: $0.0712
```

## HAPPENSTANCE CONFIG
```
File: /Users/Subho/happenstance-agent-find/connections_data.json
Total connections: 2215
Senior contacts: ~200 (head/director/vp/chief/founder/HR)
No email addresses stored (use Monid lookup)
```

## GOOGLE SHEET TARGETS
```
Sheet ID: 1X6F1hJqxfbaXofK-EajSOft3W_AkobMtFNo2yJ4TXwk
Companies: 59 (Fintech 22, AI/ML 11, SaaS 4, Healthcare 3, HR Tech 3, etc.)
Relevant (post-filter): 44
Source CSV: /tmp/sheet_companies.json
```

## FILE MAP
```
/Users/Subho/job_pipeline/
├── DECISION_GRAPH.md ← THIS FILE
├── cover_letter_gen.py ← Minto Pyramid generator
├── monid_blitz.py ← Parallel discovery + apply
├── preflight_check.py ← STRICT preflight (R21-R28)
├── pipeline/
│   ├── __init__.py
│   ├── preflight.py ← Original preflight (less strict)
│   ├── discover.py ← iimjobs discovery
│   ├── apply.py ← iimjobs apply
│   ├── outreach.py ← Email/LinkedIn outreach
│   └── run.py ← Pipeline runner
├── multi_source/
│   └── multi_source_harvest.py ← 8-source aggregator
├── scripts/
│   ├── harvest_easyapply.py ← LinkedIn Guest API harvest
│   ├── easyapply_worker50.py ← LinkedIn EA worker
│   └── automated_linkedin_apply.py ← LinkedIn apply
├── decisions/
│   └── job_application_pipeline.md ← Full decision log
└── attachments/
    └── (old resumes - DO NOT USE)
```

## R40 — Analyst roles are OUT OF SCOPE (2026-10-26)
User directive: "ai analyst is wrong role".
Any title containing **analyst** (AI Analyst, Senior/Staff AI Analyst, Marketing Analyst, Data Analyst, Product Analyst) sits BELOW the target ladder (Head / Director / VP / AVP / Chief / GM) -> never shortlist, never apply.
Applies to: Zscaler Staff AI Analyst GTM Intelligence (already submitted 2026-10-26 before this rule — kept in tracker for dedup only, status=applied_wrong_role), Zscaler Senior AI Analyst (submission ABORTED before submit).

## R41 — GCC search vocabulary = previously applied eligible role types (2026-10-26)
User directive: "include earlier applied eligible role with which we did apply for gcc role types and use them to search for more relevant gcc roles".
Source of truth: role-type noun frequency mined from /Users/Subho/Desktop/applied_companies_tracker.json titles of VERIFIED prior applications:
marketing 437, growth 162, digital 68, sales 61, brand 56, gtm 42, operations 37, strategy 26, product marketing 25, ai 21, partnerships 21, revenue 16, category 7, analytics 7, commercial 4, merchant 4, partnership 4, crm 3, lifecycle 2, go-to-market 2, insights 1.
GCC harvesting MUST use these nouns (plus their AI/RevOps variants) as search terms, not just "gtm"/"growth".

## R42 — LinkedIn session recovery: purge + visible relaunch + manual login (2026-10-27)
A server-flagged `li_at` redirect-loops on EVERY LinkedIn URL; cookie surgery (keep only li_at) cannot fix it. Recovery chain: purge ALL LinkedIn cookies from the profile → relaunch the CDP browser VISIBLE (headless gives no window) → manual login → re-harvest. Non-LinkedIn sessions on the same profile (iimjobs/Naukri/CutShort) survive the purge — never relaunch with a fresh user-data-dir. LinkedIn also rejects CloakBrowser outright (HTTP 999) — real-browser UA only (Oct 26 rule).

## R43 — Gate input contract: desc = real JD text, never title-only (2026-10-27)
Title-only records score ~47 RED; the same record with real description text scores 70 GREEN. Harvesters MUST fetch descriptions before gating. Related hardening: gate `parsed_role` truncates at dash — normalize titles (dash→comma) pre-gate or function keywords after the dash are lost. LinkedIn /jobs/view/ pages do NOT hydrate title/desc selectors via direct nav — parse body innerText instead (title = line after company line; desc = text after "About the job"). Permutation scoring invariant: base <40 never lifts; 40–69 lifts to GREEN only on strong resume-variant evidence.

## R44 — Saved-items audit lane (2026-10-27)
LinkedIn saved jobs = personal pre-qualified shortlist. Audit flow: gate-score each → dedupe vs tracker → scope filter (India+UAE hard rule — OSOME Thailand rejected). Oct 27 result: 10 saved jobs → 4 already applied (Wego, UMO, Pine Labs, HighLevel) · 1 out-of-scope · 1 fresh GREEN → Snapmint AD Growth & Retention, Bengaluru (70) → APPLY. Saved posts = recruiter-lead lane (~12 leads: Botim VP Growth UAE team, EY GCC, Stripe dup) — extract post URLs → gate before treating as candidates.

## R45 — Taleo guest-alias + Greenhouse remix-form apply recipes (2026-10-27)
UHG/Optum Taleo registered-email wall bypassed via Gmail alias (`sdas22+uhg@gmail.com`) → guest apply; re-opening a submitted app shows duplicate-error (that IS the confirmation). WPP Greenhouse remix-form: hidden react-select shim fills ONLY on real dropdown-option click (typed search text does not fill); reCAPTCHA Enterprise invisible/auto-scored server-side; form container id is `application-form` with dash. iimjobs note: title 'Executive' = JUNIOR there. WPP sponsorship field: pick Citizen for India-national roles.
