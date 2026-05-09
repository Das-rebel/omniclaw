"""
Form Engine v2 — Resume parsing, CSS-selector field matching, React Select handling, and form filling.

Architecture based on research of Simplify Copilot, Auto-Apply-Helper, and Greenhouse autofill extensions.

Key design decisions:
  - CSS selector arrays (not aliases) tried in priority order
  - Label-based fallback for fields not caught by selectors
  - Full React Select support with pointer event dispatching
  - No LLM required — pure rule-based matching and filling
  - Direct DOM manipulation via Playwright page.evaluate()

Public classes:
  - ResumeParser:   Plain-text resume → structured dict (unchanged from v1)
  - FormScanner:    Playwright Page → structured form description
  - FormFiller:     Structured description + profile → filled form

All public methods are async and type-hinted.
"""

from __future__ import annotations

import re
import logging
from dataclasses import dataclass, field as dc_field
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# CSS Selector Mappings
# ---------------------------------------------------------------------------
# For each semantic field type, an ordered list of CSS selectors to try.
# This is the primary matching strategy — fast, reliable, no heuristics.

FIELD_SELECTORS: Dict[str, List[str]] = {
    # Name
    "first_name": [
        'input[id="first_name"]',
        'input[name*="first_name"]',
        'input[id*="first_name"]',
        'input[autocomplete="given-name"]',
        'input[placeholder*="First" i]',
        'input[aria-label*="First Name" i]',
    ],
    "last_name": [
        'input[id="last_name"]',
        'input[name*="last_name"]',
        'input[id*="last_name"]',
        'input[autocomplete="family-name"]',
        'input[placeholder*="Last" i]',
        'input[aria-label*="Last Name" i]',
    ],
    "full_name": [
        'input[name*="full_name"]',
        'input[id*="full_name"]',
        'input[name="name"]',
        'input[id="name"]',
        'input[autocomplete="name"]',
        'input[placeholder*="Full Name" i]',
    ],
    "middle_name": [
        'input[name*="middle_name"]',
        'input[id*="middle_name"]',
        'input[autocomplete="additional-name"]',
    ],
    "preferred_name": [
        'input[name*="preferred"]',
        'input[id*="preferred"]',
        'input[placeholder*="Preferred" i]',
        'input[name*="nickname"]',
    ],

    # Email
    "email": [
        'input[id="email"]',
        'input[name*="email"]',
        'input[type="email"]',
        'input[autocomplete="email"]',
        'input[placeholder*="Email" i]',
    ],
    "email_confirm": [
        'input[name*="confirm_email"]',
        'input[id*="confirm_email"]',
        'input[name*="verify_email"]',
        'input[placeholder*="Confirm Email" i]',
    ],

    # Phone
    "phone": [
        'input[id="phone"]',
        'input[name*="phone"]',
        'input[type="tel"]',
        'input[autocomplete="tel"]',
        'input[placeholder*="Phone" i]',
    ],

    # Address
    "address": [
        'input[name*="address"]',
        'input[id*="address"]',
        'input[autocomplete="street-address"]',
        'input[placeholder*="Address" i]',
    ],
    "address_line1": [
        'input[name*="address_line_1"]',
        'input[id*="address_line_1"]',
        'input[autocomplete="address-line1"]',
    ],
    "address_line2": [
        'input[name*="address_line_2"]',
        'input[id*="address_line_2"]',
        'input[autocomplete="address-line2"]',
    ],
    "city": [
        'input[name*="city"]',
        'input[id*="city"]',
        'input[autocomplete="address-level2"]',
        'input[placeholder*="City" i]',
    ],
    "state": [
        'input[name*="state"]',
        'select[name*="state"]',
        'input[id*="state"]',
        'input[autocomplete="address-level1"]',
        'input[placeholder*="State" i]',
    ],
    "zip": [
        'input[name*="zip"]',
        'input[name*="postal"]',
        'input[id*="zip"]',
        'input[autocomplete="postal-code"]',
        'input[placeholder*="ZIP" i]',
        'input[placeholder*="Postal" i]',
    ],
    "country": [
        'input[name*="country"]',
        'select[name*="country"]',
        'input[id*="country"]',
        'input[autocomplete="country"]',
        'input[placeholder*="Country" i]',
    ],

    # Professional
    "linkedin": [
        'input[name*="linkedin" i]',
        'input[id*="linkedin" i]',
        'input[placeholder*="LinkedIn" i]',
        'input[aria-label*="LinkedIn" i]',
        'input[name*="linked_in" i]',
    ],
    "github": [
        'input[name*="github" i]',
        'input[id*="github" i]',
        'input[placeholder*="GitHub" i]',
    ],
    "website": [
        'input[name*="website"]',
        'input[name*="portfolio"]',
        'input[id*="website"]',
        'input[type="url"]',
        'input[placeholder*="Website" i]',
        'input[placeholder*="Portfolio" i]',
    ],
    "current_company": [
        'input[name*="current_company" i]',
        'input[id*="current_company" i]',
        'input[aria-label*="current company" i]',
        'input[placeholder*="Current Company" i]',
    ],
    "current_title": [
        'input[name*="current_title" i]',
        'input[id*="current_title" i]',
        'input[aria-label*="current title" i]',
        'input[placeholder*="Current Title" i]',
    ],

    # Work Experience
    "company_name": [
        'input[id*="company-name"]',
        'input[name*="company_name"]',
        'input[id*="company_name"]',
        'input[placeholder*="Company" i]',
        'input[aria-label*="Company name" i]',
    ],
    "job_title": [
        'input[id*="title-"]',
        'input[name*="title"]',
        'input[id*="title"]',
        'input[placeholder*="Title" i]',
        'input[aria-label*="Title" i]',
    ],
    "start_date_month": [
        'input[id*="start-date-month"]',
        'select[id*="start-date-month"]',
        'input[name*="start_date_month"]',
    ],
    "start_date_year": [
        'input[id*="start-date-year"]',
        'input[name*="start_date_year"]',
        'input[placeholder*="Start" i][placeholder*="year" i]',
    ],
    "end_date_month": [
        'input[id*="end-date-month"]',
        'select[id*="end-date-month"]',
        'input[name*="end_date_month"]',
    ],
    "end_date_year": [
        'input[id*="end-date-year"]',
        'input[name*="end_date_year"]',
        'input[placeholder*="End" i][placeholder*="year" i]',
    ],
    "current_role": [
        'input[name*="current-role"]',
        'input[id*="current-role"]',
        'input[type="checkbox"][name*="current"]',
    ],

    # Education
    "school": [
        'input[name*="school"]',
        'input[id*="school"]',
        'input[placeholder*="School" i]',
        'input[aria-label*="School" i]',
    ],
    "degree": [
        'select[name*="degree"]',
        'input[name*="degree"]',
        'input[placeholder*="Degree" i]',
    ],
    "discipline": [
        'input[name*="discipline"]',
        'input[name*="major"]',
        'input[name*="field_of_study"]',
        'input[placeholder*="Discipline" i]',
        'input[placeholder*="Major" i]',
    ],
    "gpa": [
        'input[name*="gpa"]',
        'input[id*="gpa"]',
        'input[placeholder*="GPA" i]',
    ],

    # Salary / Compensation
    "salary": [
        'input[name*="salary"]',
        'input[id*="salary"]',
        'input[placeholder*="Salary" i]',
        'input[aria-label*="salary" i]',
    ],
    "salary_expectations": [
        'input[name*="salary_expect"]',
        'input[id*="salary_expect"]',
        'input[placeholder*="Expected" i]',
        'input[placeholder*="CTC" i]',
    ],
    "notice_period": [
        'input[name*="notice"]',
        'input[id*="notice"]',
        'input[placeholder*="Notice" i]',
    ],

    # Other
    "cover_letter": [
        'textarea[name*="cover_letter"]',
        'textarea[id*="cover_letter"]',
        'textarea[placeholder*="Cover Letter" i]',
    ],
    "additional_info": [
        'textarea[name*="additional"]',
        'textarea[id*="additional"]',
        'textarea[placeholder*="Additional" i]',
    ],
    "referral_source": [
        'input[name*="referral"]',
        'input[id*="referral"]',
        'select[name*="referral"]',
        'input[placeholder*="referral" i]',
        'input[placeholder*="How did you hear" i]',
    ],
    "referred_by": [
        'input[name*="referred_by"]',
        'input[id*="referred_by"]',
        'input[placeholder*="Referred by" i]',
    ],
    "start_date_availability": [
        'input[name*="start_date"]',
        'input[id*="start_date"]',
        'input[type="date"]',
        'input[placeholder*="Start date" i]',
        'input[placeholder*="When can you start" i]',
    ],
    "years_of_experience": [
        'input[name*="years_of_experience"]',
        'input[id*="years_of_experience"]',
        'input[placeholder*="Years of Experience" i]',
        'input[aria-label*="Years of Experience" i]',
    ],
    "gender": [
        'select[name*="gender"]',
        'input[name*="gender"]',
        'input[id*="gender"]',
    ],
    "veteran": [
        'select[name*="veteran"]',
        'input[name*="veteran"]',
    ],
    "disability": [
        'select[name*="disability"]',
        'input[name*="disability"]',
    ],
    "work_authorization": [
        'select[name*="authorized"]',
        'select[name*="legally"]',
        'select[name*="eligible"]',
        'select[name*="work_auth"]',
    ],
    "sponsorship_required": [
        'select[name*="sponsor" i]',
        'select[name*="visa" i]',
        'select[id*="sponsor" i]',
    ],
}

