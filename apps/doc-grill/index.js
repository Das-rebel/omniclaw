/**
 * Doc-Grill — OmniClaw document Grill-Me feature
 *
 * Flow:
 *  1. User submits document URL (Google Docs / PDF / MD)
 *  2. We fetch + parse the document content
 *  3. Run a 3-question Grill-Me conversation → generate HTML prototype
 *  4. Render in iframe for preview + export
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const MultiLLMClient = require('./multillm-client');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const llm = new MultiLLMClient();

// ── Grill-Me System Prompt ───────────────────────────────────────────────────
const GRILL_SYSTEM = `You are a huashu-design practitioner. Your job: interrogate a document's intent, then deliver a production-quality HTML prototype using huashu-design principles.

## huashu-design principles

### HTML is a design medium, not a document format
Output is an **interactive app prototype**, not documentation.

### Archetypes
- **App Prototype**: Tab-based UI with sidebar nav, stateful interactions (clicks toggle views, forms submit)
- **Landing/Marketing**: Hero with CTA, feature sections, scroll-triggered animations, newsletter form
- **Dashboard/Analytics**: Data tables, metric cards, SVG chart placeholders, filter controls, date pickers
- **Documentation/Site**: Navigation sidebar, content sections, code blocks with copy button

### Anti-slop (violate any = reject)
- NO purple gradients, no emoji icons, no rounded cards with left border accent
- NO lorem ipsum
- NO Font Awesome, no Tailwind CDN, no Bootstrap CDN, no Heroicons CDN
- NO static-only layouts

### CRITICAL: JavaScript is MANDATORY in every output
Every prototype MUST include a <script> tag with working JavaScript. This is not optional.

Required JavaScript:
1. Tab switching: onclick handlers that toggle 'active' class on tab buttons AND corresponding tab-content divs. Tab A click -> Tab A content shows, Tab B loses active class.
2. Nav active state: clicked nav items get classList.add('active') and siblings get classList.remove('active')
3. One working control: form submit that shows confirmation, toggle that changes state, button that triggers alert or DOM change, collapsible content that expands/collapses

If you do not include JavaScript with real handlers, the prototype is INCOMPLETE.

### Visual precision
- CSS Grid layout (not tables or floats)
- Realistic content: Dr. Sarah Chen, $4,230, 89% conversion, Mar 15 2024
- CSS variables for all colors, font sizes, spacing

### Output format
- Single HTML file, all CSS and inline JS
- Google Fonts CDN okay (Inter, DM Sans, etc.)
- Start with: <!-- Doc-Grill Generated Prototype -->
- MUST include <script> tag with real working JS
- Wrap HTML in triple-backtick html code block

### Questions
- Q1: What is PRIMARY USE CASE and target user?
- Q2: [A]/[B] concrete design approaches — specific about layout and mood
- Q3: What specific features must be included? (list 3-5 specific things)

### After 3 answers -> generate prototype immediately

Example [A]/[B] question:
[A] Dark analytics dashboard — monospace numbers, dense data grid, neon accent on status
[B] Clean SaaS dashboard — Inter font, card-based metrics, subtle shadows, blue primary
Which better fits your primary user's work context?`;// ── Document fetchers


// ── Document fetchers ───────────────────────────────────────────────────────

async function fetchGoogleDoc(url) {
  const match = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) throw new Error('Not a valid Google Docs URL');
  const docId = match[1];
  const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
  const resp = await fetch(exportUrl, {
    headers: { 'User-Agent': 'OmniClaw-DocGrill/1.0' }
  });
  if (!resp.ok) throw new Error(`Google Docs fetch failed: ${resp.status}`);
  return resp.text();
}

async function fetchGitHubMd(url) {
  const rawUrl = url
    .replace('github.com', 'raw.githubusercontent.com')
    .replace('/blob/', '/');
  const resp = await fetch(rawUrl, {
    headers: { 'User-Agent': 'OmniClaw-DocGrill/1.0' }
  });
  if (!resp.ok) throw new Error(`GitHub MD fetch failed: ${resp.status}`);
  return resp.text();
}

async function fetchUrlText(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'OmniClaw-DocGrill/1.0' }
  });
  if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
  return resp.text();
}

// ── Session store (in-memory) ────────────────────────────────────────────────

const sessions = new Map();

function createSession({ docContent, docType, docUrl }) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const session = {
    id,
    docContent: docContent.slice(0, 6000),
    docType,
    docUrl,
    questions: [],
    answers: [],
    phase: 'answering',
    htmlOutput: null,
    createdAt: new Date()
  };
  sessions.set(id, session);
  return session;
}

// ── Build Grill prompt ───────────────────────────────────────────────────────

function buildGrillPrompt(session, nextQuestionOnly = false) {
  const history = session.questions.map((q, i) =>
    `Q${i + 1}: ${q}\nA${i + 1}: ${session.answers[i]}`).join('\n\n');

  let prompt = `DOCUMENT (${session.docType})\nSource: ${session.docUrl}\n\n--- CONTENT ---\n${session.docContent}\n\n---`;

  if (session.questions.length === 0) {
    prompt += `\n\nStart the Grill-Me session. Ask your FIRST sharp question. Be direct and specific.`;
  } else if (nextQuestionOnly) {
    const qNum = session.questions.length + 1;
    const choiceHint = qNum === 2
      ? '\n\nFor this question about style or approach — offer exactly 2 named alternatives:\n[A] Approach A description\n[B] Approach B description\nThen ask your specific question.'
      : qNum === 3
      ? '\n\nFor this question about visual design or layout — offer exactly 2 named alternatives:\n[A] Design approach A description\n[B] Design approach B description\nThen ask your question.'
      : '';
    prompt += `\n\nCONVERSATION SO FAR:\n${history}\n\nJust answer the next question above. Ask your next sharp question (question #${qNum}).${choiceHint}`;
  } else {
    prompt += `\n\nCONVERSATION:\n${history}\n\nGenerate the HTML prototype now. Output only the html code block.`;
  }

  return prompt;
}

// ── Parse HTML from LLM response ────────────────────────────────────────────

function parseHtmlReply(text) {
  let html = (text.match(/```html\n?([\s\S]*?)```/) || [])[1] || text.trim();
  // Strip forbidden CDN dependencies (anti-slop enforcement)
  html = html
    .replace(/<link[^>]+cdnjs[^>]+font-awesome[^>]+>/gi, '')
    .replace(/<link[^>]+cdn[^>]+tailwind[^>]+>/gi, '')
    .replace(/<link[^>]+cdn[^>]+bootstrap[^>]+>/gi, '')
    .replace(/<link[^>]+cdn[^>]+heroicons[^>]+>/gi, '')
    .replace(/<script[^>]+cdnjs[^>]+font-awesome[^>]*><\/script>/gi, '')
    .replace(/<script[^>]+cdn[^>]+tailwind[^>]*><\/script>/gi, '')
    .replace(/<script[^>]+cdn[^>]+bootstrap[^>]*><\/script>/gi, '')
    .replace(/<script[^>]+cdn[^>]+heroicons[^>]*><\/script>/gi, '')
    .replace(/<script[^>]+cdn[^>]+\.(jsdelivr|unpkg|jsdelivr\.net)[^>]*><\/script>/gi, '')
    .replace(/<link[^>]+cdn[^>]+\.(jsdelivr|unpkg|jsdelivr\.net)[^>]+>/gi, '');
  // Mistral sometimes omits closing script tag — detect and fix
  const openS = (html.match(/<script[^>]*>/gi) || []).length;
  const closeS = (html.match(/<\/script>/gi) || []).length;
  if (openS > closeS) { html += '<\/script>'; }
  return html;
}

// ── API Routes ───────────────────────────────────────────────────────────────

/** GET /health — Cloud Run readiness probe */
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

