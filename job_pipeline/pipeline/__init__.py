"""
Job Application Pipeline
=====================
Centralized pipeline for job discovery, filtering, application, and outreach.

Workflow:
1. discover() - Harvest jobs from iimjobs/LinkedIn
2. filter_preflight() - Run all jobs through preflight check
3. apply() - Apply to filtered jobs via iimjobs browser automation
4. outreach() - Generate and send outreach emails to contacts

Usage:
    from pipeline import discover, filter_preflight, apply, outreach
"""
