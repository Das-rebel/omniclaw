"""
STRICT preflight check - MUST run before any application.
Blocks: excluded companies, irrelevant verticals (interior/design/agencies), already-applied.
"""
import json, re

TRACKER = '/Users/Subho/Desktop/applied_companies_tracker.json'

# Word-boundary matched exclusions
EXCLUDE_COMPANIES = {
    # ONLY these two — all other big tech/finance allowed
    'swiggy', 'groww',
    # Indian IT Services
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
    'heeraji', 'pepperfry', 'urbanclap', 'fab Alley', 'myntra', 'shopclues',
    # Staffing/Recruitment portals
    'staffing', 'recruitment firm', 'headhunter', 'talent firm', 'randstad',
    'naukri', 'naukrigulf', 'shine', 'indeed',
}

# Substring-matched irrelevant patterns
IRRELEVANT_PATTERNS = [
    'interior design', 'interior', 'architecture', 'architec',
    'ad agency', 'media agency', 'advertainment', 'advert', 'pr agency', 'advertising agency',
    'creative agency', 'branding agency', 'design studio',
    'fashion', 'apparel', 'clothing', 'garment', 'textile', 'fashion retail',
    'consulting firm', 'consulting company', 'management consulting',
    'audit firm', 'accounting firm', 'law firm', 'legal firm',
    'staffing', 'recruitment', 'headhunter', 'talent firm',
    'real estate', 'property tech', 'brokerage',
    'furniture', 'home decor', 'decor', 'furnish',
    'logistics company', 'shipping', 'freight', 'supply chain',
    'manufacturing', 'factory', 'industrial',
]

# Interior/design brand name fragments (substring match blocks company if combined with design/agency)
DESIGN_BRAND_FRAGMENTS = [
    'livart', 'bonito', 'homecentre', 'home centre', 'pepperfry', 'urbanclap',
    'decorilla', 'designcafe', 'godbricks', 'livspace', 'homevista',
    'nestasia', 'fabrial', '止まり', 'bonito designs', 'livart designs',
]

# Words in company name that + "designs/studio/agency" = blocked
B2B_DESIGN_SUFFIXES = ['designs', 'design', 'studio', 'studios', 'agency', 'firm']

# Words that indicate interior/B2B context
B2B_CONTEXT_WORDS = {
    'interior', 'home', 'living', 'space', 'room', 'decor', 'furnish',
    'kitchen', 'bathroom', 'bedroom', 'office', 'commercial', 'residential',
    'architect', 'designer'
}

SENIOR_KW = {
    # Leadership / C-suite
    'head', 'director', 'vp', 'vice president', 'chief', 'svp', 'evp', 'avp',
    'founder', 'co-founder', 'owner', 'partner', 'managing director',
    'president', 'general', 'ad', 'associate director',
    # Lead (as standalone title — "Growth Lead", "Marketing Lead")
    'lead',
}
JUNIOR_KW = {'junior', 'intern', 'entry level', 'fresher', 'trainee', 'associate', 'executive'}

# --- LOCATION RULE (user 2026-08-27) ---
# India: metros only. Intl: allowed countries. Check if location string passed.
INDIA_ALLOWED = ['mumbai', 'navi mumbai', 'pune', 'pcmc', 'bangalore', 'bengaluru', 'mysore',
                 'mysuru', 'gurgaon', 'gurugram', 'noida', 'delhi', 'ncr', 'hyderabad', 'chennai',
                 'remote', 'work from home', 'anywhere', 'india']
INTL_ALLOWED = ['amsterdam', 'netherlands', 'thailand', 'bangkok', 'singapore', 'europe',
                'dubai', 'qatar', 'doha', 'uae', 'abu dhabi', 'united arab emirates',
                'australia', 'sydney', 'melbourne', 'new zealand', 'auckland',
                'hong kong', 'saudi', 'riyadh', 'united states', 'remote', 'philippines',
                'indonesia', 'vietnam', 'malaysia', 'taiwan', 'philippines', 'london', 'uk',
                'germany', 'berlin', 'united kingdom', 'qatar', 'bahrain', 'kuwait', 'oman']
TIER2_BLOCK = ['nashik', 'nagpur', 'indore', 'jaipur', 'lucknow', 'kochi', 'coimbatore',
               'bhubaneswar', 'guwahati', 'dehradun', 'surat', 'vadodara', 'raipur', 'ranchi',
               'patna', 'bhopal', 'vizag', 'visakhapatnam']

