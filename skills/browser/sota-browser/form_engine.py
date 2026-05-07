"""
Form Engine — Resume parsing, field matching, form analysis, and form filling.

Provides four main classes:
  - ResumeParser:   Plain-text resume → structured dict
  - FieldMatcher:   Form field label → semantic field type
  - FormAnalyzer:   Playwright Page → structured form description (JS injection)
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
# Constants & alias database
# ---------------------------------------------------------------------------

FIELD_ALIASES: Dict[str, List[str]] = {
    # Name
    "first_name": [
        "first name", "fname", "given name", "first", "nombre",
        "prénom", "prenom", "名", "vorname", "名前",
    ],
    "middle_name": [
        "middle name", "mname", "middle initial", "middle",
        "segundo nombre", "deuxième prénom",
    ],
    "last_name": [
        "last name", "lname", "surname", "family name", "last",
        "apellido", "nom de famille", "姓", "nachname", "名字",
    ],
    "full_name": [
        "full name", "name", "your name", "applicant name",
        "candidate name", "nombre completo", "nom complet", "氏名",
        "full legal name", "legal name",
    ],
    "preferred_name": [
        "preferred name", "preferred", "nickname", "how should we call you",
        "what should we call you", "name you go by",
    ],

    # Email
    "email": [
        "email", "e-mail", "email address", "correo electrónico",
        "courriel", "email id", "primary email", "email address *",
    ],
    "email_confirm": [
        "confirm email", "re-enter email", "verify email",
        "email confirmation", "retype email", "email (confirm)",
    ],

    # Phone
    "phone": [
        "phone", "telephone", "mobile", "cell", "phone number", "tel",
        "teléfono", "téléphone", "phone no", "contact number",
        "primary phone", "mobile number", "cell phone", "phone #",
        "best number to reach you",
    ],
    "phone_type": [
        "phone type", "type of phone", "phone category",
    ],
    "phone_country": [
        "phone country code", "country code", "dialing code",
    ],

    # Address
    "address": [
        "address", "street address", "full address", "mailing address",
        "residential address", "home address", "dirección", "adresse",
        "address line 1 + 2", "street",
    ],
    "address_line1": [
        "address line 1", "address line 1 *", "street address line 1",
        "address 1", "street address", "address line 1",
    ],
    "address_line2": [
        "address line 2", "address line 2 *", "apt", "apartment",
        "suite", "unit", "address 2", "street address line 2",
    ],
    "city": [
        "city", "town", "locality", "ciudad", "ville", "市区町村",
        "city/town",
    ],
    "state": [
        "state", "province", "region", "estado", "état", "都道府県",
        "state/province", "state *",
    ],
    "province": [
        "province", "territory", "prefecture",
    ],
    "zip": [
        "zip", "zip code", "postal code", "postcode", "zip/postal code",
        "código postal", "code postal", "郵便番号", "zip code *",
    ],
    "postal_code": [
        "postal code", "postcode", "zip code", "pin code", "pincode",
    ],
    "country": [
        "country", "nation", "país", "pays", "国", "country/region",
        "country of residence", "country *",
    ],

    # Birthday
    "birthday": [
        "birthday", "date of birth", "dob", "birth date", "born on",
        "fecha de nacimiento", "date de naissance", "生年月日",
    ],
    "birthday_month": [
        "birth month", "month of birth", "dob month",
    ],
    "birthday_day": [
        "birth day", "day of birth", "dob day",
    ],
    "birthday_year": [
        "birth year", "year of birth", "dob year",
    ],

    # Demographics
    "gender": [
        "gender", "sex", "género", "sexe", "性別",
    ],
    "pronouns": [
        "pronouns", "preferred pronouns", "personal pronouns",
    ],

    # Web profiles
    "linkedin": [
        "linkedin", "linkedin url", "linkedin profile", "linked in",
        "linkedin profile url",
    ],
    "github": [
        "github", "github url", "github profile", "github username",
        "git hub",
    ],
    "portfolio": [
        "portfolio", "portfolio url", "portfolio link",
        "portfolio website",
    ],
    "website": [
        "website", "web site", "url", "personal website", "homepage",
        "blog", "web page",
    ],
    "twitter": [
        "twitter", "x handle", "twitter handle", "x.com",
        "twitter url", "x profile",
    ],

    # Education
    "education": [
        "education", "educational background",
    ],
    "highest_degree": [
        "highest degree", "highest level of education", "degree earned",
        "degree obtained", "education level", "degree",
        "nivel de educación", "niveau d'études",
    ],
    "graduation_date": [
        "graduation date", "graduation year", "expected graduation",
        "date of graduation", "graduated",
    ],
    "gpa": [
        "gpa", "grade point average", "cumulative gpa",
    ],
    "school": [
        "school", "high school", "college", "university",
        "institution", "school name", "university name",
        "college name", "escuela", "école", "学校",
    ],
    "university": [
        "university", "college", "institution", "alma mater",
    ],

    # Experience
    "experience": [
        "experience", "work experience", "professional experience",
        "work history", "employment history",
    ],
    "current_company": [
        "current company", "employer", "current employer", "company",
        "organization", "company name", "employer name",
        "current organization", "empresa actual",
    ],
    "current_title": [
        "current title", "job title", "title", "position",
        "current position", "role", "current role", "puesto actual",
        "titre du poste",
    ],
    "start_date": [
        "start date", "from date", "begin date", "date started",
        "start", "employment start",
    ],
    "end_date": [
        "end date", "to date", "end", "date ended", "employment end",
    ],

    # Skills
    "skills": [
        "skills", "technical skills", "core skills", "key skills",
        "competencies", "habilidades", "compétences", "スキル",
        "areas of expertise",
    ],
    "languages": [
        "languages", "languages spoken", "language skills",
        "spoken languages", "idiomas", "langues", "言語",
    ],
    "certifications": [
        "certifications", "certificates", "licenses", "credentials",
        "professional certifications", "certificaciones",
        "certifications/licenses",
    ],

    # Uploads
    "resume": [
        "resume", "cv", "curriculum vitae", "attach resume",
        "upload resume", "résumé", "upload cv",
    ],
    "cover_letter": [
        "cover letter", "coverletter", "message to hiring manager",
        "letter of interest", "motivation letter",
    ],

    # Work authorization
    "work_authorization": [
        "work authorization", "authorized to work", "eligibility",
        "right to work", "legally authorized", "authorized to work in",
        "employment eligibility",
    ],
    "visa_status": [
        "visa status", "visa type", "visa", "immigration status",
        "work permit", "work visa",
    ],
    "sponsorship_required": [
        "require sponsorship", "need sponsorship", "visa sponsorship",
        "sponsorship", "will you now or in the future require sponsorship",
        "require visa sponsorship",
    ],

    # EEO / demographic
    "veteran": [
        "veteran", "veteran status", "military service",
        "protected veteran", "are you a veteran",
    ],
    "disability": [
        "disability", "disability status", "have a disability",
        "differently abled",
    ],
    "ethnicity": [
        "ethnicity", "race", "ethnic origin", "racial category",
        "ethnic background",
    ],
    "hispanic": [
        "hispanic", "hispanic or latino", "latino", "are you hispanic",
    ],

    # Compensation
    "salary": [
        "salary", "salary expectations", "salary requirement",
        "compensation", "expected salary", "desired salary",
        "salary range", "pay expectations",
    ],
    "salary_requirements": [
        "salary requirements", "salary expectations", "desired compensation",
        "expected compensation", "pay requirements",
    ],
    "start_date_availability": [
        "start date", "availability", "available start date",
        "earliest start date", "when can you start",
        "date available", "start date availability",
    ],

    # Referral
    "referral_source": [
        "how did you hear", "referral source", "source",
        "how did you find us", "where did you hear",
        "how did you learn about",
    ],
    "referred_by": [
        "referred by", "referral name", "who referred you",
        "employee referral",
    ],

    # Meta / fallback
    "custom_open_ended": [
        # intentional empty — catch-all
    ],
    "yes_no": [
        "yes/no", "yes no",
    ],
    "multiple_choice": [
        "multiple choice", "choose one",
    ],
    "checkbox_group": [
        "check all that apply", "select all", "choose all",
    ],
}

# Canonical semantic types for quick lookup
SEMANTIC_TYPES = list(FIELD_ALIASES.keys())

# Regex patterns used by ResumeParser
_RE_EMAIL = re.compile(
    r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}"
)
_RE_PHONE = re.compile(
    r"(?:\+?\d{1,3}[\s.\-]?)?"           # country code
    r"(?:\(?\d{2,4}\)?[\s.\-]?)"         # area code
    r"(?:\d{2,4}[\s.\-]?){2,4}"          # subscriber number
    r"\d{0,2}"
    r"(?![\d\w])",
)
_RE_LINKEDIN = re.compile(
    r"(?:https?://)?(?:www\.)?linkedin\.com/in/[a-zA-Z0-9\-_%]+",
    re.IGNORECASE,
)
_RE_GITHUB = re.compile(
    r"(?:https?://)?(?:www\.)?github\.com/[a-zA-Z0-9\-_]+",
    re.IGNORECASE,
)
_RE_URL = re.compile(
    r"https?://[^\s<>\"')]+", re.IGNORECASE,
)
_RE_ZIP = re.compile(r"\b\d{5}(?:-\d{4})?\b")
_RE_STATE = re.compile(
    r"\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI"
    r"|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT"
    r"|VT|VA|WA|WV|WI|WY)\b"
)

# Section header patterns for resume parsing
_EDUCATION_HEADERS = re.compile(
    r"(?:education|academic|academics|qualification|qualifications|"
    r"educational\s*background|scholastic)",
    re.IGNORECASE,
)
_EXPERIENCE_HEADERS = re.compile(
    r"(?:experience|work\s*experience|professional\s*experience|"
    r"work\s*history|employment|employment\s*history|career\s*history|"
    r"professional\s*background)",
    re.IGNORECASE,
)
_SKILLS_HEADERS = re.compile(
    r"(?:skills|technical\s*skills|core\s*skills|key\s*skills|"
    r"technologies|competencies|areas?\s*of\s*expertise|proficiencies|"
    r"tools\s*&\s*technologies)",
    re.IGNORECASE,
)
_SUMMARY_HEADERS = re.compile(
    r"(?:summary|objective|profile|about\s*me|professional\s*summary|"
    r"career\s*summary|personal\s*statement|executive\s*summary|"
    r"career\s*objective)",
    re.IGNORECASE,
)
_LANGUAGES_HEADERS = re.compile(
    r"(?:languages|language\s*skills)",
    re.IGNORECASE,
)
_CERTIFICATIONS_HEADERS = re.compile(
    r"(?:certifications?|licenses?|credentials?|certifications?\s*&\s*licenses?)",
    re.IGNORECASE,
)
_NEXT_SECTION = re.compile(
    r"(?:education|experience|skills|summary|objective|profile|about|"
    r"certifications?|licenses?|languages|projects|publications|"
    r"awards?|interests|hobbies|references|volunteer|affiliations)",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Utility helpers
# ---------------------------------------------------------------------------

def _clean(text: Optional[str]) -> str:
    if not text:
        return ""
    return re.sub(r"\s+", " ", text).strip()


def _normalize_phone(phone: str) -> str:
    """Return a reasonably formatted phone number."""
    digits = re.sub(r"\D", "", phone)
    if len(digits) == 10:
        return f"({digits[:3]}) {digits[3:6]}-{digits[6:]}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+1 ({digits[1:4]}) {digits[4:7]}-{digits[7:]}"
    if len(digits) > 7:
        return f"+{digits}"
    return phone


def _normalize_date(date_str: str, target_format: str = "MM/DD/YYYY") -> str:
    """Attempt to parse a date string and reformat it.

    target_format can be 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD/MM/YYYY',
    'Month DD, YYYY', etc.
    """
    from datetime import datetime as _dt

    if not date_str:
        return ""

    date_str = date_str.strip()
    formats_in = [
        "%m/%d/%Y", "%Y-%m-%d", "%d/%m/%Y", "%B %d, %Y", "%b %d, %Y",
        "%m-%d-%Y", "%d-%m-%Y", "%Y/%m/%d", "%m/%Y", "%B %Y", "%b %Y",
        "%Y", "%m/%d/%y",
    ]
    parsed = None
    for fmt in formats_in:
        try:
            parsed = _dt.strptime(date_str, fmt)
            break
        except ValueError:
            continue
    if parsed is None:
        return date_str

    mapping = {
        "MM/DD/YYYY": "%m/%d/%Y",
        "YYYY-MM-DD": "%Y-%m-%d",
        "DD/MM/YYYY": "%d/%m/%Y",
        "Month DD, YYYY": "%B %d, %Y",
        "MM/YYYY": "%m/%Y",
        "YYYY": "%Y",
    }
    out_fmt = mapping.get(target_format, target_format)
    try:
        return parsed.strftime(out_fmt)
    except (ValueError, TypeError):
        return date_str


# ---------------------------------------------------------------------------
# ResumeParser
# ---------------------------------------------------------------------------

class ResumeParser:
    """Parse a plain-text resume into a structured dictionary."""

    def __init__(self) -> None:
        self.text: str = ""
        self.lines: List[str] = []

    # -- public API ----------------------------------------------------------

    async def parse(self, resume_text: str) -> Dict[str, Any]:
        """Parse *resume_text* and return a structured dict."""
        self.text = resume_text
        self.lines = [l for l in resume_text.splitlines() if l.strip()]

        result: Dict[str, Any] = {
            "first_name": "",
            "last_name": "",
            "full_name": "",
            "email": self._extract_email(),
            "phone": self._extract_phone(),
            "address": "",
            "city": "",
            "state": "",
            "zip": "",
            "country": "",
            "linkedin": self._extract_linkedin(),
            "github": self._extract_github(),
            "website": self._extract_website(),
            "portfolio": "",
            "education": self._extract_education(),
            "experience": self._extract_experience(),
            "skills": self._extract_skills(),
            "summary": self._extract_summary(),
            "languages": self._extract_languages(),
            "certifications": self._extract_certifications(),
            "current_title": "",
            "current_company": "",
        }

        name = self._extract_name()
        result["full_name"] = name
        parts = name.split(None, 1)
        result["first_name"] = parts[0] if parts else ""
        result["last_name"] = parts[1] if len(parts) > 1 else ""

        addr = self._extract_address()
        result["address"] = addr.get("address", "")
        result["city"] = addr.get("city", "")
        result["state"] = addr.get("state", "")
        result["zip"] = addr.get("zip", "")
        result["country"] = addr.get("country", "")

        # Derive current title / company from first experience entry
        if result["experience"]:
            first = result["experience"][0]
            result["current_title"] = first.get("title", "")
            result["current_company"] = first.get("company", "")

        # Derive portfolio from website if it looks like one
        if result["website"] and not result["portfolio"]:
            wl = result["website"].lower()
            if "portfolio" in wl or "folio" in wl:
                result["portfolio"] = result["website"]

        return result

    # -- private helpers -----------------------------------------------------

    def _extract_name(self) -> str:
        # Pattern: "Name: John Doe"
        for line in self.lines[:10]:
            m = re.match(r"^(?:name|nombre)\s*:\s*(.+)$", line.strip(), re.IGNORECASE)
            if m:
                return _clean(m.group(1))

        # Heuristic: first non-empty line that looks like a name
        for line in self.lines[:5]:
            stripped = line.strip()
            if not stripped:
                continue
            # Skip lines that look like contact info or section headers
            if _RE_EMAIL.search(stripped):
                continue
            if _RE_PHONE.search(stripped):
                continue
            if stripped.startswith(("http", "www.", "@", "#", "-", "*", "|")):
                continue
            if re.match(r"^[\d]", stripped):
                continue
            # Must contain mostly letters and spaces
            if re.match(r"^[A-Za-zÀ-ÿ\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\s.\-']+$", stripped):
                # Not a section header
                if not _NEXT_SECTION.match(stripped):
                    return _clean(stripped)
        return ""

    def _extract_email(self) -> str:
        for line in self.lines:
            m = _RE_EMAIL.search(line)
            if m:
                return m.group(0).lower()
        return ""

    def _extract_phone(self) -> str:
        for line in self.lines:
            m = _RE_PHONE.search(line)
            if m:
                phone = m.group(0).strip()
                # Filter out things that look like zip codes
                if len(re.sub(r"\D", "", phone)) >= 7:
                    return _normalize_phone(phone)
        return ""

    def _extract_linkedin(self) -> str:
        for line in self.lines:
            m = _RE_LINKEDIN.search(line)
            if m:
                url = m.group(0)
                if not url.startswith("http"):
                    url = "https://" + url
                return url
        return ""

    def _extract_github(self) -> str:
        for line in self.lines:
            m = _RE_GITHUB.search(line)
            if m:
                url = m.group(0)
                if not url.startswith("http"):
                    url = "https://" + url
                return url
        return ""

    def _extract_website(self) -> str:
        urls: List[str] = []
        for line in self.lines:
            for m in _RE_URL.finditer(line):
                url = m.group(0)
                low = url.lower()
                if "linkedin.com" in low or "github.com" in low:
                    continue
                urls.append(url.rstrip(".,;:)"))
        if urls:
            return urls[0]
        return ""

    def _extract_address(self) -> Dict[str, str]:
        result: Dict[str, str] = {
            "address": "", "city": "", "state": "", "zip": "", "country": ""
        }
        # Look for a line that contains a zip code
        for line in self.lines:
            zip_match = _RE_ZIP.search(line)
            state_match = _RE_STATE.search(line)
            if zip_match:
                result["zip"] = zip_match.group(0)
                if state_match:
                    result["state"] = state_match.group(1)
                # Try to extract city (word before state)
                before = line[:state_match.start() if state_match else zip_match.start()]
                city_match = re.search(r"([A-Za-z\s]+),?\s*$", before)
                if city_match:
                    result["city"] = _clean(city_match.group(1)).rstrip(",")
                result["address"] = _clean(line)
                break

            # Pattern: "City, ST" or "City, ST ZIP"
            cs_match = re.search(
                r"([A-Za-z][A-Za-z\s]+),\s*([A-Z]{2})(?:\s+(\d{5}(?:-\d{4})?))?",
                line,
            )
            if cs_match:
                result["city"] = _clean(cs_match.group(1))
                result["state"] = cs_match.group(2)
                result["zip"] = cs_match.group(3) or ""
                result["address"] = _clean(line)
                break
        return result

    def _section_range(self, header_re: re.Pattern) -> Tuple[int, int]:
        """Return (start, end) line indices for a section."""
        start = -1
        for i, line in enumerate(self.lines):
            if header_re.match(line.strip()):
                start = i + 1
                break
        if start == -1:
            return (-1, -1)
        end = len(self.lines)
        for i in range(start, len(self.lines)):
            if i > start and _NEXT_SECTION.match(self.lines[i].strip()):
                end = i
                break
        return (start, end)

    def _extract_education(self) -> List[Dict[str, str]]:
        start, end = self._section_range(_EDUCATION_HEADERS)
        if start == -1:
            return []
        entries: List[Dict[str, str]] = []
        current: Optional[Dict[str, str]] = None

        for i in range(start, end):
            line = self.lines[i].strip()
            if not line:
                continue
            # Heuristic: a new entry starts with a line that looks like a school name
            # (contains digits for year, or is a notable school line)
            year_match = re.search(r"\b((?:19|20)\d{2})\b", line)
            degree_match = re.search(
                r"(?:bachelor|master|phd|ph\.d|b\.s|m\.s|b\.a|m\.a|b\.tech"
                r"|m\.tech|mba|md|jd|associate|diploma|doctorate|b\.e|m\.e"
                r"|b\.sc|m\.sc|b\.eng|m\.eng|undergraduate|graduate)",
                line,
                re.IGNORECASE,
            )

            if degree_match or (year_match and current is None):
                if current:
                    entries.append(current)
                current = {
                    "institution": "",
                    "degree": "",
                    "field": "",
                    "year": year_match.group(1) if year_match else "",
                    "description": "",
                }
                # Try to extract degree from the line
                dm = re.search(
                    r"(bachelor|master|phd|ph\.d|b\.s|m\.s|b\.a|m\.a|"
                    r"b\.tech|m\.tech|mba|md|jd|associate|diploma|"
                    r"doctorate|b\.e|m\.e|b\.sc|m\.sc|b\.eng|m\.eng)\s*"
                    r"(?:of|in)?\s*(.*)",
                    line,
                    re.IGNORECASE,
                )
                if dm:
                    current["degree"] = _clean(dm.group(1)).upper()
                    field_part = dm.group(2).strip().rstrip(",.")
                    if field_part:
                        # Remove trailing year
                        field_part = re.sub(
                            r"\b((?:19|20)\d{2})\s*[-–]\s*((?:19|20)\d{2}|present|current)\b",
                            "", field_part,
                        ).strip()
                        current["field"] = _clean(field_part)
                continue

            if current is None:
                # First line might be institution name
                current = {
                    "institution": _clean(line),
                    "degree": "",
                    "field": "",
                    "year": year_match.group(1) if year_match else "",
                    "description": "",
                }
                continue

            # If current exists and line has a degree keyword, fill degree
            if not current["degree"] and degree_match:
                dm = re.search(
                    r"(bachelor|master|phd|ph\.d|b\.s|m\.s|b\.a|m\.a|"
                    r"b\.tech|m\.tech|mba|md|jd|associate|diploma|"
                    r"doctorate|b\.e|m\.e|b\.sc|m\.sc|b\.eng|m\.eng)\s*"
                    r"(?:of|in)?\s*(.*)",
                    line,
                    re.IGNORECASE,
                )
                if dm:
                    current["degree"] = _clean(dm.group(1)).upper()
                    field_part = dm.group(2).strip().rstrip(",.")
                    if field_part:
                        current["field"] = _clean(field_part)
                continue

            # If institution not set, this might be it
            if not current["institution"]:
                current["institution"] = _clean(line)
            else:
                current["description"] += " " + _clean(line)

        if current:
            entries.append(current)
        return entries

    def _extract_experience(self) -> List[Dict[str, str]]:
        start, end = self._section_range(_EXPERIENCE_HEADERS)
        if start == -1:
            return []
        entries: List[Dict[str, str]] = []
        current: Optional[Dict[str, str]] = None

        for i in range(start, end):
            line = self.lines[i].strip()
            if not line:
                continue

            # Detect a new job entry: lines with company/title + optional dates
            date_match = re.search(
                r"((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)"
                r"[a-z]*\.?\s+)?((?:19|20)\d{2})\s*[-–to]+\s*"
                r"((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)"
                r"[a-z]*\.?\s+)?((?:19|20)\d{2}|present|current|now)",
                line,
                re.IGNORECASE,
            )
            pipe_match = re.match(r"^(.+?)\s*[\|–—]\s*(.+?)$", line)

            if date_match or (pipe_match and current is not None and not line.startswith(("-", "•", "*", "·"))):
                if current:
                    entries.append(current)

                start_str = _clean(date_match.group(0).split("-")[0]) if date_match else ""
                end_str = ""
                if date_match:
                    parts = date_match.group(0).split("-")
                    if len(parts) == 2:
                        start_str = _clean(parts[0])
                        end_str = _clean(parts[1])
                    else:
                        end_str = _clean(date_match.group(0))

                # Before the date is company / title
                before_date = line[:date_match.start()].strip() if date_match else line.strip()
                title = ""
                company = ""

                at_match = re.search(r"(.+?)\s+at\s+(.+)", before_date, re.IGNORECASE)
                pipe_sep = re.match(r"^(.+?)\s*[\|–—]\s*(.+?)$", before_date)
                comma_sep = re.match(r"^(.+?),\s*(.+?)$", before_date)

                if at_match:
                    title = _clean(at_match.group(1))
                    company = _clean(at_match.group(2))
                elif pipe_sep:
                    title = _clean(pipe_sep.group(1))
                    company = _clean(pipe_sep.group(2))
                elif comma_sep:
                    title = _clean(comma_sep.group(1))
                    company = _clean(comma_sep.group(2))
                else:
                    company = _clean(before_date)

                current = {
                    "company": company,
                    "title": title,
                    "start": start_str,
                    "end": end_str,
                    "description": "",
                }
                continue

            if current is None:
                current = {
                    "company": _clean(line),
                    "title": "",
                    "start": "",
                    "end": "",
                    "description": "",
                }
                continue

            # Accumulate description
            if line.startswith(("-", "•", "*", "·", "→")):
                current["description"] += "\n" + _clean(line)
            else:
                # If title is empty and this doesn't look like a description
                if not current["title"] and not line[0].isdigit():
                    at_match2 = re.search(r"(.+?)\s+at\s+(.+)", line, re.IGNORECASE)
                    if at_match2:
                        current["title"] = _clean(at_match2.group(1))
                        current["company"] = _clean(at_match2.group(2))
                    elif not current["company"]:
                        current["company"] = _clean(line)
                    else:
                        current["title"] = _clean(line)
                else:
                    current["description"] += "\n" + _clean(line)

        if current:
            entries.append(current)

        # Clean up descriptions
        for entry in entries:
            entry["description"] = entry["description"].strip()
        return entries

    def _extract_skills(self) -> List[str]:
        start, end = self._section_range(_SKILLS_HEADERS)
        if start == -1:
            return []
        skills_text = "\n".join(self.lines[start:end])
        # Split by common delimiters
        raw = re.split(r"[,;|•·\n]", skills_text)
        cleaned: List[str] = []
        for s in raw:
            s = s.strip().lstrip("-*•·→")
            if s and len(s) > 1:
                cleaned.append(s)
        return cleaned

    def _extract_summary(self) -> str:
        start, end = self._section_range(_SUMMARY_HEADERS)
        if start == -1:
            return ""
        return _clean(" ".join(self.lines[start:end]))

    def _extract_languages(self) -> List[str]:
        start, end = self._section_range(_LANGUAGES_HEADERS)
        if start == -1:
            return []
        text = "\n".join(self.lines[start:end])
        raw = re.split(r"[,;|•·\n]", text)
        cleaned: List[str] = []
        for s in raw:
            s = s.strip().lstrip("-*•·→")
            # Remove proficiency levels like "(Native)", "(Fluent)"
            s = re.sub(r"\s*[\(\[](?:Native|Fluent|Intermediate|Beginner|"
                        r"Advanced|Conversational|Professional|Basic|"
                        r"Nativo|Fluido|Intermedio)[\)\]]", "", s, flags=re.IGNORECASE)
            if s and len(s) > 1:
                cleaned.append(s)
        return cleaned

    def _extract_certifications(self) -> List[str]:
        start, end = self._section_range(_CERTIFICATIONS_HEADERS)
        if start == -1:
            return []
        certs: List[str] = []
        for i in range(start, end):
            line = self.lines[i].strip()
            if not line:
                continue
            # May be comma-separated or newline-separated
            parts = re.split(r"[,;•·]", line)
            for p in parts:
                p = p.strip().lstrip("-*•·→")
                if p and len(p) > 2:
                    certs.append(p)
        return certs


# ---------------------------------------------------------------------------
# FieldMatcher
# ---------------------------------------------------------------------------

class FieldMatcher:
    """Map form-field labels to canonical semantic field types."""

    def __init__(self) -> None:
        # Build reverse lookup: alias (lower) → semantic type
        self._alias_map: Dict[str, str] = {}
        for sem_type, aliases in FIELD_ALIASES.items():
            for alias in aliases:
                key = alias.lower().strip()
                if key:
                    self._alias_map[key] = sem_type

    # -- public API ----------------------------------------------------------

    def match(
        self,
        label: str,
        *,
        placeholder: str = "",
        name_attr: str = "",
        aria_label: str = "",
        input_type: str = "",
        id_attr: str = "",
        neighboring_types: Optional[List[str]] = None,
    ) -> Tuple[str, float]:
        """Return ``(semantic_type, confidence)`` for the given field clues.

        Uses multiple strategies in priority order and returns the best match.
        """
        candidates: List[Tuple[str, float]] = []

        texts_to_check = [
            (label, 1.0),
            (aria_label, 0.9),
            (placeholder, 0.7),
            (name_attr, 0.6),
            (id_attr, 0.4),
        ]

        # Strategy 1: exact alias match
        for text, base_weight in texts_to_check:
            if not text:
                continue
            key = text.lower().strip()
            # Strip trailing * and whitespace
            key = re.sub(r"[*:\s]+$", "", key).strip()
            if key in self._alias_map:
                candidates.append((self._alias_map[key], base_weight))

            # Also try the full lower text as prefix match
            for alias, sem in self._alias_map.items():
                if key == alias:
                    candidates.append((sem, base_weight))
                elif alias in key or key in alias:
                    score = base_weight * 0.85 * (
                        min(len(alias), len(key)) / max(len(alias), len(key))
                    )
                    candidates.append((sem, score))

        # Strategy 2: input type heuristics
        type_hints = {
            "email": "email",
            "tel": "phone",
            "url": "website",
            "number": "number",
            "date": "birthday",
        }
        if input_type and input_type in type_hints:
            hinted = type_hints[input_type]
            candidates.append((hinted, 0.5))

        # Strategy 3: keyword scoring
        all_keywords = self._keyword_score(texts_to_check)
        if all_keywords:
            candidates.extend(all_keywords)

        # Strategy 4: context-aware (neighboring fields)
        if neighboring_types:
            ctx = self._context_hint(neighboring_types)
            if ctx:
                candidates.append((ctx[0], ctx[1]))

        if not candidates:
            return ("custom_open_ended", 0.0)

        # Pick best
        candidates.sort(key=lambda c: c[1], reverse=True)
        return candidates[0]

    # -- private helpers -----------------------------------------------------

    def _keyword_score(
        self, texts: List[Tuple[str, float]]
    ) -> List[Tuple[str, float]]:
        results: List[Tuple[str, float]] = []
        for sem_type, aliases in FIELD_ALIASES.items():
            if not aliases:
                continue
            best = 0.0
            for text, base_weight in texts:
                if not text:
                    continue
                tl = text.lower()
                for alias in aliases:
                    al = alias.lower()
                    if al in tl:
                        score = base_weight * 0.6 * (
                            len(al) / max(len(tl), 1)
                        )
                        best = max(best, score)
            if best > 0.1:
                results.append((sem_type, best))
        return results

    def _context_hint(
        self, neighbors: List[str]
    ) -> Optional[Tuple[str, float]]:
        """If surrounding fields are address-related, infer address sub-fields."""
        addr_fields = {
            "address", "address_line1", "address_line2",
            "city", "state", "zip", "postal_code", "country",
        }
        addr_count = sum(1 for n in neighbors if n in addr_fields)
        if addr_count >= 2:
            return ("address_line1", 0.3)
        name_fields = {"first_name", "last_name", "middle_name", "full_name"}
        name_count = sum(1 for n in neighbors if n in name_fields)
        if name_count >= 2:
            return ("full_name", 0.3)
        return None


# ---------------------------------------------------------------------------
# FormAnalyzer
# ---------------------------------------------------------------------------

_ANALYZE_JS = r"""
(() => {
    const result = {
        form_type: "generic",
        total_fields: 0,
        pages: null,
        current_page: null,
        fields: [],
        submit_button: null,
        next_button: null,
        back_button: null,
    };

    // ---- Detect form type ----
    const hostname = (window.location.hostname || "").toLowerCase();
    const isGoogleForms = hostname.includes("docs.google.com") &&
        !!document.querySelector(".freebirdFormviewerView") ||
        !!document.querySelector("[data-params]") ||
        !!document.querySelector(".quantumWizTextinputPaperinputInput") ||
        !!document.querySelector(".appsMaterialWizToggleRadiogroupRadioButtonContainer");

    const hasMui = !!document.querySelector(".MuiInputBase-root, .MuiFormControl-root, .MuiTextField-root");
    const hasAnt = !!document.querySelector(".ant-input, .ant-select, .ant-form-item");
    const hasBs = !!document.querySelector(".form-control, .form-select, .form-floating");

    if (isGoogleForms) {
        result.form_type = "google_forms";
    } else if (hasMui) {
        result.form_type = "material_ui";
    } else if (hasAnt) {
        result.form_type = "ant_design";
    } else if (hasBs) {
        result.form_type = "bootstrap";
    } else if (document.querySelector("form")) {
        result.form_type = "standard_html";
    }

    let fieldIdCounter = 0;
    function uid() { return "field_" + (++fieldIdCounter); }

    function getLabel(el) {
        // aria-label
        const aLabel = el.getAttribute("aria-label");
        if (aLabel) return aLabel.trim();

        // Associated <label>
        const elId = el.id;
        if (elId) {
            const label = document.querySelector('label[for="' + CSS.escape(elId) + '"]');
            if (label) return label.textContent.trim();
        }

        // Wrapped in <label>
        const parentLabel = el.closest("label");
        if (parentLabel) {
            const clone = parentLabel.cloneNode(true);
            clone.querySelectorAll("input,textarea,select").forEach(c => c.remove());
            const t = clone.textContent.trim();
            if (t) return t;
        }

        // Previous sibling text
        const prev = el.previousElementSibling;
        if (prev && prev.tagName !== "INPUT" && prev.tagName !== "TEXTAREA" && prev.tagName !== "SELECT") {
            const t = prev.textContent.trim();
            if (t && t.length < 200) return t;
        }

        // Parent text (for wrappers)
        const parent = el.parentElement;
        if (parent) {
            const clone2 = parent.cloneNode(true);
            clone2.querySelectorAll("input,textarea,select,button").forEach(c => c.remove());
            const t2 = clone2.textContent.trim();
            if (t2 && t2.length < 200 && t2.length > 0) return t2;
        }

        // data-label attribute
        const dl = el.getAttribute("data-label");
        if (dl) return dl.trim();

        return "";
    }

    function getPlaceholder(el) {
        return (el.getAttribute("placeholder") || "").trim();
    }

    function isRequired(el) {
        return el.required ||
            el.getAttribute("aria-required") === "true" ||
            !!el.closest("[aria-required='true']") ||
            !!el.closest(".freebirdFormviewerViewItemsItemRequiredAsterisk") ||
            !!el.closest("[data-required='true']");
    }

    function getOptions(selectEl) {
        const opts = [];
        selectEl.querySelectorAll("option").forEach(o => {
            const v = o.value;
            const l = o.textContent.trim();
            if (v || l) opts.push({ value: v, label: l });
        });
        return opts;
    }

    function buildSelector(el) {
        if (el.id) return "#" + CSS.escape(el.id);
        if (el.getAttribute("name")) {
            const n = el.getAttribute("name");
            const parent = el.closest("form");
            if (parent) {
                return 'form [name="' + CSS.escape(n) + '"]';
            }
            return '[name="' + CSS.escape(n) + '"]';
        }
        // Build path
        const path = [];
        let cur = el;
        let depth = 0;
        while (cur && cur !== document.body && depth < 6) {
            let seg = cur.tagName.toLowerCase();
            if (cur.id) {
                seg += "#" + CSS.escape(cur.id);
                path.unshift(seg);
                break;
            }
            const parent2 = cur.parentElement;
            if (parent2) {
                const siblings = Array.from(parent2.children).filter(c => c.tagName === cur.tagName);
                if (siblings.length > 1) {
                    const idx = siblings.indexOf(cur) + 1;
                    seg += ":nth-of-type(" + idx + ")";
                }
            }
            path.unshift(seg);
            cur = cur.parentElement;
            depth++;
        }
        return path.join(" > ");
    }

    function getSection(el) {
        // Google Forms section header
        const header = el.closest('[role="listitem"]') ?
            el.closest('[role="listitem"]').previousElementSibling : null;
        if (header) {
            const heading = header.querySelector('[role="heading"]');
            if (heading) return heading.textContent.trim();
        }
        // fieldset legend
        const fieldset = el.closest("fieldset");
        if (fieldset) {
            const legend = fieldset.querySelector("legend");
            if (legend) return legend.textContent.trim();
        }
        // Section header via heading
        const section = el.closest("section, [role='group']");
        if (section) {
            const h = section.querySelector("h1,h2,h3,h4,h5,h6,[role='heading']");
            if (h) return h.textContent.trim();
        }
        return null;
    }

    // ---- Google Forms detection ----
    if (isGoogleForms) {
        const items = document.querySelectorAll(
            '.freebirdFormviewerViewItemsItemItem, ' +
            '[role="listitem"], ' +
            '.freebirdFormviewerViewItemsItem'
        );
        items.forEach(item => {
            const headingEl = item.querySelector('[role="heading"], .freebirdFormviewerViewItemsItemItemTitle');
            const sectionHeader = headingEl ? headingEl.textContent.trim() : null;
            const required = !!item.querySelector(
                '.freebirdFormviewerViewItemsItemRequiredAsterisk, [aria-required="true"]'
            );

            // Text input
            const textInput = item.querySelector(
                'input[type="text"], ' +
                '.quantumWizTextinputPaperinputInput, ' +
                'input.whsOnd'
            );
            if (textInput) {
                result.fields.push({
                    id: uid(),
                    type: "text",
                    semantic_type: "",
                    label: getLabel(textInput) || (headingEl ? headingEl.textContent.trim() : ""),
                    placeholder: getPlaceholder(textInput),
                    required: required,
                    options: [],
                    selector: buildSelector(textInput),
                    frame_index: null,
                    confidence: 0,
                    group: null,
                    section: sectionHeader,
                });
                return;
            }

            // Textarea
            const ta = item.querySelector(
                'textarea, .quantumWizTextinputPapertextareaInput'
            );
            if (ta) {
                result.fields.push({
                    id: uid(),
                    type: "textarea",
                    semantic_type: "",
                    label: getLabel(ta) || (headingEl ? headingEl.textContent.trim() : ""),
                    placeholder: getPlaceholder(ta),
                    required: required,
                    options: [],
                    selector: buildSelector(ta),
                    frame_index: null,
                    confidence: 0,
                    group: null,
                    section: sectionHeader,
                });
                return;
            }

            // Radio buttons (also handles linear scale)
            const radios = item.querySelectorAll(
                '[role="radio"], .appsMaterialWizToggleRadiogroupRadioButtonContainer, ' +
                'input[type="radio"]'
            );
            if (radios.length > 0) {
                const opts = [];
                radios.forEach(r => {
                    const lbl = r.getAttribute("aria-label") ||
                        r.getAttribute("data-value") ||
                        r.textContent.trim();
                    const val = r.getAttribute("data-value") ||
                        r.getAttribute("aria-label") ||
                        r.getAttribute("value") || lbl;
                    opts.push({ value: val, label: lbl.trim() });
                });

                // Detect linear scale: all values are numbers 1-N
                const allNumeric = opts.every(o => /^\d+$/.test(o.value.trim()));
                const fieldType = allNumeric && opts.length >= 3 ? "linear_scale" : "radio";

                const primarySelector = radios[0] ? buildSelector(radios[0]) : "";
                result.fields.push({
                    id: uid(),
                    type: fieldType,
                    semantic_type: "",
                    label: headingEl ? headingEl.textContent.trim() : getLabel(radios[0]),
                    placeholder: "",
                    required: required,
                    options: opts,
                    selector: primarySelector,
                    frame_index: null,
                    confidence: 0,
                    group: null,
                    section: sectionHeader,
                });
                return;
            }

            // Checkboxes
            const checkboxes = item.querySelectorAll(
                '[role="checkbox"], input[type="checkbox"]'
            );
            if (checkboxes.length > 0) {
                const opts = [];
                checkboxes.forEach(c => {
                    const lbl = c.getAttribute("aria-label") ||
                        c.getAttribute("data-value") ||
                        c.textContent.trim();
                    const val = c.getAttribute("data-value") ||
                        c.getAttribute("aria-label") ||
                        c.getAttribute("value") || lbl;
                    opts.push({ value: val, label: lbl.trim() });
                });
                result.fields.push({
                    id: uid(),
                    type: "checkbox",
                    semantic_type: "",
                    label: headingEl ? headingEl.textContent.trim() : getLabel(checkboxes[0]),
                    placeholder: "",
                    required: required,
                    options: opts,
                    selector: checkboxes[0] ? buildSelector(checkboxes[0]) : "",
                    frame_index: null,
                    confidence: 0,
                    group: null,
                    section: sectionHeader,
                });
                return;
            }

            // Dropdown / select
            const dropdown = item.querySelector(
                '[role="listbox"], .quantumWizMenuPaperselectOption, select'
            );
            if (dropdown) {
                const opts = [];
                dropdown.querySelectorAll(
                    '[role="option"], option, .quantumWizMenuPaperselectOption'
                ).forEach(o => {
                    const val = o.getAttribute("data-value") || o.getAttribute("value") || o.textContent.trim();
                    const lbl = o.textContent.trim();
                    if (lbl) opts.push({ value: val, label: lbl });
                });
                result.fields.push({
                    id: uid(),
                    type: "select",
                    semantic_type: "",
                    label: headingEl ? headingEl.textContent.trim() : getLabel(dropdown),
                    placeholder: "",
                    required: required,
                    options: opts,
                    selector: buildSelector(dropdown),
                    frame_index: null,
                    confidence: 0,
                    group: null,
                    section: sectionHeader,
                });
                return;
            }

            // Date picker (month/day/year inputs)
            const dateInputs = item.querySelectorAll('input[type="number"], input[data-datepicker]');
            if (dateInputs.length >= 2) {
                const isDate = Array.from(dateInputs).some(di => {
                    const lbl2 = (di.getAttribute("aria-label") || "").toLowerCase();
                    return lbl2.includes("month") || lbl2.includes("day") || lbl2.includes("year");
                });
                if (isDate) {
                    result.fields.push({
                        id: uid(),
                        type: "date",
                        semantic_type: "",
                        label: headingEl ? headingEl.textContent.trim() : "",
                        placeholder: "",
                        required: required,
                        options: [],
                        selector: buildSelector(dateInputs[0]),
                        frame_index: null,
                        confidence: 0,
                        group: null,
                        section: sectionHeader,
                    });
                    return;
                }
            }

            // File upload
            const fileInput = item.querySelector('input[type="file"]');
            if (fileInput) {
                result.fields.push({
                    id: uid(),
                    type: "file",
                    semantic_type: "",
                    label: headingEl ? headingEl.textContent.trim() : getLabel(fileInput),
                    placeholder: "",
                    required: required,
                    options: [],
                    selector: buildSelector(fileInput),
                    frame_index: null,
                    confidence: 0,
                    group: null,
                    section: sectionHeader,
                });
                return;
            }
        });

        // Buttons
        const buttons = document.querySelectorAll(
            'button, [role="button"], .freebirdFormviewerViewNavigationButtons'
        );
        buttons.forEach(btn => {
            const text = (btn.textContent || "").trim().toLowerCase();
            const sel = buildSelector(btn);
            if (text.includes("submit")) {
                result.submit_button = { selector: sel, label: btn.textContent.trim() };
            } else if (text.includes("next") || text.includes("continue") || text.includes("→") || text.includes("arrow_forward")) {
                result.next_button = { selector: sel, label: btn.textContent.trim() };
            } else if (text.includes("back") || text.includes("previous") || text.includes("←") || text.includes("arrow_back")) {
                result.back_button = { selector: sel, label: btn.textContent.trim() };
            }
        });

        // Detect multi-page
        if (result.next_button && !result.submit_button) {
            result.pages = null; // unknown
            result.current_page = 1;
        }

    } else {
        // ---- Standard / generic forms ----
        const allInputs = document.querySelectorAll(
            'input:not([type="hidden"]):not([type="submit"]):not([type="reset"]):not([type="button"]), ' +
            'textarea, select, ' +
            '.MuiInputBase-input, .ant-input, .form-control'
        );

        const seen = new Set();

        allInputs.forEach(el => {
            if (seen.has(el)) return;
            seen.add(el);

            const tag = el.tagName.toLowerCase();
            const type = (el.getAttribute("type") || "text").toLowerCase();
            const label = getLabel(el);
            const placeholder = getPlaceholder(el);
            const required = isRequired(el);
            const selector = buildSelector(el);
            const section = getSection(el);

            let fieldType = "text";
            let options = [];

            if (tag === "textarea") {
                fieldType = "textarea";
            } else if (tag === "select") {
                fieldType = "select";
                options = getOptions(el);
            } else if (type === "email") {
                fieldType = "email";
            } else if (type === "tel") {
                fieldType = "tel";
            } else if (type === "url") {
                fieldType = "url";
            } else if (type === "number") {
                fieldType = "number";
            } else if (type === "date") {
                fieldType = "date";
            } else if (type === "file") {
                fieldType = "file";
            } else if (type === "radio") {
                fieldType = "radio";
                // Gather all radios in same name group
                const name2 = el.getAttribute("name") || "";
                if (name2) {
                    const group = document.querySelectorAll('input[type="radio"][name="' + CSS.escape(name2) + '"]');
                    group.forEach(r => {
                        if (!seen.has(r)) seen.add(r);
                        const rl = r.closest("label");
                        const rlbl = rl ? rl.textContent.trim() : r.getAttribute("value") || "";
                        options.push({ value: r.getAttribute("value") || "", label: rlbl });
                    });
                }
            } else if (type === "checkbox") {
                fieldType = "checkbox";
                const name2 = el.getAttribute("name") || "";
                if (name2) {
                    const group = document.querySelectorAll('input[type="checkbox"][name="' + CSS.escape(name2) + '"]');
                    group.forEach(c => {
                        if (!seen.has(c)) seen.add(c);
                        const cl = c.closest("label");
                        const clbl = cl ? cl.textContent.trim() : c.getAttribute("value") || "";
                        options.push({ value: c.getAttribute("value") || "", label: clbl });
                    });
                }
            } else {
                fieldType = "text";
            }

            result.fields.push({
                id: uid(),
                type: fieldType,
                semantic_type: "",
                label: label,
                placeholder: placeholder,
                required: required,
                options: options,
                selector: selector,
                frame_index: null,
                confidence: 0,
                group: null,
                section: section,
            });
        });

        // Material UI radio/checkbox via role
        document.querySelectorAll('[role="radio"]').forEach(el => {
            if (seen.has(el)) return;
            seen.add(el);
            result.fields.push({
                id: uid(),
                type: "radio",
                semantic_type: "",
                label: el.getAttribute("aria-label") || el.textContent.trim(),
                placeholder: "",
                required: el.getAttribute("aria-required") === "true",
                options: [],
                selector: buildSelector(el),
                frame_index: null,
                confidence: 0,
                group: null,
                section: null,
            });
        });

        document.querySelectorAll('[role="checkbox"]').forEach(el => {
            if (seen.has(el)) return;
            seen.add(el);
            result.fields.push({
                id: uid(),
                type: "checkbox",
                semantic_type: "",
                label: el.getAttribute("aria-label") || el.textContent.trim(),
                placeholder: "",
                required: el.getAttribute("aria-required") === "true",
                options: [],
                selector: buildSelector(el),
                frame_index: null,
                confidence: 0,
                group: null,
                section: null,
            });
        });

        // Buttons
        document.querySelectorAll('button, input[type="submit"], [role="button"]').forEach(btn => {
            const text2 = (btn.textContent || btn.getAttribute("value") || "").trim().toLowerCase();
            if (!text2) return;
            const sel2 = buildSelector(btn);
            if (text2.includes("submit") || text2.includes("apply") || text2.includes("send")) {
                if (!result.submit_button) result.submit_button = { selector: sel2, label: btn.textContent.trim() || btn.getAttribute("value") };
            }
            if (text2.includes("next") || text2.includes("continue") || text2.includes("→")) {
                if (!result.next_button) result.next_button = { selector: sel2, label: btn.textContent.trim() };
            }
            if (text2.includes("back") || text2.includes("previous") || text2.includes("←")) {
                if (!result.back_button) result.back_button = { selector: sel2, label: btn.textContent.trim() };
            }
        });

        // Detect contenteditable fields
        document.querySelectorAll('[contenteditable="true"]').forEach(el => {
            if (seen.has(el)) return;
            seen.add(el);
            result.fields.push({
                id: uid(),
                type: "textarea",
                semantic_type: "",
                label: getLabel(el),
                placeholder: "",
                required: false,
                options: [],
                selector: buildSelector(el),
                frame_index: null,
                confidence: 0,
                group: null,
                section: null,
            });
        });
    }

    result.total_fields = result.fields.length;
    return result;
})();
"""


class FormAnalyzer:
    """Analyze a Playwright Page's form structure via JS injection.

    Usage::

        analyzer = FormAnalyzer()
        result = await analyzer.analyze(page)
    """

    def __init__(self, matcher: Optional[FieldMatcher] = None) -> None:
        self._matcher = matcher or FieldMatcher()

    async def analyze(self, page: Any) -> Dict[str, Any]:
        """Analyze the page and return a structured form description.

        Parameters
        ----------
        page:
            A Playwright ``Page`` (or Frame) that supports ``evaluate``.

        Returns
        -------
        dict
            The analysis result with ``fields``, ``form_type``, etc.
        """
        raw: Dict[str, Any] = await page.evaluate(_ANALYZE_JS)

        # Post-process: run each field through the matcher
        for f in raw.get("fields", []):
            sem_type, confidence = self._matcher.match(
                f.get("label", ""),
                placeholder=f.get("placeholder", ""),
                name_attr=f.get("name_attr", ""),
                aria_label=f.get("aria_label", ""),
                input_type=f.get("type", ""),
                id_attr=f.get("id_attr", ""),
            )
            f["semantic_type"] = sem_type
            f["confidence"] = round(confidence, 3)

        # Group related fields (address, name, birthday)
        raw = self._group_fields(raw)

        return raw

    # -- private helpers -----------------------------------------------------

    def _group_fields(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        """Assign ``group`` labels to related fields."""
        addr_types = {
            "address", "address_line1", "address_line2",
            "city", "state", "province", "zip", "postal_code", "country",
        }
        name_types = {"first_name", "last_name", "middle_name", "full_name"}
        bday_types = {"birthday", "birthday_month", "birthday_day", "birthday_year"}
        phone_types = {"phone", "phone_type", "phone_country"}
        edu_types = {"school", "university", "highest_degree", "graduation_date", "gpa"}
        exp_types = {"current_company", "current_title", "start_date", "end_date"}

        groups = {
            "address": addr_types,
            "name": name_types,
            "birthday": bday_types,
            "phone": phone_types,
            "education": edu_types,
            "experience": exp_types,
        }

        for f in raw.get("fields", []):
            sem = f.get("semantic_type", "")
            for group_name, types in groups.items():
                if sem in types:
                    f["group"] = group_name
                    break
        return raw


# ---------------------------------------------------------------------------
# FormFiller
# ---------------------------------------------------------------------------

class FormFiller:
    """Fill form fields on a Playwright Page using profile data.

    Usage::

        filler = FormFiller()
        result = await filler.fill(page, analysis, profile)
    """

    def __init__(self, matcher: Optional[FieldMatcher] = None) -> None:
        self._matcher = matcher or FieldMatcher()

    # -- public API ----------------------------------------------------------

    async def fill(
        self,
        page: Any,
        analysis: Dict[str, Any],
        profile: Dict[str, Any],
        *,
        skip_semantic_types: Optional[List[str]] = None,
        fill_unmatched: bool = False,
    ) -> Dict[str, Any]:
        """Fill all fillable fields on *page* described by *analysis*.

        Parameters
        ----------
        page:
            Playwright Page.
        analysis:
            The dict returned by :class:`FormAnalyzer`.
        profile:
            The dict returned by :class:`ResumeParser` (or a manually-built
            profile with the same keys).
        skip_semantic_types:
            Semantic types to skip (e.g. ``["salary", "gender"]``).
        fill_unmatched:
            If ``True``, attempt to fill fields even when the semantic type
            has no direct profile match (via fuzzy matching).

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
            "next_page_available": analysis.get("next_button") is not None,
            "form_complete": analysis.get("submit_button") is not None
                             and analysis.get("next_button") is None,
        }

        for field_info in analysis.get("fields", []):
            ftype = field_info.get("type", "")
            sem = field_info.get("semantic_type", "")
            selector = field_info.get("selector", "")
            fid = field_info.get("id", "")

            if not selector:
                result["skipped"] += 1
                result["details"].append({
                    "field_id": fid,
                    "action": "skipped",
                    "value_used": None,
                    "reason": "No selector available",
                })
                continue

            if sem in skip_types:
                result["skipped"] += 1
                result["details"].append({
                    "field_id": fid,
                    "action": "skipped",
                    "value_used": None,
                    "reason": f"Semantic type '{sem}' in skip list",
                })
                continue

            # Resolve value from profile
            value = self._resolve_value(sem, profile, field_info)

            if value is None and not fill_unmatched:
                result["skipped"] += 1
                result["details"].append({
                    "field_id": fid,
                    "action": "skipped",
                    "value_used": None,
                    "reason": f"No profile match for '{sem}'",
                })
                continue

            # Fill the field
            try:
                await self._fill_field(page, field_info, value, profile)
                result["filled"] += 1
                result["details"].append({
                    "field_id": fid,
                    "action": "filled",
                    "value_used": str(value)[:200] if value else None,
                    "reason": "OK",
                })
            except Exception as exc:
                logger.warning("Error filling field %s: %s", fid, exc)
                result["errors"] += 1
                result["details"].append({
                    "field_id": fid,
                    "action": "error",
                    "value_used": str(value)[:200] if value else None,
                    "reason": str(exc),
                })

        return result

    async def fill_and_advance(
        self,
        page: Any,
        analysis: Dict[str, Any],
        profile: Dict[str, Any],
        **kwargs: Any,
    ) -> Dict[str, Any]:
        """Fill the current page, then click "Next" if available.

        Returns the fill result (does *not* re-analyze the next page).
        """
        fill_result = await self.fill(page, analysis, profile, **kwargs)
        next_btn = analysis.get("next_button")
        if next_btn and next_btn.get("selector"):
            try:
                await page.click(next_btn["selector"])
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
        """Look up a value from *profile* for the given *semantic_type*.

        Returns ``None`` if nothing matches.
        """
        # Direct key match
        direct = profile.get(semantic_type)
        if direct:
            if isinstance(direct, list) and semantic_type in (
                "skills", "languages", "certifications", "education", "experience",
            ):
                return direct  # Caller decides how to render
            if isinstance(direct, str) and direct.strip():
                return self._normalize_value(direct, semantic_type)
            if isinstance(direct, (int, float, bool)):
                return direct

        # Fallback mappings for common profile keys
        fallback_map: Dict[str, List[str]] = {
            "full_name": ["full_name", "name"],
            "first_name": ["first_name"],
            "last_name": ["last_name"],
            "phone": ["phone"],
            "email": ["email"],
            "address_line1": ["address"],
            "city": ["city"],
            "state": ["state", "province"],
            "zip": ["zip", "postal_code"],
            "postal_code": ["postal_code", "zip"],
            "country": ["country"],
            "linkedin": ["linkedin"],
            "github": ["github"],
            "website": ["website", "portfolio"],
            "portfolio": ["portfolio", "website"],
            "current_title": ["current_title"],
            "current_company": ["current_company"],
            "school": ["school"],
            "highest_degree": ["highest_degree"],
            "salary": ["salary"],
            "salary_requirements": ["salary", "salary_requirements"],
            "start_date_availability": ["start_date_availability"],
            "referred_by": ["referred_by"],
            "referral_source": ["referral_source"],
        }

        for key in fallback_map.get(semantic_type, []):
            val = profile.get(key)
            if val:
                if isinstance(val, str) and val.strip():
                    return self._normalize_value(val, semantic_type)
                if isinstance(val, (int, float, bool)):
                    return val

        # Special handling for select/radio/checkbox: match options
        if field_info.get("options"):
            return self._match_option(semantic_type, profile, field_info)

        # Derive from structured data (education, experience)
        derived = self._derive_value(semantic_type, profile)
        if derived is not None:
            return derived

        return None

    def _match_option(
        self,
        semantic_type: str,
        profile: Dict[str, Any],
        field_info: Dict[str, Any],
    ) -> Optional[str]:
        """Try to find a matching option value for select/radio/checkbox."""
        options = field_info.get("options", [])
        if not options:
            return None

        value = self._resolve_value(semantic_type, profile, {"options": []})
        if not value or not isinstance(value, str):
            # Try deriving from structured data
            value = self._derive_value(semantic_type, profile)
        if not value or not isinstance(value, str):
            return None

        value_lower = value.lower().strip()

        # Exact match on value or label
        for opt in options:
            if opt["value"].lower() == value_lower or opt["label"].lower() == value_lower:
                return opt["value"]

        # Substring match
        for opt in options:
            if value_lower in opt["label"].lower() or value_lower in opt["value"].lower():
                return opt["value"]
            if opt["label"].lower() in value_lower or opt["value"].lower() in value_lower:
                return opt["value"]

        # Boolean / yes_no
        if semantic_type in ("yes_no", "work_authorization", "sponsorship_required",
                             "veteran", "disability"):
            bool_val = profile.get(semantic_type)
            if isinstance(bool_val, bool):
                target = "yes" if bool_val else "no"
                for opt in options:
                    if opt["value"].lower() == target or opt["label"].lower() == target:
                        return opt["value"]

        return None

    # -- value normalization -------------------------------------------------

    def _derive_value(
        self,
        semantic_type: str,
        profile: Dict[str, Any],
    ) -> Optional[Any]:
        """Derive values from structured profile data (education, experience lists)."""
        # Derive highest_degree from education entries
        if semantic_type == "highest_degree" and profile.get("education"):
            degree_priority = [
                "phd", "doctorate", "md", "jd",
                "mba", "master", "m.s", "m.a", "m.sc", "m.eng", "m.e",
                "bachelor", "b.s", "b.a", "b.sc", "b.eng", "b.e", "b.tech",
                "associate", "diploma",
            ]
            best_degree = ""
            best_priority = len(degree_priority)  # lower is better
            for edu in profile["education"]:
                deg = edu.get("degree", "").lower()
                for i, d in enumerate(degree_priority):
                    if d in deg and i < best_priority:
                        best_priority = i
                        best_degree = edu.get("degree", "")
            if best_degree:
                return best_degree

        # Derive school/university from education entries
        if semantic_type in ("school", "university") and profile.get("education"):
            for edu in profile["education"]:
                inst = edu.get("institution", "")
                if inst:
                    return inst

        # Derive graduation_date from education entries
        if semantic_type == "graduation_date" and profile.get("education"):
            for edu in profile["education"]:
                yr = edu.get("year", "")
                if yr:
                    return yr

        # Derive current_title/current_company from experience entries
        if semantic_type in ("current_title", "current_company") and profile.get("experience"):
            for exp in profile["experience"]:
                end = exp.get("end", "").lower()
                if "present" in end or "current" in end or "now" in end or end == "":
                    if semantic_type == "current_title" and exp.get("title"):
                        return exp["title"]
                    if semantic_type == "current_company" and exp.get("company"):
                        return exp["company"]

        # Derive skills as comma-separated string
        if semantic_type == "skills" and profile.get("skills"):
            return ", ".join(profile["skills"])

        # Derive languages as comma-separated string
        if semantic_type == "languages" and profile.get("languages"):
            return ", ".join(profile["languages"])

        # Derive experience summary
        if semantic_type == "experience" and profile.get("experience"):
            parts = []
            for exp in profile["experience"]:
                line = f"{exp.get('title', '')} at {exp.get('company', '')}"
                if line.strip() != " at ":
                    parts.append(line.strip())
            return "\n".join(parts) if parts else None

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
        if semantic_type in ("birthday", "start_date", "end_date",
                             "start_date_availability", "graduation_date"):
            return value.strip()  # Let the form's format prevail
        if semantic_type in ("zip", "postal_code"):
            return re.sub(r"[^0-9\-]", "", value)
        if semantic_type in ("salary", "salary_requirements"):
            digits = re.sub(r"[^0-9]", "", value)
            return digits if digits else value
        return value.strip()

    # -- field-level fill operations -----------------------------------------

    async def _fill_field(
        self,
        page: Any,
        field_info: Dict[str, Any],
        value: Any,
        profile: Dict[str, Any],
    ) -> None:
        """Dispatch to the appropriate fill method based on field type."""
        ftype = field_info["type"]
        selector = field_info["selector"]
        form_type = field_info.get("form_type", "")

        if ftype in ("text", "email", "tel", "url", "number"):
            await self._fill_text(page, selector, str(value), form_type)
        elif ftype == "textarea":
            await self._fill_textarea(page, selector, str(value), form_type)
        elif ftype == "select":
            await self._fill_select(page, field_info, str(value))
        elif ftype == "radio":
            await self._fill_radio(page, field_info, str(value))
        elif ftype == "checkbox":
            await self._fill_checkbox(page, field_info, value)
        elif ftype == "date":
            await self._fill_date(page, field_info, str(value))
        elif ftype == "file":
            await self._fill_file(page, selector, str(value))
        elif ftype == "linear_scale":
            await self._fill_linear_scale(page, field_info, str(value))
        else:
            await self._fill_text(page, selector, str(value), form_type)

    async def _fill_text(
        self, page: Any, selector: str, value: str, form_type: str
    ) -> None:
        """Fill a text-type input."""
        try:
            await page.click(selector, timeout=3000)
        except Exception:
            pass
        # Clear existing value
        try:
            await page.fill(selector, "", timeout=2000)
        except Exception:
            pass
        await page.fill(selector, value, timeout=5000)

        # For Google Forms Material inputs, also dispatch input events
        if form_type == "google_forms":
            try:
                await page.evaluate(
                    """([sel, val]) => {
                        const el = document.querySelector(sel);
                        if (el) {
                            el.focus();
                            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                                window.HTMLInputElement.prototype, 'value'
                            ).set;
                            nativeInputValueSetter.call(el, val);
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    }""",
                    [selector, value],
                )
            except Exception:
                pass

    async def _fill_textarea(
        self, page: Any, selector: str, value: str, form_type: str
    ) -> None:
        """Fill a textarea or contenteditable."""
        # Check if contenteditable
        is_editable = await page.evaluate(
            """(sel) => {
                const el = document.querySelector(sel);
                return el ? el.isContentEditable : false;
            }""",
            selector,
        )
        if is_editable:
            await page.click(selector, timeout=3000)
            await page.keyboard.type(value, delay=10)
        else:
            try:
                await page.fill(selector, value, timeout=5000)
            except Exception:
                await page.click(selector, timeout=3000)
                await page.keyboard.type(value, delay=10)

    async def _fill_select(
        self, page: Any, field_info: Dict[str, Any], value: str
    ) -> None:
        """Select an option from a dropdown."""
        selector = field_info["selector"]
        options = field_info.get("options", [])

        # Find matching option
        match_val = None
        value_lower = value.lower().strip()
        for opt in options:
            if opt["value"].lower() == value_lower or opt["label"].lower() == value_lower:
                match_val = opt["value"]
                break
        if not match_val:
            # Substring
            for opt in options:
                if value_lower in opt["label"].lower():
                    match_val = opt["value"]
                    break
        if not match_val and options:
            match_val = value  # Try raw value

        try:
            await page.select_option(selector, match_val, timeout=5000)
        except Exception:
            # Custom dropdown (Google Forms style): click to open, then click option
            try:
                await page.click(selector, timeout=3000)
                await page.wait_for_timeout(500)
                # Look for the option in the opened dropdown
                option_selectors = [
                    f'[role="option"]:has-text("{value}")',
                    f'.quantumWizMenuPaperselectOption:has-text("{value}")',
                    f'li:has-text("{value}")',
                ]
                for osel in option_selectors:
                    try:
                        await page.click(osel, timeout=2000)
                        return
                    except Exception:
                        continue
            except Exception:
                raise

    async def _fill_radio(
        self, page: Any, field_info: Dict[str, Any], value: str
    ) -> None:
        """Click the matching radio button."""
        options = field_info.get("options", [])
        value_lower = value.lower().strip()

        # Find the option whose label or value matches
        target_label = value
        for opt in options:
            if opt["value"].lower() == value_lower or opt["label"].lower() == value_lower:
                target_label = opt["label"]
                break

        # Try clicking by label text
        radio_selectors = [
            f'[role="radio"][aria-label="{target_label}"]',
            f'input[type="radio"][value="{value}"]',
            f'label:has-text("{target_label}") input[type="radio"]',
            f'label:has-text("{target_label}")',
        ]

        for sel in radio_selectors:
            try:
                await page.click(sel, timeout=2000)
                return
            except Exception:
                continue

        # Fallback: click within the field's container
        selector = field_info["selector"]
        container = await page.evaluate(
            """(sel) => {
                const el = document.querySelector(sel);
                return el ? el.closest('[role="listitem"], .freebirdFormviewerViewItemsItem, fieldset, [role="group"]') : null;
            }""",
            selector,
        )
        if container:
            try:
                await page.click(
                    f'{selector} ::-p-text("{target_label}")',
                    timeout=2000,
                )
            except Exception:
                # Last resort: click the first radio
                try:
                    await page.click(selector, timeout=2000)
                except Exception:
                    raise

    async def _fill_checkbox(
        self, page: Any, field_info: Dict[str, Any], value: Any
    ) -> None:
        """Check/uncheck checkboxes to match desired value."""
        if isinstance(value, str):
            # Could be comma-separated list
            desired = [v.strip().lower() for v in value.split(",")]
        elif isinstance(value, list):
            desired = [str(v).strip().lower() for v in value]
        elif isinstance(value, bool):
            desired = ["yes"] if value else ["no"]
        else:
            desired = [str(value).lower()]

        options = field_info.get("options", [])
        selector = field_info["selector"]

        for opt in options:
            should_check = (
                opt["value"].lower() in desired
                or opt["label"].lower() in desired
                or any(d in opt["label"].lower() for d in desired)
            )

            if not should_check:
                continue

            # Find the checkbox element
            cb_selectors = [
                f'[role="checkbox"][aria-label="{opt["label"]}"]',
                f'input[type="checkbox"][value="{opt["value"]}"]',
                f'label:has-text("{opt["label"]}") input[type="checkbox"]',
            ]

            for sel in cb_selectors:
                try:
                    checked = await page.evaluate(
                        """(s) => {
                            const el = document.querySelector(s);
                            if (!el) return null;
                            if (el.getAttribute('role') === 'checkbox') {
                                return el.getAttribute('aria-checked') === 'true';
                            }
                            return el.checked;
                        }""",
                        sel,
                    )
                    if checked is not None and checked != should_check:
                        await page.click(sel, timeout=2000)
                    elif checked is None:
                        await page.click(sel, timeout=2000)
                    break
                except Exception:
                    continue

    async def _fill_date(
        self, page: Any, field_info: Dict[str, Any], value: str
    ) -> None:
        """Fill date fields (may be single input or month/day/year sub-fields)."""
        selector = field_info["selector"]

        # Try single date input
        try:
            await page.fill(selector, value, timeout=2000)
            return
        except Exception:
            pass

        # Try sub-fields (month, day, year)
        from datetime import datetime as _dt
        parsed = None
        for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%d/%m/%Y", "%B %d, %Y", "%m/%Y"):
            try:
                parsed = _dt.strptime(value.strip(), fmt)
                break
            except ValueError:
                continue

        if parsed:
            month = str(parsed.month)
            day = str(parsed.day)
            year = str(parsed.year)

            # Try to find sub-fields near the main selector
            await page.evaluate(
                """([sel, m, d, y]) => {
                    const el = document.querySelector(sel);
                    if (!el) return;
                    const container = el.closest('[role="listitem"], fieldset, [role="group"], .freebirdFormviewerViewItemsItem, form, .MuiFormControl-root');
                    if (!container) return;
                    const inputs = container.querySelectorAll('input');
                    inputs.forEach(inp => {
                        const lbl = (inp.getAttribute('aria-label') || inp.placeholder || '').toLowerCase();
                        if (lbl.includes('month')) { inp.value = m; inp.dispatchEvent(new Event('input', {bubbles:true})); }
                        else if (lbl.includes('day')) { inp.value = d; inp.dispatchEvent(new Event('input', {bubbles:true})); }
                        else if (lbl.includes('year')) { inp.value = y; inp.dispatchEvent(new Event('input', {bubbles:true})); }
                    });
                }""",
                [selector, month, day, year],
            )

    async def _fill_file(
        self, page: Any, selector: str, file_path: str
    ) -> None:
        """Upload a file."""
        await page.set_input_files(selector, file_path, timeout=10000)

    async def _fill_linear_scale(
        self, page: Any, field_info: Dict[str, Any], value: str
    ) -> None:
        """Fill a linear scale (e.g., 1-5, 1-10)."""
        options = field_info.get("options", [])
        # Find the option matching the value
        target = value.strip()
        for opt in options:
            if opt["value"] == target or opt["label"] == target:
                sel = f'[role="radio"][aria-label="{opt["label"]}"]'
                try:
                    await page.click(sel, timeout=2000)
                    return
                except Exception:
                    continue

        # Fallback: click the selector and use keyboard
        try:
            await page.click(field_info["selector"], timeout=2000)
            await page.keyboard.press(target)
        except Exception:
            raise


# ---------------------------------------------------------------------------
# Convenience: full pipeline
# ---------------------------------------------------------------------------

async def analyze_and_fill(
    page: Any,
    profile: Dict[str, Any],
    *,
    skip_types: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """One-shot convenience: analyze the page then fill it.

    Returns the fill result dict.
    """
    analyzer = FormAnalyzer()
    filler = FormFiller()

    analysis = await analyzer.analyze(page)
    return await filler.fill(page, analysis, profile, skip_semantic_types=skip_types)
