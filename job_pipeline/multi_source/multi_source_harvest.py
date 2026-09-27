"""
MULTI-SOURCE JOB SEARCH ARCHITECTURE
=====================================
Aggregates fresh senior (Director+/VP/Head/CMO) AI-GTM + Fintech roles from:

  1. LinkedIn Guest API       (no login, proven working)
  2. Lever public API         (no login, proven working)
  3. Greenhouse boards API    (no login)
  4. Ashby posting API        (no login)
  5. Workable/applytojob      (no login)
  6. Naukri Gulf              (public search scrape)
  7. Gmail job alerts         (IMAP w/ app password)
  8. Wellfound                (public scrape)
  9. Twitter/X hiring posts   (via nitter-like public search)

All results → dedupe (company+title) → preflight → rank by
AI-GTM/Fintech relevance score → apply queue.

Usage:
    python3 multi_source_harvest.py            # harvest all sources
    python3 multi_source_harvest.py --sources linkedin,lever
"""
import json, re, time, sys, os, imaplib, email as emailmod
from email.header import decode_header
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import requests
from bs4 import BeautifulSoup

sys.path.insert(0, '/Users/Subho/job_pipeline')
from pipeline.preflight import check as preflight_check

# ─── CONFIG ─────────────────────────────────────────────────
UA = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'}
TRACKER = '/Users/Subho/Desktop/applied_companies_tracker.json'
OUT = '/tmp/multi_source_jobs.json'
GMAIL_USER = 'sdas22@gmail.com'
GMAIL_APP_PW = 'xgltjfklmjgslthf'

SENIOR = re.compile(r'\b(head|director|vp|vice president|chief|president|cro|cgo|cmo|cto|founder|founding|general manager|gm|svp|evp|avp|partner)\b', re.I)
RELEV = re.compile(r'growth|marketing|gtm|go.to.market|demand|revenue|product marketing|brand|digital|acquisition|performance|ai|fintech|lending|wealth|payments|nbfc|insur', re.I)
BAD_KW = re.compile(r'\b(intern|junior|entry|fresher|trainee|0 to 2|0-2 years|1-2 years|executive assistant|associate intern)\b', re.I)

AI_BONUS = re.compile(r'\bai\b|llm|gpt|generative|gen.?ai|agentic|ai.?native|machine.?learning', re.I)
FIN_BONUS = re.compile(r'fintech|nbfc|lending|wealth|payments|insur|bank|credit|loan|bnpl', re.I)

QUERY_SET = [
    # AI GTM
    'ai growth marketing', 'ai gtm lead', 'founding gtm ai', 'ai marketing head',
    'ai product marketing director', 'head of ai growth', 'gtm lead ai startup',
    # Fintech
    'fintech marketing head', 'fintech vp growth', 'nbfc marketing director',
    'lending growth head', 'wealthtech marketing', 'fintech cmo india',
    'digital lending director', 'payments marketing head',
    # Senior growth general
    'head of growth india', 'growth marketing director india', 'vp marketing india',
    'chief marketing officer startup', 'demand generation head india',
    'performance marketing head', 'product marketing director india',
]


# ─── SOURCE: LinkedIn Guest API ─────────────────────────────
def src_linkedin(query, pages=5):
    import urllib.parse, html as htmlmod
    out = []
    for pg in range(pages):
        try:
            u = ('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords='
                 + urllib.parse.quote(query) + '&location=India&f_AL=true&f_TPR=r604800&start=' + str(pg*10))
            r = requests.get(u, headers=UA, timeout=15)
            if r.status_code != 200 or len(r.text) < 500:
                break
            soup = BeautifulSoup(r.text, 'html.parser')
            for card in soup.select('li'):
                a = card.select_one('a[href*="/jobs/view/"]')
                if not a:
                    continue
                href = htmlmod.unescape(a.get('href', '')).split('?')[0]
                m = re.search(r'-(\d{10,})(?:/)?$', href)
                if not m:
                    continue
                t_el = card.select_one('.base-search-card__title, h3')
                c_el = card.select_one('.base-search-card__subtitle, h4')
                l_el = card.select_one('.job-search-card__location')
                out.append({
                    'source': 'linkedin',
                    'jid': m.group(1),
                    'title': ' '.join((t_el.get_text(' ', strip=True) if t_el else '').split()),
                    'company': ' '.join((c_el.get_text(' ', strip=True) if c_el else '').split()),
                    'location': ' '.join((l_el.get_text(' ', strip=True) if l_el else 'India').split()),
                    'url': f'https://www.linkedin.com/jobs/view/{m.group(1)}/',
                })
        except Exception:
            break
        time.sleep(0.3)
    return out


