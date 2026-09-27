"""
Pipeline Runner
===============
Main entry point for the job application pipeline.

Usage:
    python pipeline/run.py --discover --filter --apply --outreach
"""

import argparse
import json
import sys

# Add pipeline to path
sys.path.insert(0, '/Users/Subho/job_pipeline')

from pipeline.discover import harvest_all, save_jobs, load_jobs
from pipeline.preflight import filter_jobs, check
from pipeline.apply import apply_batch, update_tracker
from pipeline.outreach import generate_outreach, send_outreach, load_happenstance_contacts, find_contacts_for_companies


def run_discover(search_terms=None, min_exp=7):
    """Discover jobs from all sources."""
    print("\n" + "="*60)
    print("STEP 1: JOB DISCOVERY")
    print("="*60)
    
    jobs = harvest_all(search_terms, min_exp)
    save_jobs(jobs)
    
    return jobs


def run_filter(jobs=None):
    """Filter jobs through preflight."""
    print("\n" + "="*60)
    print("STEP 2: PREFLIGHT FILTERING")
    print("="*60)
    
    if jobs is None:
        jobs = load_jobs()
    
    passed, failed = filter_jobs(jobs)
    
    print(f"\nPassed preflight: {len(passed)}")
    print(f"Failed preflight: {len(failed)}")
    
    # Show failures
    if failed:
        print("\nFailure reasons:")
        reasons = {}
        for j in failed:
            r = j.get('preflight_reason', 'unknown')
            reasons[r] = reasons.get(r, 0) + 1
        
        for r, count in sorted(reasons.items(), key=lambda x: -x[1]):
            print(f"  {r}: {count}")
    
    # Save filtered jobs
    with open('/tmp/filtered_jobs.json', 'w') as f:
        json.dump(passed, f, indent=2)
    
    print(f"\nSaved {len(passed)} filtered jobs to /tmp/filtered_jobs.json")
    
    return passed, failed


def run_apply(jobs=None, limit=10):
    """Apply to filtered jobs."""
    print("\n" + "="*60)
    print("STEP 3: APPLY TO JOBS")
    print("="*60)
    
    if jobs is None:
        try:
            with open('/tmp/filtered_jobs.json') as f:
                jobs = json.load(f)
        except:
            print("No filtered jobs found. Run discovery + filter first.")
            return []
    
    # Limit
    jobs = jobs[:limit]
    
    print(f"Applying to {len(jobs)} jobs...")
    
    # Convert to apply format
    apply_jobs = [{'url': j.get('url', ''), 'title': j.get('title', ''), 'company': j.get('company', '')} 
                  for j in jobs if j.get('url')]
    
    if not apply_jobs:
        print("No jobs with URLs to apply to.")
        return []
    
    results = apply_batch(apply_jobs)
    
    # Update tracker for successes
    for job in jobs:
        if job.get('url') in [j['url'] for j in apply_jobs]:
            # This is a simplification - actual tracking needs better logic
            pass
    
    print(f"\nResults: {results}")
    
    return results


def run_outreach(contacts=None):
    """Generate and send outreach emails."""
    print("\n" + "="*60)
    print("STEP 4: OUTREACH EMAILS")
    print("="*60)
    
    if contacts is None:
        contacts = load_happenstance_contacts()
    
    # Get companies we applied to
    TRACKER = '/Users/Subho/Desktop/applied_companies_tracker.json'
    with open(TRACKER) as f:
        tracker = json.load(f)
    
    applied_companies = [a.get('company', '') for a in tracker.get('applications', [])]
    
    # Find contacts at those companies
    relevant_contacts = find_contacts_for_companies(applied_companies, contacts)
    
    print(f"Found {len(relevant_contacts)} relevant contacts at applied companies")
    
    # Generate emails
    emails = generate_outreach(relevant_contacts)
    
    print(f"Generated {len(emails)} outreach emails")
    
    # Show first few
    for email in emails[:3]:
        print(f"\n  To: {email.get('contact_name')} ({email.get('to')})")
        print(f"  Subject: {email.get('subject')}")
        print(f"  Humanity score: {email.get('humanity_score', '?')}/10")
    
    # Send
    if emails:
        print(f"\nSending {len(emails)} emails...")
        results = send_outreach(emails)
        print(f"\nResults: {results}")
        
        # Update tracker
        sent = results.get('sent', 0)
        print(f"✅ Sent {sent} outreach emails")
    
    return emails


def run_full():
    """Run full pipeline."""
    # 1. Discover
    jobs = run_discover(['head_marketing', 'head_growth', 'cmo'])
    
    # 2. Filter
    passed, failed = run_filter(jobs)
    
    # 3. Apply (top 5)
    if passed:
        run_apply(passed[:5])
    
    # 4. Outreach
    run_outreach()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Job Application Pipeline')
    parser.add_argument('--discover', action='store_true', help='Discover jobs')
    parser.add_argument('--filter', action='store_true', help='Filter jobs through preflight')
    parser.add_argument('--apply', action='store_true', help='Apply to jobs')
    parser.add_argument('--outreach', action='store_true', help='Send outreach emails')
    parser.add_argument('--all', action='store_true', help='Run full pipeline')
    parser.add_argument('--limit', type=int, default=10, help='Max jobs to apply to')
    
    args = parser.parse_args()
    
    if args.all or (not any([args.discover, args.filter, args.apply, args.outreach])):
        run_full()
    else:
        if args.discover:
            jobs = run_discover()
        if args.filter:
            run_filter()
        if args.apply:
            run_apply(limit=args.limit)
        if args.outreach:
            run_outreach()