# SOTA Browser MCP Server - Changelog

## v2.0.0 (2026-05-09) - Form Engine v2: CSS Selector Matching + React Select

### Breaking: Architecture Rewrite

Complete rewrite based on research of Simplify Copilot, Auto-Apply-Helper (130KB),
and greenhouse-autofill-chrome-extension. Key changes:

**No LLM required** — pure rule-based matching and filling.

**New Architecture:**
- `FIELD_SELECTORS`: 45 semantic types × 179 CSS selectors tried in priority order
- `LABEL_MAPPINGS`: 28 semantic types with text-based label matching
- React Select handler: Full `pointerdown→mousedown→pointerup→mouseup→click` sequence
- Portal-aware: Finds React-Select menus portaled to `<body>`
- Proper event dispatching: `input` + `change` events for React/Vue/Angular
- Skips already-filled fields, EEO/DEI, CAPTCHA fields

**Classes:**
- `ResumeParser` — Unchanged from v1
- `FormScanner` (replaces `FormAnalyzer`) — CSS selector + label scanning
- `FormFiller` — Rewritten with React Select support
- `FieldMatcher` merged into `FormScanner._classify_field()`

**Tested against:**
- Real Greenhouse job application (Razorpay — 29 fields, React Select dropdowns)
- Google Forms (Material Design)
- Standard HTML forms

**Net result:** -900 lines (2,398 → 1,128 net new), better reliability on React forms

## v1.2.0 (2026-05-07) - Form Engine: Auto-Fill Any Form

### New: Form Engine (6 new tools, 2,278 lines)

A comprehensive form-filling engine that surpasses Simplify Copilot by using
LLM-grade field matching instead of brittle per-ATS XPath selectors.

**New tools:**
- `browser_parse_resume` — Parse plain-text resume into structured profile (50+ fields)
- `browser_analyze_form` — Detect & analyze form structure (Google Forms, HTML, MUI, Ant, Bootstrap)
- `browser_fill_form` — Auto-fill form from profile data
- `browser_fill_form_from_resume` — One-shot: parse resume + fill form
- `browser_fill_form_page` — Fill multi-page form page + click Next
- `browser_submit_form` — Auto-detect and click Submit button

**Architecture:**
- `ResumeParser` — Extracts name, email, phone, address, LinkedIn, GitHub, education, experience, skills, languages, certifications from plain text
- `FieldMatcher` — 200+ aliases across 50+ semantic types, 5 matching strategies (exact alias, aria-label/placeholder, fuzzy keyword, context-aware, input-type heuristics)
- `FormAnalyzer` — JS injection that detects Google Forms Material widgets, standard HTML, MUI, Ant Design, Bootstrap; returns structured field list with types, options, required status, navigation buttons
- `FormFiller` — Smart filling for text/email/tel/textarea/select/radio/checkbox/date/file/linear-scale with Google Forms Material Design support

**vs Simplify Copilot:**
- ✅ Works on ANY form (not limited to 49 pre-mapped ATS platforms)
- ✅ No brittle per-site XPath selectors to maintain
- ✅ Semantic field matching (understands "What is your current employer?" → current_company)
- ✅ Google Forms Material Design support
- ✅ Multi-page form navigation

## v1.1.0 (2026-04-30) - Integrated into omniclaw-personal-assistant

### Performance Improvements
- Reduced default viewport from 1920x1080 to 1280x720 for faster rendering
- Reduced default timeouts from 30s to 10s
- Optimized DOM tree parsing script (max 200 elements vs 500)
- Reduced HTTP response content truncation from 50KB to 30KB
- Simplified stealth script to single-line injection

### Chrome CDP Support
Added ability to connect to existing Chrome browser via CDP (Chrome DevTools Protocol):
- Set `CHROME_CDP_URL` environment variable with Chrome's WebSocket URL
- Example: `ws://localhost:60807/devtools/browser/xxx`
- Auto-detects and connects to existing Chrome if URL is set
- Falls back to local browser if CDP fails

### Bug Fixes
- Fixed timeout handling in request tracking
- Fixed promise resolution that was clearing timer before it could trigger
- Added proper cleanup of pending requests when server closes
- Improved error messages for better debugging

### Helper Script
Added `use-chrome-cdp.sh` for easy Chrome CDP mode:
```bash
cd ~/omniclaw-personal-assistant/sota-browser
./use-chrome-cdp.sh -p "your prompt"
```

### Integration with omniclaw
This module is part of omniclaw-personal-assistant and provides:
- 18 browser automation tools via MCP protocol
- Local headless Chromium support
- Chrome CDP mode for reusing existing Chrome sessions
- Session and tab management

## v1.0.0 (Earlier)
- Initial release with 18 browser automation tools
- Local headless Chromium support
- Session and tab management
