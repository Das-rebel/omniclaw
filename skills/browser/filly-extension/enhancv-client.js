/**
 * FillY × Enhancv — Generate polished resume PDFs via Enhancv API
 *
 * Flow: FillY profile → Enhancv resume JSON → POST /resumes → GET /resumes/:id/pdf
 *
 * API docs: https://developers.enhancv.com/
 * Auth: Bearer token (get from app.enhancv.com → Account Settings → Profile → API Keys)
 */

(function() {
  'use strict';

  const BASE_URL = 'https://api.enhancv.com/api/v1';

  // Placeholder — replaced with real key from FillY settings
  let _apiKey = null;

  // ============================================================================
  // SECTION 1: API KEY MANAGEMENT
  // ============================================================================

  function setApiKey(key) {
    _apiKey = key.trim();
  }

  function getApiKey() {
    return _apiKey;
  }

  // ============================================================================
  // SECTION 2: CONVERT FILLY PROFILE → ENHANCV RESUME SCHEMA
  // ============================================================================

  /**
   * Convert FillY fill profile (flat key-value map) to Enhancv API schema.
   * Enhancv expects: { title, header, sections: { summaries, experiences, skills, education } }
   */
  function fillProfileToEnhancv(profile) {
    const p = profile || {};

    // Build header
    const header = {
      name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' '),
      title: p.current_title || '',
      email: p.email || '',
      phone: p.phone || '',
      location: [p.city, p.state, p.country].filter(Boolean).join(', '),
      website: p.linkedin_url || p.linkedin || p.github || '',
    };

    // Remove empty fields
    Object.keys(header).forEach(k => {
      if (!header[k]) delete header[k];
    });

    // Build summary section
    const summaryText = p.summary ||
      `Dedicated ${p.current_title || 'professional'} with ${p.years_of_experience || ''} years of experience` +
      (p.current_company ? ` at ${p.current_company}` : '') +
      (p.skills ? `. Key skills include ${p.skills.split(',')[0]}` : '') + '.';

    const sections = {
      summaries: {
        name: 'summary',
        column: 0,
        order: 0,
        items: [{ text: summaryText }]
      }
    };

    // Build experience section
    const workHistory = p.work_history || [];
    if (workHistory.length > 0) {
      sections.experiences = {
        name: 'experience',
        column: 0,
        order: 1,
        items: workHistory.map((w, i) => ({
          workplace: w.company || `Experience ${i + 1}`,
          position: w.title || '',
          location: '',
          dateRange: parseDateRange(w.start, w.end),
          bullets: w.highlights || []
        }))
      };
    }

    // Build education section
    const eduHistory = p.education_history || [];
    if (eduHistory.length > 0 || p.school) {
      sections.education = {
        name: 'education',
        column: 0,
        order: 2,
        items: eduHistory.map(e => ({
          institute: e.institution || e.school || '',
          degree: e.degree || '',
          field: e.area || e.field_of_study || '',
          dateRange: parseDateRange(null, e.endYear || e.endDate),
          bullets: []
        }))
      };
    }

    // Build skills section
    const skillsList = p.skill_list || (p.skills ? p.skills.split(',').map(s => s.trim()).filter(Boolean) : []);
    if (skillsList.length > 0) {
      // Chunk skills into groups of ~5
      const chunks = [];
      for (let i = 0; i < skillsList.length; i += 5) {
        chunks.push(skillsList.slice(i, i + 5));
      }
      sections.skills = {
        name: 'skills',
        column: 1,
        order: 3,
        items: chunks.map((chunk, i) => ({
          title: i === 0 ? 'Technical Skills' : `Skills ${i + 1}`,
          tags: chunk
        }))
      };
    }

    // Title
    const title = [
      p.current_title || 'Resume',
      p.current_company ? `@ ${p.current_company}` : '',
      new Date().getFullYear()
    ].filter(Boolean).join(' ').trim();

    return {
      title,
      header,
      sections
    };
  }

  function parseDateRange(start, end) {
    const result = {};
    if (start) {
      const y = extractYear(start);
      const m = extractMonth(start);
      if (y) { result.fromYear = parseInt(y); result.fromMonth = m || 1; }
    }
    if (end && !/(present|now|current)/i.test(String(end))) {
      const y = extractYear(end);
      const m = extractMonth(end);
      if (y) { result.toYear = parseInt(y); result.toMonth = m || 12; }
    } else if (/(present|now|current)/i.test(String(end))) {
      result.toYear = new Date().getFullYear();
      result.toMonth = new Date().getMonth() + 1;
    }
    return result;
  }

  function extractYear(s) {
    if (!s) return null;
    const m = String(s).match(/\b(19|20)\d{2}\b/);
    return m ? m[0] : null;
  }

  function extractMonth(s) {
    if (!s) return null;
    const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    const lc = String(s).toLowerCase();
    for (const [name, num] of Object.entries(months)) {
      if (lc.includes(name)) return num;
    }
    return null;
  }

  // ============================================================================
  // SECTION 3: ENHANCV API CALLS
  // ============================================================================

  async function enhancvRequest(method, path, body, timeoutMs = 30000) {
    if (!_apiKey) throw new Error('ENHANCV_API_KEY not set. Get it from app.enhancv.com → Account Settings → Profile → API Keys');

    const opts = {
      method,
      headers: {
        Authorization: `Bearer ${_apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      signal: AbortSignal.timeout(timeoutMs)
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${BASE_URL}${path}`, opts);
    const text = await res.text();

    if (!res.ok) {
      let errMsg = `Enhancv API ${res.status}: ${text}`;
      try {
        const errJson = JSON.parse(text);
        if (errJson.error) errMsg = errJson.error.message || errJson.error.type || errMsg;
      } catch (_) {}
      throw new Error(errMsg);
    }

    if (res.headers.get('content-type')?.includes('application/json')) {
      return JSON.parse(text);
    }
    return text;
  }

  /**
   * Create a resume via Enhancv API from structured JSON.
   * @returns {{ id: string }}  Resume ID
   */
  async function createResume(resumeJson) {
    return enhancvRequest('POST', '/resumes', resumeJson);
  }

  /**
   * List all resumes in the account.
   * @returns {{ resumes: Array, pagination: { cursor, limit } }}
   */
  async function listResumes() {
    return enhancvRequest('GET', '/resumes');
  }

  /**
   * Retrieve a resume by ID.
   * @returns {{ id, title, sections, header, ... }}
   */
  async function retrieveResume(id) {
    return enhancvRequest('GET', `/resumes/${id}`);
  }

  /**
   * Delete a resume by ID.
   */
  async function deleteResume(id) {
    return enhancvRequest('DELETE', `/resumes/${id}`);
  }

  /**
   * Export resume as PDF. Enhancv generation takes 5–15s — use 90s timeout.
   * @returns {Uint8Array} PDF bytes
   */
  async function exportPdfBytes(id) {
    if (!_apiKey) throw new Error('ENHANCV_API_KEY not set');

    const res = await fetch(`${BASE_URL}/resumes/${id}/pdf`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${_apiKey}` },
      signal: AbortSignal.timeout(90000)
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`PDF export failed: ${res.status} ${text}`);
    }

    return new Uint8Array(await res.arrayBuffer());
  }

  // ============================================================================
  // SECTION 4: HIGH-LEVEL WORKFLOW
  // ============================================================================

  /**
   * Full pipeline: FillY profile → Enhancv resume JSON → API create → PDF export → save to file
   * @param {Object} profile - FillY fill profile
   * @param {string} apiKey - Enhancv API key
   * @param {string} outPath - Output PDF path (optional)
   * @returns {Promise<{ id, pdfBytes, schema }>}
   */
  async function generateResumePdf(profile, apiKey, outPath = 'resume-enhancv.pdf') {
    if (apiKey) setApiKey(apiKey);
    if (!_apiKey) throw new Error('Enhancv API key required. Get it from app.enhancv.com → Account Settings → Profile → API Keys');

    // Step 1: Build Enhancv schema from profile
    const schema = fillProfileToEnhancv(profile);
    console.log('[FillY↔Enhancv] Resume schema built:', JSON.stringify(schema, null, 2).slice(0, 500));

    // Step 2: Create resume
    console.log('[FillY↔Enhancv] Creating resume...');
    const { id } = await createResume(schema);
    console.log('[FillY↔Enhancv] Created resume ID:', id);

    // Step 3: Wait for PDF generation (5-15s typical)
    console.log('[FillY↔Enhancv] Waiting for PDF generation (up to 90s)...');
    const pdfBytes = await exportPdfBytes(id);

    // Step 4: Save to file
    if (outPath) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(outPath, pdfBytes);
      console.log('[FillY↔Enhancv] PDF saved to:', outPath);
    }

    return { id, pdfBytes, schema };
  }

  // ============================================================================
  // SECTION 5: STANDALONE CLI (for testing outside extension)
  // ============================================================================

  async function runCli() {
    const { readFileSync } = await import('node:fs');
    const args = process.argv.slice(2);

    if (args.includes('--help')) {
      console.log(`
FillY ↔ Enhancv CLI

Usage:
  ENHANCV_API_KEY=xxx node enhancv-client.mjs --create-from <profile.json> [--out resume.pdf]
  ENHANCV_API_KEY=xxx node enhancv-client.mjs --list
  ENHANCV_API_KEY=xxx node enhancv-client.mjs --export <resume-id> [--out resume.pdf]
  ENHANCV_API_KEY=xxx node enhancv-client.mjs --profile-schema

Examples:
  ENHANCV_API_KEY=xxx node enhancv-client.mjs --create-from profile.json --out my-resume.pdf
  ENHANCV_API_KEY=xxx node enhancv-client.mjs --export abc123 --out my-resume.pdf
`);
      process.exit(0);
    }

    const apiKey = process.env.ENHANCV_API_KEY;
    if (!apiKey) { console.error('ENHANCV_API_KEY env var required'); process.exit(1); }
    setApiKey(apiKey);

    if (args.includes('--list')) {
      const r = await listResumes();
      console.log(JSON.stringify(r, null, 2));
    } else if (args.includes('--export')) {
      const idx = args.indexOf('--export');
      const id = args[idx + 1];
      const outIdx = args.indexOf('--out');
      const outPath = outIdx >= 0 ? args[outIdx + 1] : 'resume.pdf';
      const bytes = await exportPdfBytes(id);
      await import('node:fs').then(m => m.writeFileSync(outPath, bytes));
      console.log('PDF saved:', outPath);
    } else if (args.includes('--create-from')) {
      const idx = args.indexOf('--create-from');
      const path = args[idx + 1];
      const outIdx = args.indexOf('--out');
      const outPath = outIdx >= 0 ? args[outIdx + 1] : 'resume-enhancv.pdf';
      const profile = JSON.parse(readFileSync(path, 'utf8'));
      const result = await generateResumePdf(profile, apiKey, outPath);
      console.log('Done! Resume ID:', result.id, '→', outPath);
    } else if (args.includes('--profile-schema')) {
      console.log(JSON.stringify(fillProfileToEnhancv({}), null, 2));
    } else {
      console.error('Unknown args. Use --help');
      process.exit(1);
    }
  }

  // Auto-run if executed directly
  if (typeof require !== 'undefined' && require.main === require.main) {
    runCli().catch(err => { console.error(err.message); process.exit(1); });
  }

  // ============================================================================
  // SECTION 6: PUBLIC API
  // ============================================================================

  window.FillYEnhancv = {
    setApiKey,
    getApiKey,
    fillProfileToEnhancv,
    createResume,
    listResumes,
    retrieveResume,
    deleteResume,
    exportPdfBytes,
    generateResumePdf,
    BASE_URL,
  };

  console.log('[FillY↔Enhancv] Enhancv client loaded. API: window.FillYEnhancv.setApiKey(key), .generateResumePdf(profile), .fillProfileToEnhancv(profile)');
})();