# ─── SOURCE: Lever public API ───────────────────────────────
LEVER_COMPANIES = [
    'razorpay', 'cred', 'meesho', 'phonepe', 'paytm', 'mobikwik', 'freecharge',
    'cashfree', 'cleartax', 'lendingkart', 'flexiloans', 'ofbusiness', 'khatabook',
    'navi', 'slice', 'uni', 'rupeek', 'earlysalary', 'wakefit', 'upgrad',
    'delhivery', 'shadowfax', 'coinswitch', 'coindcx', 'observe-ai', 'uniphore',
    'inmobi', 'clevertap', 'moengage', 'webengage', 'mamaearth', 'purplle',
    'nykaa', 'acko', 'turtlemint', 'urban-company', 'lenskart', 'jar', 'smallcase',
    'zerodha', 'groww-1', 'cred-club', 'open', 'juspay', 'setu', 'm2p',
]

def src_lever():
    out = []
    def one(c):
        try:
            r = requests.get(f'https://api.lever.co/v0/postings/{c}', headers=UA, timeout=8)
            if r.status_code != 200:
                return []
            jobs = []
            for j in r.json():
                title = j.get('text', '')
                jobs.append({
                    'source': 'lever',
                    'title': title,
                    'company': c.replace('-', ' ').title(),
                    'location': j.get('categories', {}).get('location', '') or 'India',
                    'url': j.get('hostedUrl', ''),
                })
            return jobs
        except Exception:
            return []
    with ThreadPoolExecutor(max_workers=12) as ex:
        for res in ex.map(one, LEVER_COMPANIES):
            out.extend(res)
    return out


# ─── SOURCE: Greenhouse boards API ──────────────────────────
GH_COMPANIES = ['razorpay', 'cred', 'phonepe', 'urbancompany', 'lenskart', 'bharatpe',
                'swiggy', 'mamaearth', 'caratlane', 'meesho', 'navi', 'cashfree',
                'paytm', 'mobikwik', 'lendingkart', 'ofbusiness', 'jar', 'smallcase',
                'zerodha', 'groww', 'open', 'juspay', 'setu', 'm2pfintech']

def src_greenhouse():
    out = []
    def one(c):
        try:
            r = requests.get(f'https://boards-api.greenhouse.io/v1/boards/{c}/jobs', headers=UA, timeout=8)
            if r.status_code != 200:
                return []
            jobs = []
            for j in r.json().get('jobs', []):
                jobs.append({
                    'source': 'greenhouse',
                    'title': j.get('title', ''),
                    'company': c.replace('-', ' ').title(),
                    'location': j.get('location', {}).get('name', '') if isinstance(j.get('location'), dict) else str(j.get('location', '')),
                    'url': j.get('absolute_url', ''),
                })
            return jobs
        except Exception:
            return []
    with ThreadPoolExecutor(max_workers=12) as ex:
        for res in ex.map(one, GH_COMPANIES):
            out.extend(res)
    return out


# ─── SOURCE: Ashby posting API ──────────────────────────────
ASHBY_COMPANIES = ['razorpay', 'cred', 'phonepe', 'meesho', 'urban-company', 'lenskart',
                   'navi', 'jar', 'smallcase', 'open', 'juspay', 'setu']

def src_ashby():
    out = []
    def one(c):
        try:
            r = requests.get(f'https://api.ashbyhq.com/posting-api/job-board/{c}', headers=UA, timeout=8)
            if r.status_code != 200:
                return []
            jobs = []
            for j in r.json().get('jobs', []):
                jobs.append({
                    'source': 'ashby',
                    'title': j.get('title', ''),
                    'company': c.replace('-', ' ').title(),
                    'location': j.get('location', '') or 'India',
                    'url': j.get('jobUrl', ''),
                })
            return jobs
        except Exception:
            return []
    with ThreadPoolExecutor(max_workers=8) as ex:
        for res in ex.map(one, ASHBY_COMPANIES):
            out.extend(res)
    return out


