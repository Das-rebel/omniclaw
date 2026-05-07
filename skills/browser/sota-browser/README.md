# SOTA Browser MCP Server

A comprehensive browser automation MCP server combining the best features from:
- **browser-harness**: Self-healing CDP-based browser control
- **camofox-browser**: Anti-detection with fingerprint spoofing
- **Scrapling**: Adaptive web scraping with element relocalization

## Features

### Browser Control
- CDP-based browser automation via Playwright
- Isolated browser sessions per user
- Stable element refs (e1, e2, e3...) for reliable interaction
- Accessibility tree snapshots (~90% smaller than raw HTML)

### Anti-Detection
- Removes `webdriver` automation indicators
- Spoofs hardware concurrency and device memory
- Randomizes canvas fingerprints
- WebGL renderer spoofing
- Configurable user agent and locale

### Scraping Integration
- Scrapling adapter for adaptive parsing
- Handles JavaScript-heavy sites
- Network idle detection
- Proxy support

## Installation

```bash
cd ~/mcp-browser
./install.sh
```

## Usage

### Mode 1: MCP Stdio (for PI)

```bash
source venv/bin/activate
python3 mcp_server.py
```

Configure in PI's MCP settings:
```json
{
  "mcpServers": {
    "sota-browser": {
      "command": "python3",
      "args": ["/Users/Subho/mcp-browser/mcp_server.py"]
    }
  }
}
```

### Mode 2: HTTP Server (for cloud/remote)

```bash
source venv/bin/activate
python3 -m uvicorn src.server:app --host 0.0.0.0 --port 9377
```

## Available Tools

### Core Browser Tools (27)

| Tool | Description |
|------|-------------|
| `browser_create_session` | Create isolated browser session |
| `browser_create_tab` | Create new tab in session |
| `browser_navigate` | Navigate to URL |
| `browser_snapshot` | Get accessibility tree with element refs |
| `browser_click` | Click by selector/ref/coordinates |
| `browser_type` | Type text into element |
| `browser_scroll` | Scroll page |
| `browser_screenshot` | Take screenshot |
| `browser_evaluate` | Execute JavaScript (supports frame_index) |
| `browser_list_frames` | List all frames/IFrames |
| `browser_evaluate_in_frame` | Execute JS in specific frame |
| `browser_get_console_logs` | Capture console messages |
| `browser_get_frame_content` | Get HTML from specific frame |
| `browser_inject_all_frames` | Run JS in ALL frames |
| `browser_press_key` | Press key (Enter, Tab, etc.) |
| `browser_wait` | Explicit wait |
| `browser_extract_images` | Extract images from page |
| `browser_list_tabs` | List open tabs |
| `browser_close_tab` | Close tab |
| `browser_http_get` | Direct HTTP GET (no browser) |
| `browser_import_cookies` | Import cookies for auth |
| `browser_info` | Get browser info |
| `browser_close_session` | Close session and all tabs |
| `browser_get_state` | Get indexed clickable elements |
| `browser_get_html` | Get raw HTML of page/element |
| `browser_go_back` | Navigate back in history |
| `browser_switch_tab` | Switch to tab by index |

### Form Engine Tools (6)

| Tool | Description |
|------|-------------|
| `browser_parse_resume` | Parse plain-text resume into structured profile (name, email, phone, education, experience, skills, etc.) |
| `browser_analyze_form` | Analyze page form structure — detects Google Forms, standard HTML, Material UI, Ant Design, Bootstrap. Returns field types, labels, options, required status, navigation buttons |
| `browser_fill_form` | Fill form fields using structured profile data. Auto-analyzes form, matches fields to profile keys, fills text/select/radio/checkbox/date/file fields |
| `browser_fill_form_from_resume` | One-shot: parse resume text + fill form. Pass raw resume, it extracts profile and auto-fills all matching fields |
| `browser_fill_form_page` | Fill current page of multi-page form and click Next (for Google Forms multi-section) |
| `browser_submit_form` | Auto-detect and click the Submit button |

### Supported Form Types