def location_ok(loc=''):
    """True if location allowed, None if unknown (pass through)."""
    if not loc:
        return None
    ll = loc.lower()
    for t in TIER2_BLOCK:
        if t in ll:
            return False
    if any(c in ll for c in INDIA_ALLOWED + INTL_ALLOWED):
        return True
    return None  # unknown location -> don't block

def check(company, role='', location=''):
    if not company or company.lower().strip() in ('unknown', 'none', '-', ''):
        return False, "EMPTY"
    cl = company.lower().strip()
    rl = (role or '').lower()

    # 0. Location check
    loc_result = location_ok(location)
    if loc_result is False:
        return False, f"TIER2_BLOCK:{location}"

    # 1. EXCLUDE_COMPANIES word-boundary
    for excl in EXCLUDE_COMPANIES:
        if re.search(r'\b' + re.escape(excl) + r'\b', cl):
            return False, f"EXCLUDE:{excl}"

    # 2. IRRELEVANT_PATTERNS substring
    for pat in IRRELEVANT_PATTERNS:
        if pat in cl:
            return False, f"IRRELEVANT:{pat}"

    # 3. DESIGN_BRAND_FRAGMENTS substring (blocks interior/design brands)
    for brand in DESIGN_BRAND_FRAGMENTS:
        if brand in cl:
            return False, f"INTERIOR_BRAND:{brand}"

    # 4. B2B design firm check - "designs/studio/agency" preceded by interior/home context
    words = cl.split()
    for i, w in enumerate(words):
        if w in B2B_DESIGN_SUFFIXES:
            if i > 0 and words[i-1] in B2B_CONTEXT_WORDS:
                return False, f"B2B_CONTEXT:{words[i-1]} {w}"

    # 5. Already applied
    with open(TRACKER) as f:
        tracker = json.load(f)
    applied = tracker.get('applied_companies', [])
    for a in applied:
        al = a.lower()
        if 'unknown' in al or len(al) < 4:
            continue
        key = al.split(' - ')[0].split(' (')[0].strip()
        if not key:
            continue
        if cl == key or cl.startswith(key + ' ') or key.startswith(cl + ' '):
            return False, f"APPLIED:{key}"

    # 6. Seniority check — MUST be senior leadership (Head/Director/VP/Chief/Lead/General/AD)
    # Plain "senior X manager" does NOT count as senior (senior IC, not leadership)
    has_junior = any(re.search(r'\b' + k + r'\b', rl) for k in JUNIOR_KW)
    has_explicit_senior = any(re.search(r'\b' + k + r'\b', rl) for k in SENIOR_KW)
    has_senior_word = 'senior' in rl
    has_manager = 'manager' in rl
    has_leadership = any(k in rl for k in [
        'director', 'head', 'vp', 'chief', 'founder',
        'owner', 'partner', 'president', 'managing',
        'lead',      # "Growth Lead", "Marketing Lead" — senior IC or team lead
        'general',   # "General Manager", "General Counsel"
        'associate director',  # AD / Associate Director
    ])

    # "associate director" is a SENIOR title — override "associate" in JUNIOR_KW
    has_assoc_director = 'associate director' in rl

    if has_junior and not has_explicit_senior and not has_assoc_director:
        return False, f"R8_JUNIOR"
    if has_explicit_senior:
        pass  # has head/director/vp/chief/founder/lead/general/ad — PASS
    elif has_senior_word and has_manager and not has_leadership:
        pass  # Leadership IC (Sr Brand Manager etc.) — ALLOWED per user
    elif has_senior_word and not has_manager:
        pass  # Senior IC (Sr Media Buyer, Sr Engineer etc.) — ALLOWED per user
    elif has_manager and not has_leadership:
        return False, f"NOT_SENIOR:MANAGER"  # "X Manager" = mid-level, not senior
    elif not has_leadership:
        return False, f"NOT_SENIOR:NO_LEADERSHIP"  # no head/director/VP/chief/lead/general/ad

    return True, None

if __name__ == '__main__':
    import sys
    co = sys.argv[1] if len(sys.argv) > 1 else ''
    ro = sys.argv[2] if len(sys.argv) > 2 else ''
    ok, reason = check(co, ro)
    print(f"{'PASS' if ok else 'FAIL'}: {co[:30]} | {ro[:35]} | {reason or 'OK'}")