# ---------------------------------------------------------------------------
# Label-based fallback mappings
# ---------------------------------------------------------------------------

LABEL_MAPPINGS: Dict[str, List[str]] = {
    # Name
    "first_name": ["first name", "given name", "prénom", "nombre", "first name*"],
    "last_name": ["last name", "surname", "family name", "apellido", "nom", "last name*"],
    "full_name": ["full name", "your name", "applicant name", "candidate name", "legal name"],
    # Email
    "email": ["email", "e-mail", "email address", "email*"],
    # Phone
    "phone": ["phone", "telephone", "mobile", "cell", "contact number", "phone*", "phone number"],
    # Professional
    "linkedin": ["linkedin", "linkedin profile", "linkedin url", "linkedin profile*"],
    "github": ["github", "github profile"],
    "website": ["website", "portfolio", "personal website", "personal site"],
    "current_company": ["current company", "current employer", "most recent company", "current company*"],
    "current_title": ["current title", "current role", "current designation", "current designation*"],
    # Work Experience
    "company_name": ["company name", "company", "employer", "organization", "company name*"],
    "job_title": ["title", "job title", "position", "role", "title*", "designation"],
    "start_date_month": ["start date month", "start month", "from month", "start date month*"],
    "start_date_year": ["start date year", "start year", "from year", "start date year*"],
    "end_date_month": ["end date month", "end month", "to month", "end date month*"],
    "end_date_year": ["end date year", "end year", "to year", "end date year*"],
    # Education
    "school": ["school", "university", "institution", "college", "school name"],
    "degree": ["degree", "qualification"],
    "discipline": ["discipline", "major", "field of study", "concentration"],
    # Salary / Compensation
    "salary": ["salary", "compensation", "ctc", "current ctc", "mention the current ctc", "current ctc*"],
    "salary_expectations": ["expected ctc", "salary expectation", "expected salary", "salary requirement", "expected ctc (fixed)", "expected ctc (fixed)*"],
    "notice_period": ["notice period", "notice", "notice period*"],
    # Other
    "years_of_experience": ["years of experience", "total experience", "years of exp", "total years of experience", "total years of experience*"],
    "gender": ["gender", "gender*"],
    "city": ["city", "town", "locality"],
    "state": ["state", "province", "region"],
    "zip": ["zip", "postal code", "postcode"],
    "country": ["country", "country*"],
    "referral_source": ["how did you hear", "referral source", "source"],
    "cover_letter": ["cover letter"],
    "veteran": ["veteran", "military"],
    "disability": ["disability"],
    "work_authorization": ["authorized to work", "legally authorized", "eligible to work", "work authorization"],
    "sponsorship_required": ["sponsorship", "visa sponsorship", "require sponsorship"],
    "willing_to_relocate": ["willing to work from office", "willing to relocate", "willing to work", "work from office"],
}

# ---------------------------------------------------------------------------
# Fields to skip (EEO/DEI, reCAPTCHA, etc.)
# ---------------------------------------------------------------------------

