"""
Preflight Check Module
====================
Centralized preflight checks for all job applications.

GOAL ALIGNMENT:
- Only Director+, VP, Head, Chief/C-suite, EIR, Founder's Office
- NOT B2B, SaaS, software, cloud
- NOT interior/design/consulting/fashion/real estate/agencies
- MIN 35 LPA
- Block Tier 2/3 cities
- Block already-applied companies
- Block explicit exclusions (Swiggy, Groww, Orange Health, etc.)
- Block Fraganote

Usage:
    from pipeline.preflight import check, MIN_SALARY_LPA
    
    result, reason = check(company, role, location, salary_lpa)
    if result:
        print("Apply!")
"""

import json
import re

TRACKER = '/Users/Subho/Desktop/applied_companies_tracker.json'

# USER CRITERIA
MIN_SALARY_LPA = 35

# === EXPLICIT EXCLUSIONS (user-specified) ===
# Companies user said NEVER apply to
EXCLUDE_COMPANIES = {
    # Big tech exclusions
    'swiggy', 'groww',
    # Ex-employer / no-reapply
    'orange health labs', 'oolka',
    # User-specified exclusions
    'upstock', 'blinkit', 'flickd', 'kiddo', 'hummingbird', 'huntlo',
    'goodspace', 'battery',
    # Indian IT Services (not target companies)
    'infosys', 'wipro', 'accenture', 'cognizant',
    'hcl tech', 'tech mahindra', 'capgemini', 'mindtree', 'ltimindtree',
    'persistent', 'ltts',
    # EdTech / Schools
    'school', 'university', 'college', 'institute', 'academy',
    'byju', 'vedantu', 'unacademy', 'udemy', 'coursera', 'upgrad',
    'simplilearn', 'testbook', 'gradeup',
    'iim', 'iit', 'bits', 'nit', 'iiit', 'iiser', 'b-school',
    # Consulting/Agencies
    'wpp', 'publicis', 'omnicom', 'dentsu', 'ipg', 'havas',
    'mckinsey', 'bcg', 'bain', 'deloitte', 'pwc', 'kpmg', 'ey',
    'asymmetrique', 'lucid', 'quantik', 'spark6', 'morcap',
    # Fashion/Retail
    'heeraji', 'pepperfry', 'urbanclap', 'fab alley', 'myntra', 'shopclues',
    # Staffing/Recruitment portals
    'staffing', 'recruitment firm', 'headhunter', 'talent firm', 'randstad',
    'naukri', 'naukrigulf', 'shine', 'indeed',
    # Fraganote - user explicitly said skip
    'fraganote',
}

# === IRRELEVANT PATTERNS (company OR role) ===
# USER MANDATE: NO B2B, NO SAAS, NO INTERIOR, NO AGENCIES
IRRELEVANT_PATTERNS = [
    # BLOCKED VERTICALS (user mandate)
    'b2b', 'saas', 'software', 'cloud', 'crm', 'erp', 'cybersecurity', 'devops',
    # Interior/Design
    'interior design', 'interior', 'architecture', 'architec',
    # Agencies
    'ad agency', 'media agency', 'advertainment', 'advert', 'pr agency', 'advertising agency',
    'creative agency', 'branding agency', 'design studio',
    # Fashion/Retail
    'fashion', 'apparel', 'clothing', 'garment', 'textile', 'fashion retail',
    # Consulting
    'consulting firm', 'consulting company', 'management consulting',
    'audit firm', 'accounting firm', 'law firm', 'legal firm',
    # Real Estate
    'real estate', 'property tech', 'brokerage',
    # Other blocked
    'furniture', 'home decor', 'decor', 'furnish',
    'logistics company', 'shipping', 'freight', 'supply chain',
    'manufacturing', 'factory', 'industrial',
]

# Interior/design brand name fragments
DESIGN_BRAND_FRAGMENTS = [
    'livart', 'bonito', 'homecentre', 'home centre', 'pepperfry', 'urbanclap',
    'decorilla', 'designcafe', 'godbricks', 'livspace', 'homevista',
    'nestasia', 'fabrial', 'bonito designs', 'livart designs',
]

B2B_DESIGN_SUFFIXES = ['designs', 'design', 'studio', 'studios', 'agency', 'firm']

