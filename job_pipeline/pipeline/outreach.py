"""
Outreach Module
===============
Generates human-written outreach emails and sends them.

Usage:
    from pipeline.outreach import generate_outreach, send_outreach
    
    emails = generate_outreach(contacts, companies_applied)
    send_outreach(emails)
"""

import json
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication

# R21-verified metrics
METRICS = {
    "groww":   "scaled Groww's credit book from $5M to $36M monthly disbursals (7x)",
    "niro":    "ran ₹8M/month loan disbursals at Niro through partnerships",
    "abc":     "tripled D2C loan volume to ₹50 Cr/month at Aditya Birla Capital",
    "orange":  "lifted app retention +30% in year one at Orange Health Labs",
    "a3m":     "shipped an AI router with 25,000+ npm downloads",
    "icici":   "managed salary & privilege banking for 4.5M+ customers at ICICI Bank",
}

RESUME_PATH = '/Users/Subho/Downloads/Sub_tara.pdf'
GMAIL_USER = 'sdas22@gmail.com'
GMAIL_APP_PASSWORD = 'xgltjfklmjgslthf'

# Human voice rules
HUMAN_NO = [
    "i hope this email finds you well",
    "i am writing to express",
    "with my extensive experience",
    "i would welcome the opportunity",
    "please find attached",
    "i am excited to apply",
    "i believe my skills",
    "best regards",
    "kind regards",
    "yours sincerely",
]


def assess_humanity(email_text):
    """Check if email sounds human-written. Returns score 1-10."""
    text = email_text.lower()
    issues = sum(1 for phrase in HUMAN_NO if phrase in text)
    score = max(1, 10 - (issues * 3))
    return score


def generate_outreach_email(contact, company_focus=None):
    """
    Generate a human-sounding outreach email for a contact.
    
    Args:
        contact: dict with name, company, role, email, url
        company_focus: optional company to mention (if different from contact's company)
    
    Returns:
        dict with to, subject, body keys
    """
    name = contact.get('name', '')
    first_name = name.split()[0]
    company = company_focus or contact.get('company', '')
    
    # Pick relevant metrics based on company
    if any(kw in company.lower() for kw in ['fintech', 'lending', 'credit', 'nbfc', 'bank']):
        metrics = [METRICS["groww"], METRICS["niro"]]
    elif any(kw in company.lower() for kw in ['d2c', 'consumer', 'retail', 'food', 'fmcg']):
        metrics = [METRICS["abc"], METRICS["orange"]]
    else:
        metrics = [METRICS["groww"], METRICS["orange"]]
    
    metric_text = f"\n• {metrics[0]}\n• {metrics[1]}"
    
    # Human-written style
    subjects = [
        f"Quick intro — growth playbooks",
        f"Growth leader — {company} fit?",
        f"Growth + retention — connecting",
    ]
    
    bodies = [
        f"""Hey {first_name},

Came across {company} and wanted to connect. Built growth systems at scale{metric_text}.

Would love to chat about what you're building and whether there's a fit.

Thanks!
Subhajit
+91 79771 10915""",

        f"""Hey {first_name},

Wanted to connect. Spent 11 years building growth engines across fintech and consumer{metric_text}.

{company}'s approach caught my eye. Would love to explore if there's a fit.

Thanks!
Subhajit
+91 79771 10915""",
    ]
    
    import random
    body = random.choice(bodies)
    subject = random.choice(subjects)
    
    # Verify humanity score
    score = assess_humanity(body)
    if score < 7:
        # Fallback to simplest version
        body = f"""Hey {first_name},

Quick intro — built growth systems at scale across fintech and consumer companies. 
{metric_text}

Would love to chat about {company}.

Thanks!
Subhajit"""
    
    return {
        'to': contact.get('email', ''),
        'subject': subject,
        'body': body,
        'humanity_score': assess_humanity(body)
    }


def generate_outreach(contacts, companies_applied=None):
    """
    Generate outreach emails for contacts.
    
    Args:
        contacts: list of contact dicts
        companies_applied: set of companies already applied to
    
    Returns:
        list of email dicts ready to send
    """
    emails = []
    
    for contact in contacts:
        # Skip if no email
        if not contact.get('email'):
            continue
        
        # Generate email
        email = generate_outreach_email(contact)
        email['contact_name'] = contact.get('name')
        email['contact_company'] = contact.get('company')
        
        emails.append(email)
    
    return emails


def send_email(email, resume_path=RESUME_PATH):
    """Send a single email with resume attached."""
    msg = MIMEMultipart()
    msg['From'] = GMAIL_USER
    msg['To'] = email.get('to', '')
    msg['Subject'] = email.get('subject', '')
    msg.attach(MIMEText(email.get('body', ''), 'plain'))
    
    try:
        with open(resume_path, 'rb') as f:
            resume_data = f.read()
        resume_part = MIMEApplication(resume_data, _subtype='pdf')
        resume_part.add_header('Content-Disposition', 'attachment', 
                              filename='Subhajit_Das_Resume.pdf')
        msg.attach(resume_part)
    except Exception as e:
        print(f"Warning: Could not attach resume: {e}")
    
    try:
        with smtplib.SMTP('smtp.gmail.com', 587, timeout=30) as server:
            server.starttls()
            server.login(GMAIL_USER, GMAIL_APP_PASSWORD)
            server.sendmail(GMAIL_USER, email['to'], msg.as_string())
        return True
    except Exception as e:
        print(f"Failed to send to {email['to']}: {e}")
        return False


def send_outreach(emails, resume_path=RESUME_PATH):
    """
    Send multiple outreach emails.
    
    Args:
        emails: list of email dicts from generate_outreach
    
    Returns:
        dict with sent/failed counts
    """
    results = {'sent': 0, 'failed': 0}
    
    for email in emails:
        print(f"Sending to {email.get('contact_name')} ({email.get('to')})...")
        if send_email(email, resume_path):
            results['sent'] += 1
            print(f"  ✅ Sent: {email.get('subject')}")
        else:
            results['failed'] += 1
            print(f"  ❌ Failed")
    
    return results


def load_happenstance_contacts(filepath='/Users/Subho/happenstance-agent-find/connections_data.json'):
    """Load contacts from Happenstance database."""
    try:
        with open(filepath) as f:
            data = json.load(f)
        return data.get('connections', [])
    except:
        return []


def find_contacts_for_companies(companies, contacts):
    """Find contacts at specific companies."""
    found = []
    companies_lower = [c.lower() for c in companies]
    
    for contact in contacts:
        company = contact.get('company', '').lower()
        if any(c in company for c in companies_lower):
            # Check if senior role
            role = contact.get('role', '').lower()
            senior_kw = ['director', 'head', 'vp', 'chief', 'founder', 'co-founder', 'avp', 'president', 'hr', 'recruiter']
            if any(kw in role for kw in senior_kw):
                found.append(contact)
    
    return found


if __name__ == '__main__':
    # Test
    contacts = [
        {'name': 'Test Person', 'company': 'SomeFintech', 'role': 'Head of Growth', 'email': 'test@example.com'}
    ]
    emails = generate_outreach(contacts)
    print(f"Generated {len(emails)} emails")
    for e in emails:
        print(f"  To: {e['to']}")
        print(f"  Score: {e.get('humanity_score', '?')}/10")