- **Google Forms** — Material Design widgets, radio groups, checkboxes, dropdowns, linear scales, date pickers, multi-page sections
- **Standard HTML forms** — `<input>`, `<textarea>`, `<select>`, radio/checkbox groups
- **Material UI (MUI)** — `.MuiInputBase-root`, `.MuiSelect-root`, `.MuiFormControl-root`
- **Ant Design** — `.ant-input`, `.ant-select`, `.ant-form-item`
- **Bootstrap** — `.form-control`, `.form-select`, `.form-floating`
- **Generic SPA** — Label proximity heuristics, `role` attributes, `aria-label`, `contenteditable`

### Profile Fields Recognized (50+ semantic types)

**Personal:** first_name, last_name, full_name, middle_name, preferred_name, email, email_confirm, phone, phone_type
**Location:** address, city, state, zip, postal_code, country
**Web:** linkedin, github, portfolio, website, twitter
**Education:** school, university, highest_degree, graduation_date, gpa
**Experience:** current_company, current_title, start_date, end_date
**Skills:** skills, languages, certifications
**EEO:** gender, pronouns, veteran, disability, ethnicity, hispanic
**Work Auth:** work_authorization, visa_status, sponsorship_required
**Other:** salary, referral_source, referred_by, birthday, cover_letter, resume (file upload)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_BROWSER_HOST` | `http://localhost:9377` | HTTP server URL |
| `MCP_BROWSER_API_KEY` | (none) | API key for auth |
| `MCP_BROWSER_PORT` | `9377` | Server port |
| `BH_DEBUG_CLICKS` | `false` | Show click overlays |
| `CAMOFOX_API_KEY` | (none) | Alternative API key name |

## API Endpoints (HTTP mode)

### Sessions
- `POST /sessions` - Create session
- `GET /sessions` - List sessions
- `GET /sessions/{id}` - Get session
- `DELETE /sessions/{id}` - Delete session

### Tabs
- `POST /sessions/{id}/tabs` - Create tab
- `GET /sessions/{id}/tabs` - List tabs
- `POST /sessions/{id}/tabs/{tab}/navigate` - Navigate
- `GET /sessions/{id}/tabs/{tab}/snapshot` - Get snapshot
- `POST /sessions/{id}/tabs/{tab}/click` - Click
- `POST /sessions/{id}/tabs/{tab}/type` - Type
- `POST /sessions/{id}/tabs/{tab}/scroll` - Scroll
- `GET /sessions/{id}/tabs/{tab}/screenshot` - Screenshot
- `DELETE /sessions/{id}/tabs/{tab}` - Close tab

### Scraping
- `POST /fetch` - Fetch URL
- `POST /extract` - Extract structured data

## Example Workflow

```python
from mcp_client import BrowserMCPClient

async def demo():
    client = BrowserMCPClient()
    
    # Create session
    session = await client.create_session(user_id="test")
    
    # Create tab and navigate
    tab = await client.create_tab(session_id=session["id"])
    await client.navigate(session_id=session["id"], tab_id=tab["id"], url="https://example.com")
    
    # Get page snapshot
    snapshot = await client.snapshot(session_id=session["id"], tab_id=tab["id"])
    print(f"Found {len(snapshot['elements'])} elements")
    
    # Click e5 (5th interactive element)
    await client.click(session_id=session["id"], tab_id=tab["id"], ref="e5")
    
    # Type into search field
    await client.type_text(session_id=session["id"], tab_id=tab["id"], 
                          text="search query", ref="e3")
    
    # Clean up
    await client.close_session(session["id"])
```

## Local vs Cloud

### Local Usage (PI)
- Run `mcp_server.py` as stdio process
- PI spawns the server and communicates via JSON-RPC

### Cloud Usage (Remote API)
- Deploy HTTP server on cloud infrastructure
- Use REST API with Bearer token auth
- Supports horizontal scaling with session affinity

## Security

- API key authentication via `X-API-Key` header
- Cookie import restricted to logged-in sessions
- Proxy support for IP rotation
- Session isolation between users

## License

MIT