B2B_CONTEXT_WORDS = {
    'interior', 'home', 'living', 'space', 'room', 'decor', 'furnish',
    'kitchen', 'bathroom', 'bedroom', 'office', 'commercial', 'residential',
    'architect', 'designer'
}

# === SENIORITY CHECK ===
# Only these keywords indicate Director+ level
# NOTE: 'lead' is intentionally NOT here - standalone Lead ≠ Director
SENIOR_KW = {
    'director', 'vp', 'vice president', 'chief', 'svp', 'evp', 'avp',
    'founder', 'co-founder', 'owner', 'partner', 'managing director',
    'president', 'general manager',
}

# Junior keywords - roles with these are rejected unless they also have explicit senior
JUNIOR_KW = {'junior', 'intern', 'entry level', 'fresher', 'trainee', 'associate', 'executive'}

# Words that indicate leadership even without explicit senior title
LEADERSHIP_INDICATORS = {
    'head', 'director', 'vp', 'chief', 'founder', 'owner', 'partner',
    'president', 'managing', 'general',
}

# Location rules
INDIA_ALLOWED = ['mumbai', 'navi mumbai', 'pune', 'pcmc', 'bangalore', 'bengaluru', 'mysore',
                 'mysuru', 'gurgaon', 'gurugram', 'noida', 'delhi', 'ncr', 'hyderabad', 'chennai',
                 'remote', 'work from home', 'anywhere', 'india']
INTL_ALLOWED = ['amsterdam', 'netherlands', 'thailand', 'bangkok', 'singapore', 'europe',
                'dubai', 'qatar', 'doha', 'uae', 'abu dhabi', 'united arab emirates',
                'australia', 'sydney', 'melbourne', 'new zealand', 'auckland',
                'hong kong', 'saudi', 'riyadh', 'united states', 'remote', 'philippines',
                'indonesia', 'vietnam', 'malaysia', 'taiwan', 'london', 'uk', 'germany', 'berlin']

TIER2_BLOCK = ['nashik', 'nagpur', 'indore', 'jaipur', 'lucknow', 'kochi', 'coimbatore',
               'bhubaneswar', 'guwahati', 'dehradun', 'surat', 'vadodara', 'raipur', 'ranchi',
               'patna', 'bhopal', 'vizag', 'visakhapatnam', 'mohali', 'ludhiana', 'jalandhar',
               'amritsar', 'panipat', 'karnal', 'gwalior', 'jodhpur', 'udaipur']


def location_ok(loc=''):
    """Check if location is allowed. Returns True/False/None (unknown)."""
    if not loc:
        return None
    ll = loc.lower()
    for t in TIER2_BLOCK:
        if t in ll:
            return False
    if any(c in ll for c in INDIA_ALLOWED + INTL_ALLOWED):
        return True
    return None