# ─── SOURCE: Gmail job alerts (IMAP) ────────────────────────
def src_gmail(max_emails=40):
    out = []
    try:
        mail = imaplib.IMAP4_SSL('imap.gmail.com')
        mail.login(GMAIL_USER, GMAIL_APP_PW)
        mail.select('inbox')
        # job alerts from last 7 days
        since = time.strftime('%d-%b-%Y', time.gmtime(time.time() - 7*86400))
        _, data = mail.search(None, f'(SINCE "{since}" OR "job alert" OR "new jobs" OR "marketing" OR "growth")', 'UNSEEN')
        ids = data[0].split()[:max_emails]
        for eid in reversed(ids):  # newest first
            try:
                _, msg_data = mail.fetch(eid, '(RFC822)')
                msg = emailmod.message_from_bytes(msg_data[0][1])
                subj_raw = decode_header(msg.get('Subject', ''))[0]
                subject = subj_raw[0]
                if isinstance(subject, bytes):
                    subject = subject.decode(subj_raw[1] or 'utf-8', errors='ignore')
                frm = msg.get('From', '')
                body = ''
                if msg.is_multipart():
                    for part in msg.walk():
                        if part.get_content_type() == 'text/plain':
                            body = part.get_payload(decode=True).decode('utf-8', errors='ignore')[:3000]
                            break
                else:
                    body = msg.get_payload(decode=True).decode('utf-8', errors='ignore')[:3000]
                out.append({
                    'source': 'gmail',
                    'title': subject[:150],
                    'company': re.sub(r'[^a-zA-Z0-9 .-]', '', frm.split('@')[-1].split('.')[0]).title() if '@' in frm else '',
                    'location': 'India',
                    'url': '',
                    'body_snippet': body[:500],
                })
            except Exception:
                continue
        mail.logout()
    except Exception as e:
        print(f'  gmail error: {e}')
    return out


# ─── SOURCE: Naukri Gulf (public search) ────────────────────
def src_naukrigulf():
    out = []
    try:
        r = requests.get('https://www.naukrigulf.com/marketing-head-jobs', headers=UA, timeout=15)
        if r.status_code == 200:
            soup = BeautifulSoup(r.text, 'html.parser')
            for card in soup.select('.ng-box.srp-tuple, .job-tuple, [class*="jobInfo"]')[:30]:
                t = card.select_one('a[class*="title"], .designation, h2 a')
                c = card.select_one('.org, .company, [class*="company"]')
                l = card.select_one('.loc, [class*="location"]')
                href = t.get('href', '') if t else ''
                if t and c:
                    out.append({
                        'source': 'naukrigulf',
                        'title': t.get_text(' ', strip=True)[:120],
                        'company': c.get_text(' ', strip=True)[:80],
                        'location': l.get_text(' ', strip=True)[:60] if l else 'Gulf',
                        'url': f'https://www.naukrigulf.com{href}' if href.startswith('/') else href,
                    })
    except Exception as e:
        print(f'  naukrigulf error: {e}')
    return out


# ─── SOURCE: Wellfound (public) ─────────────────────────────
def src_wellfound():
    out = []
    try:
        r = requests.get('https://wellfound.com/role/r/head-of-marketing', headers=UA, timeout=15)
        if r.status_code == 200:
            # Wellfound embeds JSON data
            m = re.findall(r'"title":"([^"]{5,100})"[^}]*"companyName":"([^"]{2,60})"', r.text)
            seen_l = set()
            for title, company in m[:40]:
                key = f'{company}|{title}'
                if key in seen_l:
                    continue
                seen_l.add(key)
                out.append({
                    'source': 'wellfound',
                    'title': title.replace('\\u0026', '&'),
                    'company': company.replace('\\u0026', '&'),
                    'location': 'India/Remote',
                    'url': 'https://wellfound.com/jobs',
                })
    except Exception as e:
        print(f'  wellfound error: {e}')
    return out


# ─── SOURCE: Workable public boards ─────────────────────────
WORKABLE_COMPANIES = ['licious', 'spawn', 'bajajfinservhealth']

def src_workable():
    out = []
    for c in WORKABLE_COMPANIES:
        try:
            r = requests.get(f'https://apply.workable.com/api/v3/accounts/{c}/jobs', headers={**UA, 'Content-Type': 'application/json'},
                             data=json.dumps({'query': '', 'location': [], 'department': [], 'worktype': [], 'remote': []}),
                             timeout=10)
            if r.status_code == 200:
                for j in r.json().get('jobs', []):
                    out.append({
                        'source': 'workable',
                        'title': j.get('title', ''),
                        'company': c.title(),
                        'location': j.get('location', {}).get('city', '') if isinstance(j.get('location'), dict) else '',
                        'url': j.get('url', ''),
                    })
        except Exception:
            pass
    return out


# ─── AGGREGATOR ──────────────────────────────────────────────
def applied_companies():
    try:
        t = json.load(open(TRACKER))
        s = set()
        for a in t.get('applications', []):
            c = a.get('company', '').lower().strip()
            if c:
                s.add(c)
        return s
    except Exception:
        return set()