SKIP_LABEL_KEYWORDS = [
    "race", "ethnicity", "sexual orientation", "lgbtq", "disability status",
    "veteran status", "captcha", "recaptcha", "g-recaptcha",
]

# ---------------------------------------------------------------------------
# Resume Parser (unchanged from v1)
# ---------------------------------------------------------------------------


def _normalize_phone(phone: str) -> str:
    """Normalize phone number to E.164-ish format."""
    digits = re.sub(r"[^\d+]", "", phone)
    if digits.startswith("+"):
        return digits
    if len(digits) == 10:
        return f"+1{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    return digits


class ResumeParser:
    """Parse a plain-text resume into a structured dictionary.

    This is a rule-based parser that uses regex patterns to extract
    name, email, phone, education, experience, skills, etc.
    """

    async def parse(self, text: str) -> Dict[str, Any]:
        """Parse resume text and return a structured profile dict."""
        if not text or not text.strip():
            return {}

        lines = text.strip().split("\n")
        profile: Dict[str, Any] = {}

        # Email
        email_match = re.search(
            r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", text
        )
        if email_match:
            profile["email"] = email_match.group(0).lower()

        # Phone
        phone_match = re.search(
            r"(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}", text
        )
        if phone_match:
            profile["phone"] = _normalize_phone(phone_match.group(0))

        # LinkedIn
        linkedin_match = re.search(
            r"(?:https?://)?(?:www\.)?linkedin\.com/in/[a-zA-Z0-9_-]+", text, re.I
        )
        if linkedin_match:
            profile["linkedin"] = linkedin_match.group(0)

        # GitHub
        github_match = re.search(
            r"(?:https?://)?(?:www\.)?github\.com/[a-zA-Z0-9_-]+", text, re.I
        )
        if github_match:
            profile["github"] = github_match.group(0)

        # Website/Portfolio
        website_match = re.search(
            r"(?:https?://)(?!.*(?:linkedin|github|google|facebook|twitter))[\w.-]+\.[\w]{2,}",
            text, re.I
        )
        if website_match:
            profile["website"] = website_match.group(0)

        # Name (first line, if it looks like a name)
        if lines:
            first_line = lines[0].strip()
            # Filter out lines that are clearly not names
            if not re.match(r"^[\w\s.-]+$", first_line):
                first_line = ""
            if "@" in first_line or first_line.lower().startswith(("http", "summary", "objective", "profile")):
                first_line = ""
            if first_line:
                parts = first_line.split()
                if len(parts) >= 2:
                    profile["first_name"] = parts[0]
                    profile["last_name"] = " ".join(parts[1:])
                elif len(parts) == 1:
                    profile["full_name"] = parts[0]

        # Education
        profile["education"] = self._parse_education(text)

        # Experience
        profile["experience"] = self._parse_experience(text)

        # Skills
        profile["skills"] = self._parse_skills(text)

        # Languages
        profile["languages"] = self._parse_languages(text)

        # Derive additional fields
        if profile.get("experience"):
            for exp in profile["experience"]:
                end = str(exp.get("end", "")).lower()
                if any(k in end for k in ("present", "current", "now")) or not exp.get("end"):
                    if exp.get("title"):
                        profile.setdefault("current_title", exp["title"])
                    if exp.get("company"):
                        profile.setdefault("current_company", exp["company"])
                    break

        if profile.get("education"):
            best = max(
                profile["education"],
                key=lambda e: self._degree_priority(e.get("degree", "")),
            )
            if best.get("degree"):
                profile.setdefault("highest_degree", best["degree"])
            if best.get("institution"):
                profile.setdefault("school", best["institution"])

        return profile

    def _degree_priority(self, degree: str) -> int:
        priority = [
            "phd", "doctorate", "md", "jd",
            "mba", "master", "m.s", "m.a", "m.sc", "m.eng",
            "bachelor", "b.s", "b.a", "b.sc", "b.eng", "b.tech",
            "associate", "diploma",
        ]
        deg_lower = degree.lower()
        for i, d in enumerate(priority):
            if d in deg_lower:
                return len(priority) - i
        return 0

    def _parse_education(self, text: str) -> List[Dict[str, str]]:
        results = []
        edu_pattern = re.compile(
            r"(?i)(?:education|academic|qualification)s?\s*[:\n]"
            r"(.*?)(?=\n\s*\n|\n(?:experience|work|employment|skill|project)|\Z)",
            re.DOTALL,
        )
        match = edu_pattern.search(text)
        if not match:
            return results

        block = match.group(1)
        for line in block.split("\n"):
            line = line.strip()
            if not line or len(line) < 5:
                continue

            degree_match = re.search(
                r"(?i)(bachelor|master|phd|doctorate|mba|b\.?s\.?|m\.?s\.?|b\.?a\.?|m\.?a\.?|b\.?tech|m\.?tech|associate|diploma|engineer)",
                line,
            )
            year_match = re.search(r"\b(19|20)\d{2}\b", line)
            institution = line

            if degree_match:
                entry = {"degree": degree_match.group(0)}
                if year_match:
                    entry["year"] = year_match.group(0)
                # Try to extract institution (part before degree or after comma)
                parts = re.split(r"[,—–-]", line, maxsplit=1)
                if len(parts) > 1:
                    entry["institution"] = parts[0].strip()
                else:
                    # Institution might be the line before
                    entry["institution"] = ""
                results.append(entry)

        return results

    def _parse_experience(self, text: str) -> List[Dict[str, str]]:
        results = []
        exp_pattern = re.compile(
            r"(?i)(?:experience|work|employment|professional)\s*(?:history|background)?\s*[:\n]"
            r"(.*?)(?=\n\s*\n|\n(?:education|skill|project|certification)|\Z)",
            re.DOTALL,
        )
        match = exp_pattern.search(text)
        if not match:
            return results

        block = match.group(1)
        for line in block.split("\n"):
            line = line.strip()
            if not line or len(line) < 5:
                continue

            at_match = re.search(r"(?i)\bat\b", line)
            pipe_match = re.search(r"[|—–-]", line)
            title_company = at_match or pipe_match

            if title_company:
                parts = re.split(r"(?i)\bat\b|[|—–-]", line, maxsplit=1)
                if len(parts) >= 2:
                    title = parts[0].strip()
                    company = parts[1].strip()
                    # Remove dates from company
                    company = re.sub(r"\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{4}\s*[-–]\s*(?:Present|Current|\w+\s+\d{4})", "", company, flags=re.I).strip()
                    entry = {"title": title, "company": company}

                    # Extract dates
                    date_match = re.search(
                        r"(?i)((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+)?(20\d{2}|19\d{2})\s*[-–]\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+)?(Present|Current|20\d{2}|19\d{2})?",
                        line,
                    )
                    if date_match:
                        entry["start"] = f"{date_match.group(1) or ''}{date_match.group(2)}".strip()
                        end_val = date_match.group(4) or date_match.group(3) or ""
                        entry["end"] = end_val.strip() or "Present"

                    results.append(entry)

        return results

    def _parse_skills(self, text: str) -> List[str]:
        skills = []
        skill_pattern = re.compile(
            r"(?i)(?:technical\s+)?skills\s*[:\n](.*?)(?=\n\s*\n|\n(?:education|experience|work|project|certification|language)|\Z)",
            re.DOTALL,
        )
        match = skill_pattern.search(text)
        if match:
            block = match.group(1)
            # Split by common delimiters
            for part in re.split(r"[,;•|·\n]", block):
                skill = part.strip()
                if len(skill) >= 1 and len(skill) < 50:
                    skills.append(skill)
        return skills

    def _parse_languages(self, text: str) -> List[str]:
        langs = []
        lang_pattern = re.compile(
            r"(?i)languages?\s*[:\n](.*?)(?=\n\s*\n|\n(?:education|experience|skill|project)|\Z)",
            re.DOTALL,
        )
        match = lang_pattern.search(text)
        if match:
            block = match.group(1)
            for part in re.split(r"[,;•|·\n]", block):
                lang = part.strip()
                # Remove proficiency levels
                lang = re.sub(r"\(.*?\)", "", lang).strip()
                lang = re.sub(r"(?i)(?:native|fluent|proficient|intermediate|beginner|advanced|conversational)", "", lang).strip()
                if len(lang) >= 1 and len(lang) < 30:
                    langs.append(lang)
        return langs