def check(company, role='', location='', salary_lpa=None):
    """
    Run all preflight checks.
    
    Returns: (passes: bool, reason: str or None)
    
    Usage:
        result, reason = check("Licious", "Sr Director", "Bangalore")
        if result:
            # Apply
    """
    if not company or company.lower().strip() in ('unknown', 'none', '-', ''):
        return False, "EMPTY"
    
    cl = company.lower().strip()
    rl = (role or '').lower()
    
    # 0. Salary check
    if salary_lpa is not None and salary_lpa < MIN_SALARY_LPA:
        return False, f"SALARY_LOW:{salary_lpa}LPA"
    
    # 1. Location check
    loc_result = location_ok(location)
    if loc_result is False:
        return False, f"TIER2_BLOCK:{location}"
    
    # 2. EXCLUDE_COMPANIES (word-boundary matched)
    for excl in EXCLUDE_COMPANIES:
        if re.search(r'\b' + re.escape(excl) + r'\b', cl):
            return False, f"EXCLUDE:{excl}"
    
    # 3. IRRELEVANT_PATTERNS (check both company AND role)
    for pat in IRRELEVANT_PATTERNS:
        if pat in cl or pat in rl:
            return False, f"IRRELEVANT:{pat}"
    
    # 4. DESIGN_BRAND_FRAGMENTS (check for interior/design brand fragments)
    for brand in DESIGN_BRAND_FRAGMENTS:
        if brand in cl:
            return False, f"INTERIOR_BRAND:{brand}"
    
    # 4b. Check for camelCase/PascalCase design compound (e.g., DesignStudio, InteriorsCo)
    design_words = ['design', 'interior', 'space', 'living', 'home', 'decor', 'furnish']
    design_suffixes = ['studio', 'studios', 'designs', 'design', 'agency', 'firm']
    cl_no_space = cl.replace(' ', '')
    for dw in design_words:
        for ds in design_suffixes:
            if cl_no_space.endswith(dw + ds) or dw + ds in cl_no_space:
                return False, f"B2B_DESIGN:{dw}{ds}"
    
    # 5. B2B design firm check (split by common separators)
    # Split on space, hyphen, underscore
    words = re.split(r'[\s\-_]+', cl)
    for i, w in enumerate(words):
        if w in B2B_DESIGN_SUFFIXES:
            if i > 0 and words[i-1] in B2B_CONTEXT_WORDS:
                return False, f"B2B_CONTEXT:{words[i-1]} {w}"
    
    # 6. Already applied
    with open(TRACKER) as f:
        tracker = json.load(f)
    applied_apps = tracker.get('applications', [])
    for a in applied_apps:
        ac = a.get('company', '').lower().strip()
        if not ac or 'unknown' in ac or len(ac) < 3:
            continue
        if cl == ac or cl.startswith(ac + ' ') or ac.startswith(cl + ' '):
            return False, f"APPLIED:{ac}"
    
    # 7. SENIORITY CHECK
    # Check for explicit senior titles first (Director, VP, Chief, etc.)
    has_explicit_senior = any(
        re.search(r'\b' + re.escape(k) + r'\b', rl) 
        for k in SENIOR_KW
    )
    
    # Check for leadership indicators (Head, etc.)
    has_leadership = any(k in rl for k in LEADERSHIP_INDICATORS)
    
    # Check for junior keywords
    has_junior = any(re.search(r'\b' + k + r'\b', rl) for k in JUNIOR_KW)
    
    # Junior roles rejected unless they have explicit senior
    if has_junior and not has_explicit_senior:
        return False, f"R8_JUNIOR"
    
    # Must have either explicit senior OR leadership indicator
    if not has_explicit_senior and not has_leadership:
        return False, f"NOT_SENIOR:NO_LEADERSHIP"
    
    # Explicit senior titles always pass (even with manager)
    if has_explicit_senior:
        return True, None
    
    # Has leadership indicator → passes
    return True, None


def filter_jobs(jobs):
    """
    Filter a list of jobs through preflight.
    
    Args:
        jobs: list of dicts with company, role, location, salary_lpa keys
    
    Returns:
        (passes, fails) tuple of job lists
    """
    passed = []
    failed = []
    
    for job in jobs:
        result, reason = check(
            job.get('company', ''),
            job.get('role', job.get('title', '')),  # role OR title
            job.get('location', ''),
            job.get('salary_lpa')
        )
        job['preflight_reason'] = reason
        if result:
            passed.append(job)
        else:
            failed.append(job)
    
    return passed, failed


if __name__ == '__main__':
    # Test
    test_jobs = [
        {"company": "Licious", "role": "Sr Director Loyalty", "location": "Bangalore"},
        {"company": "B2B SaaS Corp", "role": "CMO", "location": "Mumbai"},
        {"company": "Some Co", "role": "Marketing Manager", "location": "Mumbai", "salary_lpa": 30},
        {"company": "Flipspaces", "role": "India Head - Digital Marketing", "location": "Delhi NCR"},
        {"company": "SomeCo", "role": "Marketing Lead", "location": "Bangalore"},
        {"company": "Fraganote", "role": "Business & Growth Head", "location": "Mumbai"},
        {"company": "Upstock", "role": "Head of Marketing", "location": "Bangalore"},
        {"company": "Blinkit", "role": "Growth Lead", "location": "Delhi"},
    ]
    
    passed, failed = filter_jobs(test_jobs)
    print(f"Passed: {len(passed)}")
    print(f"Failed: {len(failed)}")
    for j in failed:
        print(f"  ❌ {j['company']} - {j['role']} -> {j['preflight_reason']}")
    for j in passed:
        print(f"  ✅ {j['company']} - {j['role']}")