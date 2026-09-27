# Pipeline Decision Graph v3

## Canonical Resume
**`/Users/Subho/Downloads/Sub_tara.pdf`** (339KB, Sep 28)
All scripts, all applications use this file ONLY. No other resume.

## Tracker
`/Users/Subho/Desktop/applied_companies_tracker.json` (1171+ entries, Sep 28)

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
- **R26 EA ANSWER BANK**: exp=11+ | CTC curr=45L | CTC exp=45L | notice=Immediate | email=sdas22@gmail.com
- **R27 SINGLE-WRITER**: One browser at a time on LinkedIn
- **R28 TEST-FIRST EA**: Verify first application before batch. Delays 60-120s

### E1-E4 (Email Rules)
- **E1**: NO mass email to careers@ without verified opening
- **E2**: NO generic aliases (info@, contact@, hr@)
- **E3**: Named person only (firstname.lastname@company.com)
- **E4**: All 5 checks before send: verified opening + named contact + senior role + real company + relevance ≥ 7

### NEW Sep 28
- **R29 CANONICAL RESUME**: `/Users/Subho/Downloads/Sub_tara.pdf` ONLY
- **R30 SKIP LIST**: Tanmay Sahani, Syed Zulfiqar Ali (do not contact)
- **R31 DEDUP TRACKER**: Log sent emails to prevent duplicate sends
- **R32 MULTI-SOURCE HARVEST**: Use all 8 sources (LinkedIn + Lever + GH + Ashby + Gmail + Naukri + Wellfound + Workable)

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