# ---------------------------------------------------------------------------
# Form Scanner — scans page using CSS selectors + label matching
# ---------------------------------------------------------------------------


class FormScanner:
    """Scan a Playwright Page's form structure using CSS selectors.

    Unlike the v1 JS injection approach, this uses targeted CSS selectors
    from FIELD_SELECTORS plus label-based fallback to find and classify
    form fields. It also detects React Select dropdowns.
    """

    def __init__(self) -> None:
        pass

    async def scan(self, page: Any) -> Dict[str, Any]:
        """Scan the page and return structured form description.

        Parameters
        ----------
        page:
            A Playwright Page.

        Returns
        -------
        dict
            {
                "form_type": str,
                "fields": [{semantic_type, selector, label, type, required, options}],
                "react_selects": [{label, container_selector, options}],
                "submit_button": selector | None,
                "next_button": selector | None,
            }
        """
        result: Dict[str, Any] = {
            "form_type": "generic",
            "fields": [],
            "react_selects": [],
            "submit_button": None,
            "next_button": None,
        }

        # Detect form type
        result["form_type"] = await page.evaluate("""() => {
            const h = (window.location.hostname || '').toLowerCase();
            if (h.includes('docs.google.com') && (
                !!document.querySelector('.freebirdFormviewerView') ||
                !!document.querySelector('[data-params]')
            )) return 'google_forms';
            if (h.includes('greenhouse.io')) return 'greenhouse';
            if (h.includes('workday.com')) return 'workday';
            if (h.includes('lever.co')) return 'lever';
            if (document.querySelector('.MuiInputBase-root')) return 'material_ui';
            if (document.querySelector('.ant-input')) return 'ant_design';
            if (document.querySelector('form')) return 'standard_html';
            return 'generic';
        }""")

        # Scan fields using CSS selectors
        scanned = await page.evaluate("""() => {
            const results = [];
            const seen = new Set();

            function isVisible(el) {
                if (!el) return false;
                const r = el.getBoundingClientRect();
                return !!(r.width && r.height) && getComputedStyle(el).visibility !== 'hidden';
            }

            function getLabel(el) {
                // aria-label
                const a = el.getAttribute('aria-label');
                if (a) return a.trim();

                // label[for]
                if (el.id) {
                    const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
                    if (l) return l.textContent.trim();
                }

                // Parent container label
                const container = el.closest('.field, .question, .form-group, .select__container, .input-wrapper');
                if (container) {
                    const l = container.querySelector('label');
                    if (l) return l.textContent.replace(/\\*/g, '').trim();
                }

                return '';
            }

            function getOptions(el) {
                const opts = [];
                if (el.tagName === 'SELECT') {
                    el.querySelectorAll('option').forEach(o => {
                        const v = o.value;
                        const t = o.textContent.trim();
                        if (v || t) opts.push({value: v, label: t});
                    });
                }
                return opts;
            }

            // Scan all visible inputs, textareas, selects
            document.querySelectorAll(
                'input:not([type="hidden"]):not([type="submit"]):not([type="reset"]):not([type="button"]):not([aria-hidden="true"]), ' +
                'textarea, select'
            ).forEach(el => {
                if (seen.has(el)) return;
                if (!isVisible(el)) return;

                const tag = el.tagName.toLowerCase();
                const type = (el.getAttribute('type') || 'text').toLowerCase();

                // Skip search inputs inside phone/country pickers
                if (type === 'search') return;
                // Skip reCAPTCHA
                if (el.name === 'g-recaptcha-response' || el.id?.includes('recaptcha')) return;
                // Skip React Select hidden inputs
                if (el.classList.contains('select__input') && type === 'text' && el.getAttribute('role') === 'combobox') {
                    seen.add(el);
                    return; // Handled separately
                }
                // Skip hidden required inputs inside select shells
                if (el.classList.contains('remix-css-1a0ro4n-requiredInput')) return;

                seen.add(el);

                const selector = el.id ? '#' + CSS.escape(el.id) : (
                    el.name ? '[name="' + CSS.escape(el.name) + '"]' : ''
                );

                results.push({
                    selector: selector,
                    tag: tag,
                    type: type === 'text' && tag === 'textarea' ? 'textarea' : type,
                    label: getLabel(el),
                    id: el.id || '',
                    name: el.name || '',
                    placeholder: (el.placeholder || '').trim(),
                    required: el.required || el.getAttribute('aria-required') === 'true',
                    options: getOptions(el),
                    isReactSelect: false,
                });
            });

            return results;
        }""")

        # Classify each scanned field using CSS selector matching
        for field in scanned:
            sem_type = self._classify_field(field)
            field["semantic_type"] = sem_type
            result["fields"].append(field)

        # Scan React Select dropdowns
        react_selects = await page.evaluate("""() => {
            const results = [];
            const seen = new Set();

            document.querySelectorAll('.select__container').forEach(container => {
                if (seen.has(container)) return;
                seen.add(container);

                // Get label
                const labelEl = container.querySelector('label.select__label, label');
                const label = labelEl ? labelEl.textContent.replace(/\\*/g, '').trim() : '';

                // Get current value
                const singleValue = container.querySelector('.select__single-value');
                const currentValue = singleValue ? singleValue.textContent.trim() : '';
                const hasSelection = !!currentValue && !/select/i.test(currentValue);

                // Get placeholder
                const placeholder = container.querySelector('.select__placeholder');
                const placeholderText = placeholder ? placeholder.textContent.trim() : '';

                // Build selector
                const id = container.querySelector('input[role="combobox"]')?.id || '';
                const selector = id ? '#' + CSS.escape(id) : '';

                results.push({
                    label: label,
                    container_selector: selector,
                    current_value: currentValue,
                    has_selection: hasSelection,
                    placeholder: placeholderText,
                    element_id: id,
                    required: !!container.querySelector('[aria-required="true"]') ||
                               !!container.querySelector('input[required]'),
                });
            });

            return results;
        }""")

        for rs in react_selects:
            sem_type = self._classify_by_label(rs.get("label", ""))
            rs["semantic_type"] = sem_type
            result["react_selects"].append(rs)

        # Detect buttons
        buttons = await page.evaluate("""() => {
            const buttons = {};
            document.querySelectorAll('button, input[type="submit"], [role="button"]').forEach(btn => {
                const text = (btn.textContent || btn.value || '').trim().toLowerCase();
                const sel = btn.id ? '#' + CSS.escape(btn.id) : (
                    btn.name ? '[name="' + CSS.escape(btn.name) + '"]' : ''
                );
                if (!sel) return;
                if (text.includes('submit') || text.includes('apply now') || text.includes('send application')) {
                    if (!buttons.submit) buttons.submit = {selector: sel, label: btn.textContent.trim()};
                }
                if (text.includes('next') || text.includes('continue') || text.includes('→')) {
                    if (!buttons.next) buttons.next = {selector: sel, label: btn.textContent.trim()};
                }
            });
            return buttons;
        }""")

        result["submit_button"] = buttons.get("submit")
        result["next_button"] = buttons.get("next")

        return result

    def _classify_field(self, field: Dict[str, Any]) -> str:
        """Classify a field by matching its selector, name, id, label, or placeholder."""
        selector = field.get("selector", "")
        name = field.get("name", "").lower()
        fid = field.get("id", "").lower()
        label = field.get("label", "").lower()
        placeholder = field.get("placeholder", "").lower()
        ftype = field.get("type", "")
        tag = field.get("tag", "")

        # Type-based classification (only if no label)
        if ftype == "email" and not label:
            return "email"
        if ftype == "tel" and not label:
            return "phone"
        if ftype == "url" and not label:
            return "website"

        # ID-based exact match — most reliable for Greenhouse
        if fid:
            id_to_sem = {
                "first_name": "first_name",
                "last_name": "last_name",
                "email": "email",
                "phone": "phone",
                "country": "country",
                "resume": "resume",
                "company-name-0": "company_name",
                "title-0": "job_title",
                "start-date-month-0": "start_date_month",
                "start-date-year-0": "start_date_year",
                "end-date-month-0": "end_date_month",
                "end-date-year-0": "end_date_year",
                "current-role-0_1": "current_role",
            }
            # Also try pattern matches
            for key, sem in id_to_sem.items():
                if fid == key:
                    return sem
            # Pattern-based ID matching
            if "company-name" in fid:
                return "company_name"
            if fid.startswith("title-"):
                return "job_title"
            if "start-date-month" in fid:
                return "start_date_month"
            if "start-date-year" in fid:
                return "start_date_year"
            if "end-date-month" in fid:
                return "end_date_month"
            if "end-date-year" in fid:
                return "end_date_year"
            if "current-role" in fid:
                return "current_role"
            if fid.startswith("question_"):
                # Custom question — classify by label below
                pass

        # Label-based classification (most reliable for custom questions)
        if label:
            result = self._classify_by_label(label)
            if result != "unknown":
                return result

        # Check if selector matches any FIELD_SELECTORS
        for sem_type, selectors in FIELD_SELECTORS.items():
            for sel in selectors:
                if 'id*="' in sel or 'id="' in sel:
                    pattern = re.search(r'id[*]?="([^"]+)"', sel)
                    if pattern and pattern.group(1).lower() in (fid, name):
                        return sem_type
                if 'name*="' in sel or 'name="' in sel:
                    pattern = re.search(r'name[*]?="([^"]+)"', sel)
                    if pattern and pattern.group(1).lower() in (fid, name):
                        return sem_type

        # Placeholder-based
        if placeholder:
            return self._classify_by_label(placeholder)

        # Name/ID heuristics
        if "email" in fid or "email" in name:
            return "email"
        if "phone" in fid or "phone" in name or "tel" in fid:
            return "phone"
        if "first" in fid or "first" in name:
            return "first_name"
        if "last" in fid or "last" in name:
            return "last_name"
        if "linkedin" in fid or "linkedin" in name:
            return "linkedin"
        if "github" in fid or "github" in name:
            return "github"
        if "website" in fid or "portfolio" in fid:
            return "website"

        return "unknown"

    def _classify_by_label(self, label: str) -> str:
        """Classify a field by matching its label text against LABEL_MAPPINGS."""
        label_lower = label.lower().strip()
        # Remove trailing asterisks and whitespace
        label_clean = re.sub(r"[\s*]+$", "", label_lower)
        # Also remove inline asterisks (e.g. "First Name*")
        label_clean = label_clean.replace("*", "").strip()

        best_match = "unknown"
        best_score = 0

        for sem_type, keywords in LABEL_MAPPINGS.items():
            for kw in keywords:
                kw_clean = kw.replace("*", "").strip().lower()
                if not kw_clean:
                    continue
                if kw_clean in label_clean or label_clean in kw_clean:
                    score = len(kw_clean)
                    if score > best_score:
                        best_score = score
                        best_match = sem_type

        return best_match


