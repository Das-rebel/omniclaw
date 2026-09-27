"""
Job Discovery Module
==================
Discovers jobs from iimjobs using headless browser.
"""

import subprocess
import json
import re

SEARCH_URLS = {
    'head_marketing': 'https://www.iimjobs.com/search/head-marketing-jobs-in-india.html',
    'vp_marketing': 'https://www.iimjobs.com/search/vp-marketing-jobs-in-india.html',
    'director_marketing': 'https://www.iimjobs.com/search/director-marketing-jobs-in-india.html',
    'head_growth': 'https://www.iimjobs.com/search/head-growth-jobs-in-india.html',
    'cmo': 'https://www.iimjobs.com/search/chief-marketing-officer-jobs-in-india.html',
    'head_brand': 'https://www.iimjobs.com/search/head-brand-jobs-in-india.html',
    'head_digital': 'https://www.iimjobs.com/search/head-digital-marketing-jobs-in-india.html',
}


def harvest_iimjobs_browser(url):
    """Harvest jobs using cmd-headless browser."""
    cmd = ['cmd-headless', '--json', f'go to {url}']
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
        output = result.stdout
        try:
            data = json.loads(output)
            return data.get('text', '')
        except:
            return output
    except Exception as e:
        print(f"Browser error: {e}")
        return ""


def parse_iimjobs_text(text):
    """Parse job listings from iimjobs page text."""
    jobs = []
    lines = [l.strip() for l in text.split('\n') if l.strip()]
    
    # Generic title words that shouldn't be parsed as company
    generic_terms = {'head', 'lead', 'manager', 'director', 'growth', 'marketing', 'sales', 
                     'product', 'digital', 'brand', 'performance', 'business', 'revenue',
                     'operations', 'strategy', 'unit', 'vertical', 'category', 'regional'}
    
    i = 0
    while i < len(lines):
        line = lines[i]
        
        if ' - ' in line and len(line) > 10 and len(line) < 200:
            parts = line.split(' - ')
            company = parts[0].strip()
            title = ' - '.join(parts[1:]).strip()
            
            # Skip if company is generic or short
            if company.lower() in generic_terms or len(company) < 3:
                i += 1
                continue
            
            # Skip navigation-like patterns
            skip_patterns = ['search for', 'jobs for', 'marketing head', 'sales head']
            if any(company.lower().startswith(p) for p in skip_patterns):
                i += 1
                continue
            
            if len(title) > 3 and not company.replace('-', '').replace(' ', '').isdigit():
                job = {'company': company, 'title': title}
                
                # Look ahead for metadata
                for j in range(i+1, min(i+6, len(lines))):
                    l = lines[j]
                    
                    exp_match = re.search(r'(\d+)\s*-\s*(\d+)\s*yrs?', l)
                    if exp_match and 'job' not in l.lower():
                        job['experience'] = f"{exp_match.group(1)}-{exp_match.group(2)} yrs"
                    
                    locations = ['mumbai', 'bangalore', 'delhi', 'gurgaon', 'gurugram', 
                                 'noida', 'pune', 'hyderabad', 'chennai', 'remote']
                    ll = l.lower()
                    if any(loc in ll for loc in locations) and len(l) < 50:
                        if 'yrs' not in ll and 'posted' not in ll:
                            job['location'] = l
                    
                    if 'posted' in l.lower():
                        job['posted'] = l
                
                jobs.append(job)
        
        i += 1
    
    return jobs


def harvest_all(search_keys=None, min_exp=7):
    """Harvest jobs from configured sources."""
    all_jobs = []
    seen = set()
    
    sources = search_keys or list(SEARCH_URLS.keys())
    
    for key in sources:
        if key not in SEARCH_URLS:
            continue
        
        url = SEARCH_URLS[key]
        print(f"Harvesting: {key}")
        
        text = harvest_iimjobs_browser(url)
        if not text:
            continue
        
        jobs = parse_iimjobs_text(text)
        print(f"  Parsed: {len(jobs)} jobs")
        
        for job in jobs:
            exp = job.get('experience', '0')
            exp_match = re.search(r'(\d+)', exp)
            if exp_match and int(exp_match.group(1)) < min_exp:
                continue
            
            key_str = f"{job.get('company', '').lower()}|{job.get('title', '').lower()}"
            if key_str not in seen and job.get('company'):
                seen.add(key_str)
                job['source'] = 'iimjobs'
                job['search_term'] = key
                all_jobs.append(job)
    
    print(f"Total unique: {len(all_jobs)}")
    return all_jobs


def save_jobs(jobs, filepath='/tmp/discovered_jobs.json'):
    with open(filepath, 'w') as f:
        json.dump(jobs, f, indent=2)


def load_jobs(filepath='/tmp/discovered_jobs.json'):
    try:
        with open(filepath) as f:
            return json.load(f)
    except:
        return []


if __name__ == '__main__':
    jobs = harvest_all(['head_marketing', 'head_growth'])
    print(f"\nTotal: {len(jobs)} jobs")
    for j in jobs[:15]:
        print(f"  {j.get('company')}: {j.get('title')} ({j.get('location')})")