def score_job(j):
    """Relevance score: AI-GTM + Fintech + Seniority."""
    text = f"{j.get('title','')} {j.get('company','')}".lower()
    s = 0
    if SENIOR.search(j.get('title', '')):
        s += 3
    if AI_BONUS.search(text):
        s += 4
    if FIN_BONUS.search(text):
        s += 3
    if RELEV.search(j.get('title', '')):
        s += 2
    if 'india' in j.get('location', '').lower() or 'bengaluru' in j.get('location', '').lower() or 'mumbai' in j.get('location', '').lower():
        s += 1
    # source priority (easier to apply = higher)
    src_bonus = {'linkedin': 2, 'lever': 2, 'greenhouse': 2, 'ashby': 2, 'workable': 1,
                 'gmail': 0, 'naukrigulf': 0, 'wellfound': 1}
    s += src_bonus.get(j.get('source', ''), 0)
    return s


def harvest(sources=None, min_score=4):
    sources = sources or ['linkedin', 'lever', 'greenhouse', 'ashby', 'gmail', 'naukrigulf', 'wellfound', 'workable']
    applied = applied_companies()
    print(f'Already applied: {len(applied)} companies')
    print(f'Sources: {sources}\n')

    all_jobs = []

    # Run sources (some parallel)
    with ThreadPoolExecutor(max_workers=4) as ex:
        futures = {}
        if 'linkedin' in sources:
            for q in QUERY_SET[:6]:  # top 6 queries for speed
                futures[ex.submit(src_linkedin, q, 3)] = f'linkedin:{q}'
        if 'lever' in sources:
            futures[ex.submit(src_lever)] = 'lever'
        if 'greenhouse' in sources:
            futures[ex.submit(src_greenhouse)] = 'greenhouse'
        if 'ashby' in sources:
            futures[ex.submit(src_ashby)] = 'ashby'
        if 'gmail' in sources:
            futures[ex.submit(src_gmail)] = 'gmail'
        if 'naukrigulf' in sources:
            futures[ex.submit(src_naukrigulf)] = 'naukrigulf'
        if 'wellfound' in sources:
            futures[ex.submit(src_wellfound)] = 'wellfound'
        if 'workable' in sources:
            futures[ex.submit(src_workable)] = 'workable'

        for fut in as_completed(futures):
            name = futures[fut]
            try:
                res = fut.result()
                all_jobs.extend(res)
                print(f'  {name}: {len(res)} jobs')
            except Exception as e:
                print(f'  {name}: ERROR {str(e)[:50]}')

    print(f'\nRaw total: {len(all_jobs)}')

    # Dedupe by (company_lower, title_lower)
    seen = set()
    deduped = []
    for j in all_jobs:
        co = j.get('company', '').lower().strip()
        ti = j.get('title', '').lower().strip()
        if not co or not ti:
            continue
        key = co[:40] + '|' + ti[:60]
        if key in seen:
            continue
        seen.add(key)
        deduped.append(j)

    print(f'Deduped: {len(deduped)}')

    # Preflight + filter
    final = []
    skipped = {'preflight': 0, 'already': 0, 'low_score': 0, 'bad_kw': 0}
    for j in deduped:
        co = j.get('company', '').strip()
        ti = j.get('title', '').strip()
        if not co or not ti:
            continue
        co_l = co.lower()
        if co_l in applied or any(co_l in a for a in applied if len(a) > 3 and co_l in a):
            skipped['already'] += 1
            continue
        if BAD_KW.search(ti):
            skipped['bad_kw'] += 1
            continue
        ok, reason = preflight_check(co, ti, j.get('location', ''))
        if not ok:
            skipped['preflight'] += 1
            continue
        sc = score_job(j)
        if sc < min_score:
            skipped['low_score'] += 1
            continue
        j['score'] = sc
        final.append(j)

    # Sort by score desc
    final.sort(key=lambda x: -x['score'])

    print(f'Final (score >= {min_score}): {len(final)}')
    print(f'Skipped: {skipped}')

    with open(OUT, 'w') as f:
        json.dump(final, f, indent=2)
    print(f'\nSaved: {OUT}')

    print(f'\n=== TOP 30 ===')
    for i, j in enumerate(final[:30]):
        print(f'{i+1:2d}. [{j["source"]:10s}] {j["company"][:28]:28s} | {j["title"][:55]:55s} | s={j["score"]}')

    return final


if __name__ == '__main__':
    srcs = None
    if len(sys.argv) > 2 and sys.argv[1] == '--sources':
        srcs = sys.argv[2].split(',')
    harvest(srcs)