# ---------------------------------------------------------------------------
# Form Filler — fills fields using direct DOM manipulation
# ---------------------------------------------------------------------------


class FormFiller:
    """Fill form fields on a Playwright Page using profile data.

    Uses direct DOM manipulation via page.evaluate() with proper
    event dispatching for React, Angular, Vue, and other frameworks.
    """

    def __init__(self) -> None:
        pass

    async def fill(
        self,
        page: Any,
        scan_result: Dict[str, Any],
        profile: Dict[str, Any],
        *,
        skip_semantic_types: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Fill all fillable fields on page described by scan_result.

        Parameters
        ----------
        page:
            Playwright Page.
        scan_result:
            The dict returned by :class:`FormScanner`.
        profile:
            The dict returned by :class:`ResumeParser` (or manually-built profile).
        skip_semantic_types:
            Semantic types to skip (e.g. ``["salary", "gender"]``).

        Returns
        -------
        dict
            Fill result with ``filled``, ``skipped``, ``errors``, ``details``.
        """
        skip_types = set(skip_semantic_types or [])
        result: Dict[str, Any] = {
            "filled": 0,
            "skipped": 0,
            "errors": 0,
            "details": [],
            "next_page_available": scan_result.get("next_button") is not None,
            "form_complete": scan_result.get("submit_button") is not None
                             and scan_result.get("next_button") is None,
        }

        # Fill standard fields (inputs, textareas, selects)
        for field_info in scan_result.get("fields", []):
            sem = field_info.get("semantic_type", "")
            selector = field_info.get("selector", "")
            fid = field_info.get("id", "")
            label = field_info.get("label", "")

            if not selector:
                result["skipped"] += 1
                result["details"].append({
                    "field_id": fid, "action": "skipped",
                    "reason": "No selector", "semantic_type": sem,
                })
                continue

            if sem in skip_types:
                result["skipped"] += 1
                result["details"].append({
                    "field_id": fid, "action": "skipped",
                    "reason": f"Skipped type '{sem}'", "semantic_type": sem,
                })
                continue

            # Check skip labels
            if self._should_skip_label(label):
                result["skipped"] += 1
                result["details"].append({
                    "field_id": fid, "action": "skipped",
                    "reason": f"Skip label '{label}'", "semantic_type": sem,
                })
                continue

            # Resolve value from profile
            value = self._resolve_value(sem, profile, field_info)

            if value is None:
                result["skipped"] += 1
                result["details"].append({
                    "field_id": fid, "action": "skipped",
                    "reason": f"No profile match for '{sem}'", "semantic_type": sem,
                })
                continue

            # Skip already-filled fields
            already_filled = await page.evaluate("""([sel]) => {
                const el = document.querySelector(sel);
                if (!el) return false;
                if (el.tagName === 'SELECT') return el.value && el.value !== '';
                return !!(el.value && el.value.trim());
            }""", [selector])

            if already_filled:
                result["skipped"] += 1
                result["details"].append({
                    "field_id": fid, "action": "skipped",
                    "reason": "Already filled", "semantic_type": sem,
                })
                continue

            # Fill the field
            try:
                ftype = field_info.get("type", "text")
                tag = field_info.get("tag", "input")

                if tag == "select" or ftype == "select":
                    await self._fill_select(page, selector, str(value), field_info)
                elif tag == "textarea" or ftype == "textarea":
                    await self._fill_textarea(page, selector, str(value))
                elif ftype == "checkbox":
                    await self._fill_checkbox(page, selector, value)
                elif ftype == "radio":
                    await self._fill_radio(page, selector, str(value), field_info)
                else:
                    await self._fill_input(page, selector, str(value))

                result["filled"] += 1
                result["details"].append({
                    "field_id": fid, "action": "filled",
                    "value_used": str(value)[:50],
                    "reason": "OK", "semantic_type": sem,
                })
            except Exception as exc:
                logger.warning("Error filling field %s: %s", fid, exc)
                result["errors"] += 1
                result["details"].append({
                    "field_id": fid, "action": "error",
                    "value_used": str(value)[:50],
                    "reason": str(exc), "semantic_type": sem,
                })

        # Fill React Select dropdowns
        for rs in scan_result.get("react_selects", []):
            sem = rs.get("semantic_type", "unknown")
            label = rs.get("label", "")
            element_id = rs.get("element_id", "")
            has_selection = rs.get("has_selection", False)

            if sem in skip_types or sem == "unknown":
                result["skipped"] += 1
                result["details"].append({
                    "field_id": element_id, "action": "skipped",
                    "reason": f"React Select skipped: type '{sem}'",
                    "semantic_type": sem, "is_react_select": True,
                })
                continue

            if self._should_skip_label(label):
                result["skipped"] += 1
                continue

            if has_selection:
                result["skipped"] += 1
                result["details"].append({
                    "field_id": element_id, "action": "skipped",
                    "reason": "React Select already has selection",
                    "semantic_type": sem, "is_react_select": True,
                })
                continue

            value = self._resolve_value(sem, profile, {})
            if value is None:
                result["skipped"] += 1
                result["details"].append({
                    "field_id": element_id, "action": "skipped",
                    "reason": f"No profile match for React Select '{sem}'",
                    "semantic_type": sem, "is_react_select": True,
                })
                continue

            try:
                filled = await self._fill_react_select(page, rs, str(value))
                if filled:
                    result["filled"] += 1
                    result["details"].append({
                        "field_id": element_id, "action": "filled",
                        "value_used": str(value)[:50],
                        "reason": "React Select filled",
                        "semantic_type": sem, "is_react_select": True,
                    })
                else:
                    result["errors"] += 1
                    result["details"].append({
                        "field_id": element_id, "action": "error",
                        "reason": f"React Select option not found for '{value}'",
                        "semantic_type": sem, "is_react_select": True,
                    })
            except Exception as exc:
                logger.warning("Error filling React Select %s: %s", element_id, exc)
                result["errors"] += 1
                result["details"].append({
                    "field_id": element_id, "action": "error",
                    "reason": str(exc), "semantic_type": sem, "is_react_select": True,
                })

        return result

    async def fill_and_advance(
        self,
        page: Any,
        scan_result: Dict[str, Any],
        profile: Dict[str, Any],
        **kwargs: Any,
    ) -> Dict[str, Any]:
        """Fill the current page, then click Next if available."""
        fill_result = await self.fill(page, scan_result, profile, **kwargs)
        next_btn = scan_result.get("next_button")
        if next_btn and next_btn.get("selector"):
            try:
                await page.click(next_btn["selector"], timeout=5000)
                await page.wait_for_load_state("networkidle", timeout=10000)
            except Exception as exc:
                logger.warning("Failed to click Next: %s", exc)
                fill_result["next_page_available"] = False
        return fill_result

    # -- value resolution ----------------------------------------------------

    def _resolve_value(
        self,
        semantic_type: str,
        profile: Dict[str, Any],
        field_info: Dict[str, Any],
    ) -> Optional[Any]:
        """Look up a value from profile for the given semantic_type."""
        # Direct key match
        direct = profile.get(semantic_type)
        if direct:
            if isinstance(direct, list) and semantic_type in (
                "skills", "languages", "certifications", "education", "experience",
            ):
                return ", ".join(str(d) for d in direct) if all(isinstance(x, str) for x in direct) else direct
            if isinstance(direct, str) and direct.strip():
                return self._normalize_value(direct, semantic_type)
            if isinstance(direct, (int, float, bool)):
                return direct

        # Fallback key mappings
        fallback_map: Dict[str, List[str]] = {
            "first_name": ["first_name", "full_name"],
            "last_name": ["last_name", "full_name"],
            "email": ["email"],
            "phone": ["phone", "phone_full", "mobile"],
            "linkedin": ["linkedin"],
            "github": ["github"],
            "website": ["website", "portfolio"],
            "current_company": ["current_company"],
            "current_title": ["current_title"],
            "company_name": ["current_company", "company_name"],
            "job_title": ["current_title", "job_title"],
            "school": ["school", "university"],
            "highest_degree": ["highest_degree", "degree"],
            "salary": ["salary"],
            "salary_expectations": ["salary", "salary_expectations", "salary_requirements"],
            "notice_period": ["notice_period"],
            "gender": ["gender"],
            "years_of_experience": ["years_of_experience"],
            "referral_source": ["referral_source"],
            "country": ["country"],
            "city": ["city"],
            "state": ["state", "province"],
            "zip": ["zip", "postal_code"],
            "start_date_year": ["start_date_year"],
            "end_date_year": ["end_date_year"],
            "start_date_month": ["start_date_month"],
            "end_date_month": ["end_date_month"],
            "willing_to_relocate": ["willing_to_relocate"],
        }

        for key in fallback_map.get(semantic_type, []):
            val = profile.get(key)
            if val:
                if isinstance(val, str) and val.strip():
                    return self._normalize_value(val, semantic_type)
                if isinstance(val, (int, float, bool)):
                    return val

        # Derive from structured data
        derived = self._derive_value(semantic_type, profile)
        if derived is not None:
            return derived

        return None

    def _derive_value(
        self,
        semantic_type: str,
        profile: Dict[str, Any],
    ) -> Optional[Any]:
        """Derive values from structured profile data."""
        if semantic_type == "highest_degree" and profile.get("education"):
            best = max(
                profile["education"],
                key=lambda e: ResumeParser()._degree_priority(e.get("degree", "")),
            )
            if best.get("degree"):
                return best["degree"]

        if semantic_type in ("school", "university") and profile.get("education"):
            for edu in profile["education"]:
                if edu.get("institution"):
                    return edu["institution"]

        if semantic_type in ("current_title", "current_company") and profile.get("experience"):
            for exp in profile["experience"]:
                end = str(exp.get("end", "")).lower()
                if any(k in end for k in ("present", "current", "now")) or not exp.get("end"):
                    if semantic_type == "current_title" and exp.get("title"):
                        return exp["title"]
                    if semantic_type == "current_company" and exp.get("company"):
                        return exp["company"]

        if semantic_type == "skills" and profile.get("skills"):
            return ", ".join(profile["skills"])

        if semantic_type == "languages" and profile.get("languages"):
            return ", ".join(profile["languages"])

        return None

    def _normalize_value(self, value: str, semantic_type: str) -> str:
        """Normalize a value based on its semantic type."""
        if semantic_type in ("phone",):
            return _normalize_phone(value)
        if semantic_type in ("email", "email_confirm"):
            return value.strip().lower()
        if semantic_type in ("linkedin", "github", "website", "portfolio", "twitter"):
            v = value.strip()
            if v and not v.startswith(("http://", "https://")):
                v = "https://" + v
            return v
        if semantic_type in ("zip", "postal_code"):
            return re.sub(r"[^0-9\-]", "", value)
        return value.strip()

    def _should_skip_label(self, label: str) -> bool:
        """Check if a field should be skipped based on its label."""
        label_lower = label.lower()
        return any(kw in label_lower for kw in SKIP_LABEL_KEYWORDS)

    # -- field-level fill operations -----------------------------------------

    async def _fill_input(self, page: Any, selector: str, value: str) -> None:
        """Fill an input field with proper React-compatible event dispatching."""
        await page.evaluate("""([sel, val]) => {
            const el = document.querySelector(sel);
            if (!el) return;
            el.scrollIntoView({behavior: 'smooth', block: 'center'});
            // Use native value setter for React compatibility
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
            )?.set;
            if (nativeInputValueSetter) {
                nativeInputValueSetter.call(el, val);
            } else {
                el.value = val;
            }
            el.dispatchEvent(new Event('input', {bubbles: true}));
            el.dispatchEvent(new Event('change', {bubbles: true}));
            // Also dispatch for React 16+
            el.dispatchEvent(new Event('blur', {bubbles: true}));
        }""", [selector, value])

    async def _fill_textarea(self, page: Any, selector: str, value: str) -> None:
        """Fill a textarea with React-compatible event dispatching."""
        await page.evaluate("""([sel, val]) => {
            const el = document.querySelector(sel);
            if (!el) return;
            el.scrollIntoView({behavior: 'smooth', block: 'center'});
            const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, 'value'
            )?.set;
            if (nativeSetter) {
                nativeSetter.call(el, val);
            } else {
                el.value = val;
            }
            el.dispatchEvent(new Event('input', {bubbles: true}));
            el.dispatchEvent(new Event('change', {bubbles: true}));
            el.dispatchEvent(new Event('blur', {bubbles: true}));
        }""", [selector, value])

    async def _fill_select(
        self, page: Any, selector: str, value: str, field_info: Dict[str, Any]
    ) -> None:
        """Select an option from a native select element."""
        await page.evaluate("""([sel, val]) => {
            const el = document.querySelector(sel);
            if (!el) return;
            const valueLower = val.toLowerCase().trim();

            // Exact match
            for (const opt of el.options) {
                if (opt.value.toLowerCase() === valueLower || opt.text.toLowerCase() === valueLower) {
                    el.value = opt.value;
                    el.dispatchEvent(new Event('change', {bubbles: true}));
                    return;
                }
            }

            // Substring match
            for (const opt of el.options) {
                if (opt.text.toLowerCase().includes(valueLower) || valueLower.includes(opt.text.toLowerCase())) {
                    el.value = opt.value;
                    el.dispatchEvent(new Event('change', {bubbles: true}));
                    return;
                }
            }
        }""", [selector, value])

    async def _fill_checkbox(self, page: Any, selector: str, value: Any) -> None:
        """Check/uncheck a checkbox."""
        should_check = bool(value)
        await page.evaluate("""([sel, check]) => {
            const el = document.querySelector(sel);
            if (!el) return;
            if (el.checked !== check) {
                el.click();
            }
        }""", [selector, should_check])

    async def _fill_radio(
        self, page: Any, selector: str, value: str, field_info: Dict[str, Any]
    ) -> None:
        """Click the matching radio button."""
        await page.evaluate("""([sel, val]) => {
            // Find radio with matching value or label
            const radios = document.querySelectorAll('input[type="radio"]');
            const valueLower = val.toLowerCase().trim();
            for (const r of radios) {
                if (r.value.toLowerCase() === valueLower) {
                    r.click();
                    return;
                }
                const label = r.closest('label');
                if (label && label.textContent.toLowerCase().includes(valueLower)) {
                    r.click();
                    return;
                }
            }
        }""", [selector, value])

    async def _fill_react_select(
        self, page: Any, rs_info: Dict[str, Any], value: str
    ) -> bool:
        """Fill a React Select dropdown by opening it, finding option, clicking.

        Uses full pointer event sequence for React compatibility.
        Returns True if successfully filled.
        """
        return await page.evaluate("""async ([rsInfo, value]) => {
            const elementId = rsInfo.element_id || '';
            const sleep = ms => new Promise(r => setTimeout(r, ms));

            // Find the combobox input
            let input;
            if (elementId) {
                input = document.getElementById(elementId);
            }
            if (!input) {
                // Try finding by container
                const containers = document.querySelectorAll('.select__container');
                for (const c of containers) {
                    const label = c.querySelector('label');
                    if (label && label.textContent.replace(/\\*/g, '').trim().toLowerCase().includes(
                        rsInfo.label?.toLowerCase() || ''
                    )) {
                        input = c.querySelector('input[role="combobox"]');
                        break;
                    }
                }
            }
            if (!input) return false;

            // Find the control div
            const shell = input.closest('.select__container') || input.closest('.select-shell');
            const control = shell?.querySelector('.select__control') || shell;

            if (!control) return false;

            // Focus and open dropdown with full pointer event sequence
            input.focus();
            await sleep(50);

            const rect = control.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;

            ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
                control.dispatchEvent(new PointerEvent(type, {
                    bubbles: true, cancelable: true, view: window,
                    clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse',
                }));
            });

            await sleep(300);

            // Find the menu (may be portaled to body)
            let menu = null;
            const listboxId = input.getAttribute('aria-controls');
            if (listboxId) {
                menu = document.getElementById(listboxId);
            }
            if (!menu) {
                menu = shell?.querySelector('[role="listbox"], .select__menu');
            }
            if (!menu) {
                // Check for portaled menu in body
                for (const m of document.querySelectorAll('.select__menu, [role="listbox"]')) {
                    if (m.closest('.phone-input, .iti')) continue;
                    const r = m.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) {
                        menu = m;
                        break;
                    }
                }
            }

            if (!menu) {
                // Close and return
                input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
                document.body.click();
                return false;
            }

            // Find matching option
            const valueLower = value.toLowerCase().trim();
            const options = menu.querySelectorAll('[role="option"], .select__option, li');

            for (const opt of options) {
                const text = (opt.textContent || '').trim().toLowerCase();
                if (text === valueLower || text.includes(valueLower) || valueLower.includes(text)) {
                    opt.click();
                    await sleep(100);
                    return true;
                }
            }

            // No match found — try typing into the input to filter
            input.value = value;
            input.dispatchEvent(new Event('input', {bubbles: true}));
            await sleep(500);

            // Re-check for filtered options
            const filtered = menu.querySelectorAll('[role="option"], .select__option, li');
            for (const opt of filtered) {
                const text = (opt.textContent || '').trim().toLowerCase();
                if (text === valueLower || text.includes(valueLower)) {
                    opt.click();
                    await sleep(100);
                    return true;
                }
            }

            // Close dropdown
            input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
            document.body.click();
            return false;
        }""", [rs_info, value])


# ---------------------------------------------------------------------------
# Convenience: full pipeline
# ---------------------------------------------------------------------------

async def analyze_and_fill(
    page: Any,
    profile: Dict[str, Any],
    *,
    skip_types: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """One-shot convenience: scan the page then fill it."""
    scanner = FormScanner()
    filler = FormFiller()

    scan_result = await scanner.scan(page)
    fill_result = await filler.fill(page, scan_result, profile, skip_semantic_types=skip_types)

    return {
        "scan": scan_result,
        "fill": fill_result,
    }
