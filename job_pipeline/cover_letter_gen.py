"""
Cover letter generator — follows ALL locked rules:
- R21 TRUE-STORY: every metric traces to the user-confirmed Sep 8 timeline. NO Paytm. NO fabrication.
- Barbara Minto Pyramid: answer first, then supporting points, then close.
- subho.email_voice: em-dashes, authentic phrases, NEVER "Dear Hiring Team".
- Signature: Growth Leader | IIM Trichy | Fintech & D2C
"""

SUBHO = "Subhajit Das"
PHONE = "+91 79771 10915"
EMAIL = "sdas22@gmail.com"
SIGNATURE_TAG = "Growth Leader | IIM Trichy | Fintech & D2C"

# R21-verified metrics — the ONLY ones allowed (timeline: user-confirmed Sep 8, Sep 11)
METRICS = {
    "groww":   "scaled Groww's credit book from $5M to $36M monthly disbursals (7x)",
    "niro":    "ran $8M/month loan disbursals at Niro through partnerships with Mygate, Snapdeal and NoBroker",
    "axis":    "grew a ₹1,500 Cr digital banking portfolio at Axis Bank — including saving ₹180 Cr during demonetization",
    "abc":     "tripled D2C loan volume to ₹50 Cr/month at Aditya Birla Capital (Promising Star award)",
    "orange":  "lifted app retention +30% in year one at Orange Health Labs (incl. a Foodpharmer collaboration)",
    "a3m":     "shipped an AI router with 25,000+ npm downloads as an independent builder",
    "icici":   "managed salary & privilege banking products for 4.5M+ customers at ICICI Bank",
}

# Domain → which 2 proofs to lead with. A3M is ALWAYS third (it's the current role 03/2025–Present,
# so the 'most recently' framing is chronologically true for every domain).
DOMAIN_PROOFS = {
    "fintech": ["groww", "niro"],
    "lending": ["niro", "groww"],
    "d2c":     ["abc", "niro"],
    "health":  ["orange", "niro"],
    "saas":    ["groww", "niro"],
    "ai":      ["groww", "niro"],
    "consumer": ["orange", "abc"],
    "default": ["groww", "niro"],
}

BANNED = ["paytm", "ex-paytm", "10m+ users", "$8m monthly disbursals at", "dear hiring team",
          "dear sir/madam", "to whom it may concern", "i am writing to apply"]

AUTHENTIC_CLOSE = "I can hit the ground running from Week 1 — I'd welcome the chance to discuss."


def _greeting(company: str, hiring_manager: str = "") -> str:
    # subho.email_voice: NEVER "Dear Hiring Team"
    if hiring_manager:
        return f"Dear {hiring_manager},"
    return f"Hi {company} team,"


def generate_cover_letter(company: str, role: str, domain: str = "default",
                          hiring_manager: str = "", max_words: int = 200) -> str:
    """Minto-pyramid letter, true-story metrics only, authentic voice."""
    proofs = DOMAIN_PROOFS.get(domain.lower(), DOMAIN_PROOFS["default"])
    p1, p2 = (METRICS[k] for k in proofs)
    a3m = METRICS["a3m"]

    letter = (
        f"{_greeting(company, hiring_manager)}\n\n"
        f"I'm applying for {role} at {company} — this is the exact intersection I've spent "
        f"11 years working: growth leadership across fintech, D2C and consumer, with P&L "
        f"ownership from day one.\n\n"
        f"Three things that map directly to what you're building:\n"
        f"— I {p1}.\n"
        f"— I {p2}.\n"
        f"— Most recently, I {a3m} — so I bring the AI-era toolkit, not just playbooks.\n\n"
        f"I'm an IIM Trichy PGPM (Marketing) and IISER Pune MSc, currently an independent "
        f"growth strategist, available immediately. {AUTHENTIC_CLOSE}\n\n"
        f"Regards,\n"
        f"{SUBHO} — {SIGNATURE_TAG}\n"
        f"{PHONE} | {EMAIL}"
    )
    return letter


def validate_letter(letter: str) -> bool:
    """R21 gate: no banned phrases, signature present."""
    low = letter.lower()
    return not any(b in low for b in BANNED) and SIGNATURE_TAG in letter


if __name__ == "__main__":
    import sys
    company = sys.argv[1] if len(sys.argv) > 1 else "Prolific"
    role = sys.argv[2] if len(sys.argv) > 2 else "Head of Growth"
    domain = sys.argv[3] if len(sys.argv) > 3 else "default"
    letter = generate_cover_letter(company, role, domain)
    assert validate_letter(letter), "R21 VALIDATION FAILED"
    print(letter)
    print(f"\n[{len(letter.split())} words, R21-validated ✓]")