/** POST /api/sessions — start session, get first question */
app.post('/api/sessions', async (req, res) => {
  const { url, text: rawText } = req.body;

  let docContent = '', docType = 'text', docUrl = '';

  if (rawText) {
    // Direct text input — for local testing / PDF uploads
    docContent = String(rawText).slice(0, 8000);
    docType = 'pdf-extract';
    docUrl = 'local-doc';
  } else if (url) {
    try {
      if (url.includes('docs.google.com')) {
        docContent = await fetchGoogleDoc(url);
        docType = 'google-doc';
      } else if (url.includes('github.com') && (url.endsWith('.md') || url.includes('/blob/'))) {
        docContent = await fetchGitHubMd(url);
        docType = 'markdown';
      } else {
        docContent = await fetchUrlText(url);
        docType = 'text';
      }
    } catch (e) {
      return res.status(400).json({ error: `Failed to fetch document: ${e.message}` });
    }
    docUrl = url;
  } else {
    return res.status(400).json({ error: 'url or text required' });
  }

  const session = createSession({ docContent, docType, docUrl });

  try {
    const prompt = buildGrillPrompt(session);
    // Q1, Q2 — short answer, 600 tokens is fine
    const reply = await llm.query(prompt, { maxTokens: 600, temperature: 0.85 });

    const question = reply.replace(/```[\s\S]*?```/g, '').trim();
    session.questions.push(question);

    res.json({ sessionId: session.id, firstQuestion: question });
  } catch (e) {
    sessions.delete(session.id);
    res.status(500).json({ error: `LLM error: ${e.message}` });
  }
});

/** POST /api/sessions/:id/answer — submit answer → next question or HTML */
app.post('/api/sessions/:id/answer', async (req, res) => {
  const { answer } = req.body;
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.phase === 'done') return res.json({ done: true, html: session.htmlOutput });

  session.answers.push(answer);

  if (session.answers.length >= 3) {
    session.phase = 'generating';
    try {
      const prompt = buildGrillPrompt(session, false);
      // Q3 / final — 6000 tokens (Groq limit for llama-3.1-8b-instant is ~32K total request, need room for prompt)
    const reply = await llm.query(prompt, { maxTokens: 6000, temperature: 0.65 });
      session.htmlOutput = parseHtmlReply(reply);
      session.phase = 'done';
      res.json({ done: true, html: session.htmlOutput });
    } catch (e) {
      res.status(500).json({ error: `Generation failed: ${e.message}` });
    }
  } else {
    try {
      const prompt = buildGrillPrompt(session, true);
      const reply = await llm.query(prompt, { maxTokens: 500, temperature: 0.85 });
      const question = reply.replace(/```[\s\S]*?```/g, '').trim();
      session.questions.push(question);
      res.json({
        done: false,
        questionNumber: session.questions.length,
        nextQuestion: question
      });
    } catch (e) {
      res.status(500).json({ error: `LLM error: ${e.message}` });
    }
  }
});

/** GET /api/sessions/:id — session status */
app.get('/api/sessions/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({
    phase: s.phase,
    questionsAnswered: s.answers.length,
    currentQuestion: s.questions[s.questions.length - 1] || null
  });
});

/** GET /api/sessions/:id/output — get generated HTML */
app.get('/api/sessions/:id/output', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  if (!s.htmlOutput) return res.status(404).json({ error: 'Output not ready' });
  res.json({ html: s.htmlOutput });
});

// ── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => {
  console.log(`🔥 Doc-Grill running → http://localhost:${PORT}`);
  console.log(`   LLM: ${llm.providers.map(p => p.name).join(' → ')}`);
});
