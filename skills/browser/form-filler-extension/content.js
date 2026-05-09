/**
 * FormFiller Pro — Content Script
 * 
 * Runs on every page. Detects job application forms, scans fields,
 * fills them from stored profile data. Pure rule-based, no LLM.
 * 
 * Architecture:
 * - Detector: Identifies ATS platform from URL + DOM
 * - Scanner: Maps form fields to semantic types via CSS selectors + labels
 * - Filler: Fills fields with proper React-compatible event dispatching
 * - React Select handler: Full pointer event sequence for custom dropdowns
 */

(function () {
  'use strict';

  // Prevent double injection
  if (window.__formFillerProLoaded) return;
  window.__formFillerProLoaded = true;

  const log = (...args) => console.log('[FormFiller]', ...args);

  // =====================================================================
  // SECTION 1: FIELD SELECTORS — CSS selector arrays per semantic type
  // =====================================================================

  const FIELD_SELECTORS = {
    first_name: [
      'input[id="first_name"]', 'input[name="first_name"]',
      'input[id*="first-name"]', 'input[name*="first-name"]',
      'input[id*="first_name"]', 'input[name*="first_name"]',
      'input[autocomplete="given-name"]',
    ],
    last_name: [
      'input[id="last_name"]', 'input[name="last_name"]',
      'input[id*="last-name"]', 'input[name*="last-name"]',
      'input[id*="last_name"]', 'input[name*="last_name"]',
      'input[autocomplete="family-name"]',
    ],
    email: [
      'input[type="email"]', 'input[name="email"]',
      'input[id*="email"]', 'input[autocomplete="email"]',
    ],
    phone: [
      'input[type="tel"]', 'input[name="phone"]',
      'input[id*="phone"]', 'input[id*="mobile"]',
      'input[autocomplete="tel"]',
    ],
    linkedin: [
      'input[name*="linkedin"]', 'input[id*="linkedin"]',
      'input[placeholder*="LinkedIn" i]',
    ],
    github: [
      'input[name*="github"]', 'input[id*="github"]',
      'input[placeholder*="GitHub" i]',
    ],
    website: [
      'input[name*="website"]', 'input[name*="portfolio"]',
      'input[placeholder*="website" i]', 'input[placeholder*="portfolio" i]',
    ],
    current_company: [
      'input[name*="current_company"]', 'input[id*="current-company"]',
      'input[autocomplete="organization"]',
    ],
    current_title: [
      'input[name*="current_title"]', 'input[id*="current-title"]',
      'input[id*="current_designation"]',
    ],
    company_name: [
      'input[id*="company-name"]', 'input[name*="company_name"]',
      'input[id*="company_name"]', 'input[name*="company-name"]',
    ],
    job_title: [
      'input[id*="title-"]', 'input[name*="title-"]',
    ],
    salary: [
      'input[name*="salary"]', 'input[id*="salary"]',
      'input[name*="ctc"]', 'input[id*="ctc"]',
      'input[name*="compensation"]',
    ],
    salary_expectations: [
      'input[name*="expected_salary"]', 'input[id*="expected-salary"]',
      'input[name*="expected_ctc"]', 'input[id*="expected-ctc"]',
      'input[name*="salary_expectation"]',
    ],
    notice_period: [
      'input[name*="notice"]', 'input[id*="notice"]',
      'input[name*="notice_period"]',
    ],
    years_of_experience: [
      'input[name*="years_of_experience"]', 'input[id*="years-of-experience"]',
      'input[name*="total_experience"]',
    ],
    school: [
      'input[name*="school"]', 'input[id*="school"]',
      'input[name*="university"]', 'input[id*="university"]',
    ],
    degree: [
      'input[name*="degree"]', 'input[id*="degree"]',
      'select[name*="degree"]', 'select[id*="degree"]',
    ],
    cover_letter: [
      'textarea[name*="cover_letter"]', 'textarea[id*="cover-letter"]',
      'textarea[name*="coverletter"]',
    ],
    additional_info: [
      'textarea[name*="additional"]', 'textarea[id*="additional"]',
    ],
  };

  // =====================================================================
  // SECTION 2: LABEL MAPPINGS — text-based label matching
  // =====================================================================

  const LABEL_MAPPINGS = {
    first_name: ['first name', 'given name', 'prénom'],
    last_name: ['last name', 'surname', 'family name'],
    email: ['email', 'e-mail', 'email address'],
    phone: ['phone', 'telephone', 'mobile', 'cell', 'contact number', 'phone number'],
    linkedin: ['linkedin', 'linkedin profile', 'linkedin url'],
    github: ['github', 'github profile'],
    website: ['website', 'portfolio', 'personal website', 'personal site'],
    current_company: ['current company', 'current employer', 'most recent company'],
    current_title: ['current title', 'current role', 'current designation'],
    company_name: ['company name', 'company', 'employer', 'organization'],
    job_title: ['title', 'job title', 'position', 'designation'],
    start_date_month: ['start date month', 'start month', 'from month'],
    start_date_year: ['start date year', 'start year', 'from year'],
    end_date_month: ['end date month', 'end month', 'to month'],
    end_date_year: ['end date year', 'end year', 'to year'],
    school: ['school', 'university', 'institution', 'college'],
    degree: ['degree', 'qualification'],
    discipline: ['discipline', 'major', 'field of study'],
    salary: ['salary', 'compensation', 'ctc', 'current ctc', 'mention the current ctc'],
    salary_expectations: ['expected ctc', 'salary expectation', 'expected salary', 'expected ctc (fixed)'],
    notice_period: ['notice period', 'notice'],
    years_of_experience: ['years of experience', 'total experience', 'total years of experience'],
    gender: ['gender'],
    city: ['city', 'town'],
    state: ['state', 'province', 'region'],
    country: ['country'],
    referral_source: ['how did you hear', 'referral source', 'source'],
    cover_letter: ['cover letter'],
    veteran: ['veteran', 'military'],
    disability: ['disability'],
    work_authorization: ['authorized to work', 'legally authorized', 'eligible to work'],
    sponsorship_required: ['sponsorship', 'visa sponsorship', 'require sponsorship'],
    willing_to_relocate: ['willing to work from office', 'willing to relocate', 'work from office'],
  };

  // Profile key → fallback keys for value resolution
  const VALUE_FALLBACKS = {
    first_name: ['first_name', 'full_name'],
    last_name: ['last_name', 'full_name'],
    email: ['email'],
    phone: ['phone', 'phone_full', 'mobile'],
    linkedin: ['linkedin'],
    github: ['github'],
    website: ['website', 'portfolio'],
    current_company: ['current_company'],
    current_title: ['current_title'],
    company_name: ['current_company', 'company_name'],
    job_title: ['current_title', 'job_title'],
    school: ['school', 'university'],
    highest_degree: ['highest_degree', 'degree'],
    salary: ['salary'],
    salary_expectations: ['salary_expectations'],
    notice_period: ['notice_period'],
    years_of_experience: ['years_of_experience'],
    gender: ['gender'],
    country: ['country'],
    city: ['city'],
    state: ['state'],
    start_date_year: ['start_date_year'],
    end_date_year: ['end_date_year'],
    start_date_month: ['start_date_month'],
    end_date_month: ['end_date_month'],
    willing_to_relocate: ['willing_to_relocate'],
    full_name: ['full_name', 'first_name'],
    privacy_policy: ['privacy_policy'],
  };

  // Placeholder-to-semantic type (for Reczee and similar forms)
  const PLACEHOLDER_MAPPINGS = {
    'enter your name': 'full_name',
    'your name': 'full_name',
    'enter your email': 'email',
    'your email': 'email',
    'enter your phone': 'phone',
    'your phone number': 'phone',
    'phone number': 'phone',
    'enter your experience': 'years_of_experience',
    'your experience': 'years_of_experience',
    'enter current salary': 'salary',
    'current salary': 'salary',
    'enter expected salary': 'salary_expectations',
    'expected salary': 'salary_expectations',
    'enter your current ctc': 'salary',
    'enter your expected ctc': 'salary_expectations',
    'enter your notice period': 'notice_period',
    'notice period': 'notice_period',
    'enter your location': 'city',
    'your location': 'city',
    'enter your city': 'city',
    'enter your linkedin': 'linkedin',
    'linkedin url': 'linkedin',
    'enter your company': 'current_company',
    'company name': 'company_name',
    'enter your designation': 'current_title',
    'your designation': 'current_title',
  };

  // Name attribute → semantic type
  const NAME_MAPPINGS = {
    'name': 'full_name',
    'email': 'email',
    'phone': 'phone',
    'experience': 'years_of_experience',
    'current_ctc': 'salary',
    'expected_ctc': 'salary_expectations',
    'current_salary': 'salary',
    'expected_salary': 'salary_expectations',
    'notice_period': 'notice_period',
    'location': 'city',
    'city': 'city',
    'company': 'current_company',
    'designation': 'current_title',
    'linkedin': 'linkedin',
    'github': 'github',
    'website': 'website',
    'portfolio': 'website',
    'first_name': 'first_name',
    'last_name': 'last_name',
    'resume': 'resume',
    'privacy_policy': 'privacy_policy',
  };

  // =====================================================================
  // SECTION 3: PLATFORM DETECTOR
  // =====================================================================

  function detectPlatform() {
    const hostname = window.location.hostname;
    const url = window.location.href;

    if (hostname.includes('greenhouse.io')) return 'greenhouse';
    if (hostname.includes('jobs.lever.co') || hostname.includes('lever.co')) return 'lever';
    if (hostname.includes('myworkday') || hostname.includes('workday')) return 'workday';
    if (hostname.includes('icims.com')) return 'icims';
    if (hostname.includes('jobvite.com')) return 'jobvite';
    if (hostname.includes('smartrecruiters.com')) return 'smartrecruiters';
    if (hostname.includes('docs.google.com') && url.includes('/forms/')) return 'google_forms';

    // DOM-based detection for embedded forms
    if (document.querySelector('#application_form') ||
        document.querySelector('form[action*="greenhouse"]') ||
        document.querySelector('#grnhse_app')) return 'greenhouse';
    if (document.querySelector('.posting-page') || document.querySelector('[data-qa="posting-name"]')) return 'lever';

    // Generic: has a form with typical fields?
    if (document.querySelector('form input[name*="name"]') ||
        document.querySelector('form input[name*="email"]')) return 'generic';

    return 'unknown';
  }

  // =====================================================================
  // SECTION 4: FIELD SCANNER
  // =====================================================================

  function classifyByLabel(labelText) {
    if (!labelText) return null;
    const clean = labelText.toLowerCase().replace(/\*/g, '').trim();
    let bestMatch = null;
    let bestScore = 0;

    for (const [semType, keywords] of Object.entries(LABEL_MAPPINGS)) {
      for (const kw of keywords) {
        const kwClean = kw.replace(/\*/g, '').trim().toLowerCase();
        if (!kwClean) continue;
        if (clean.includes(kwClean) || kwClean.includes(clean)) {
          const score = kwClean.length;
          if (score > bestScore) {
            bestScore = score;
            bestMatch = semType;
          }
        }
      }
    }
    return bestMatch;
  }

  function findLabel(input) {
    // Method 1: label[for]
    if (input.id) {
      const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (label) return label.textContent?.trim() || '';
    }
    // Method 2: aria-label
    if (input.getAttribute('aria-label')) return input.getAttribute('aria-label');
    // Method 3: closest parent field wrapper
    const parent = input.closest('.field, .form-group, .form-field, .application-field, .application-question, div[class*="field"]');
    if (parent) {
      const label = parent.querySelector('label, .label, .field-label, legend, span[class*="label"]');
      if (label) return label.textContent?.trim() || '';
    }
    // Method 4: previous sibling label
    const prev = input.previousElementSibling;
    if (prev?.tagName === 'LABEL') return prev.textContent?.trim() || '';
    // Method 5: placeholder
    if (input.getAttribute('placeholder')) return input.getAttribute('placeholder');
    // Method 6: name attribute
    if (input.name) return input.name.replace(/[_\[\]]/g, ' ').trim();
    return '';
  }

  function scanFields() {
    const fields = [];
    const seen = new Set();

    // Strategy 1: Standard input/select/textarea
    const inputs = document.querySelectorAll('form input, form select, form textarea, #application_form input, #application_form select, #application_form textarea');
    // If no form-scoped inputs, try all visible inputs
    const allInputs = inputs.length > 0 ? inputs : document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea');

    for (const input of allInputs) {
      const el = input;
      const tag = el.tagName.toLowerCase();
      const type = (el.type || '').toLowerCase();

      // Skip hidden, submit, button, file
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
      if (tag === 'input' && type === '') continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;

      // Build unique key
      const key = el.id || el.name || `${tag}:${type}:${Array.from(el.parentElement?.children || []).indexOf(el)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const label = findLabel(el);
      const placeholder = el.getAttribute('placeholder') || '';
      let semanticType = classifyByLabel(label) || classifyByIdName(el);
      
      // Fallback: placeholder matching (Reczee, etc.)
      if (!semanticType || semanticType === 'unknown') {
        const phLower = placeholder.toLowerCase().trim();
        if (PLACEHOLDER_MAPPINGS[phLower]) {
          semanticType = PLACEHOLDER_MAPPINGS[phLower];
        }
      }
      
      // Fallback: name attribute matching
      if ((!semanticType || semanticType === 'unknown') && el.name) {
        const nameKey = el.name.toLowerCase().replace(/[\[\]]/g, '');
        if (NAME_MAPPINGS[nameKey]) {
          semanticType = NAME_MAPPINGS[nameKey];
        }
      }
      semanticType = semanticType || 'unknown';
      
      const required = el.hasAttribute('required') || el.getAttribute('aria-required') === 'true' || label.includes('*');

      const selector = el.id ? `#${CSS.escape(el.id)}` :
                        el.name ? `${tag}[name="${CSS.escape(el.name)}"]` : null;

      if (!selector) continue;

      // Get options for select
      const options = [];
      if (tag === 'select') {
        for (const opt of el.options) {
          if (opt.value && opt.value !== '') options.push(opt.textContent?.trim() || opt.value);
        }
      }

      fields.push({
        selector,
        label,
        semanticType: semanticType || 'unknown',
        type: type || tag,
        tag,
        required,
        hasValue: !!(el.value && el.value.trim()),
        options: options.length > 0 ? options : undefined,
      });
    }

    // Strategy 2: React Select / custom dropdowns
    const customDropdowns = document.querySelectorAll(
      '[class*="select__container"], [class*="select-container"], [class*="Select__control"], [data-testid*="select"]'
    );

    for (const dd of customDropdowns) {
      const container = dd.closest('[class*="select__container"], .field, div[class*="field"]') || dd.parentElement;
      if (!container) continue;

      const label = findLabel(container) || findLabel(dd);
      const semanticType = classifyByLabel(label) || 'unknown';

      // Find the control element
      const control = container.querySelector('[class*="select__control"], [class*="Select-control"], [role="combobox"]');
      const inputEl = container.querySelector('input[type="text"]');
      
      // Build selector: prefer input ID, then container ID, then control class
      let selector;
      if (inputEl?.id) {
        selector = `#${CSS.escape(inputEl.id)}`;
      } else if (container.id) {
        selector = `#${CSS.escape(container.id)}`;
      } else if (control) {
        // Use the control element's class as selector
        const mainClass = Array.from(control.classList).find(c => c.startsWith('select__control'));
        selector = mainClass ? `.${mainClass}` : null;
      }
      if (!selector) continue;

      const key = `react-select:${label}:${selector}`;
      if (seen.has(key)) continue;
      seen.add(key);

      fields.push({
        selector,
        label,
        semanticType,
        type: 'custom-dropdown',
        tag: 'custom-dropdown',
        required: label.includes('*') || !!container.querySelector('[aria-required="true"]'),
        hasValue: !!container.querySelector('[class*="singleValue"], [class*="SingleValue"]'),
        isReactSelect: true,
        controlSelector: selector,
        containerEl: true, // flag that selector points to container area
      });
    }

    // Strategy 3: MUI Autocomplete (Reczee, etc.)
    const muiAutocompletes = document.querySelectorAll('[class*="MuiAutocomplete-root"]');
    for (const ac of muiAutocompletes) {
      const input = ac.querySelector('input:not([type="hidden"])');
      if (!input) continue;
      
      // Find what this autocomplete is for by checking nearby context
      const formControl = ac.closest('[class*="MuiFormControl"]') || ac;
      const allInputsInGroup = formControl.parentElement?.querySelectorAll('input[name]') || [];
      
      // Try to determine from context: what field comes before/after
      const allFields = document.querySelectorAll('input[name], [class*="MuiAutocomplete-root"]');
      let contextLabel = '';
      
      // Check if there's a nearby label or heading
      const parent = ac.parentElement;
      if (parent) {
        const prevSibling = ac.previousElementSibling;
        if (prevSibling?.textContent?.trim()) {
          contextLabel = prevSibling.textContent.trim();
        }
      }
      
      // Try to classify by position relative to named inputs
      // Find the nearest named input above this autocomplete
      let semanticType = 'unknown';
      const namedInputs = document.querySelectorAll('input[name]');
      const allFormEls = Array.from(document.querySelectorAll('input, select, textarea, [class*="MuiAutocomplete"]'));
      const acIndex = allFormEls.indexOf(ac);
      
      // Look at the preceding named input to guess context
      if (acIndex > 0) {
        for (let i = acIndex - 1; i >= 0; i--) {
          const prev = allFormEls[i];
          if (prev.name) {
            const prevName = prev.name.toLowerCase();
            // After salary fields → currency autocomplete
            if (prevName.includes('ctc') || prevName.includes('salary') || prevName.includes('compensation')) {
              semanticType = 'currency';
            }
            // After experience → location autocomplete
            if (prevName.includes('experience') || prevName.includes('phone')) {
              semanticType = 'location';
            }
            break;
          }
        }
      }
      
      const key = `mui-ac:${input.id || acIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      
      const selector = input.id ? `#${CSS.escape(input.id)}` : null;
      if (!selector) continue;
      
      fields.push({
        selector,
        label: contextLabel || `MUI Autocomplete ${acIndex}`,
        semanticType,
        type: 'mui-autocomplete',
        tag: 'input',
        required: false,
        hasValue: !!(input.value && input.value.trim()),
        isMuiAutocomplete: true,
      });
    }

    return fields;
  }

  function classifyByIdName(el) {
    const fid = (el.id || '').toLowerCase();
    const name = (el.name || '').toLowerCase();
    const checks = [
      [/\bfirst.?name\b/, 'first_name'],
      [/\blast.?name\b/, 'last_name'],
      [/\bemail\b/, 'email'],
      [/\bphone\b/, 'phone'],
      [/\blinkedin\b/, 'linkedin'],
      [/\bgithub\b/, 'github'],
      [/\bcompany.?name\b/, 'company_name'],
      [/\bcompany\b/, 'current_company'],
      [/\btitle\b/, 'job_title'],
      [/\bstart.?date.?month\b/, 'start_date_month'],
      [/\bstart.?date.?year\b/, 'start_date_year'],
      [/\bend.?date.?month\b/, 'end_date_month'],
      [/\bend.?date.?year\b/, 'end_date_year'],
      [/\bnotice\b/, 'notice_period'],
      [/\bexperience\b/, 'years_of_experience'],
      [/\bcountry\b/, 'country'],
      [/\bgender\b/, 'gender'],
    ];
    for (const [pattern, semType] of checks) {
      if (pattern.test(fid) || pattern.test(name)) return semType;
    }
    // Type-based
    if (el.type === 'email') return 'email';
    if (el.type === 'tel') return 'phone';
    if (el.type === 'url') return 'website';
    return null;
  }

  // =====================================================================
  // SECTION 5: FORM FILLER — React-compatible value setting
  // =====================================================================

  function fillTextField(el, value) {
    el.focus();
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Use native setter for React compatibility
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(el, value);
    } else {
      el.value = value;
    }

    // Dispatch React-compatible events
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }

  function fillDropdown(selectEl, value) {
    const normalizedTarget = value.toLowerCase().trim();

    // Use native setter for React
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;

    // Exact match
    for (const opt of selectEl.options) {
      const text = opt.textContent?.toLowerCase().trim() || '';
      if (text === normalizedTarget || opt.value.toLowerCase().trim() === normalizedTarget) {
        if (nativeSetter) nativeSetter.call(selectEl, opt.value);
        else selectEl.value = opt.value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }

    // Substring match (min 4 chars)
    if (normalizedTarget.length >= 4) {
      for (const opt of selectEl.options) {
        const text = opt.textContent?.toLowerCase().trim() || '';
        if (text.length >= 4 && (text.includes(normalizedTarget) || normalizedTarget.includes(text))) {
          if (nativeSetter) nativeSetter.call(selectEl, opt.value);
          else selectEl.value = opt.value;
          selectEl.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
    }
    return false;
  }

  async function fillReactSelect(field, value) {
    // Find the control element — try the selector first, then search
    let control = null;
    
    // Method 1: selector is an input ID — find its parent container and control
    if (field.selector.startsWith('#')) {
      const inputEl = document.querySelector(field.selector);
      if (inputEl) {
        const container = inputEl.closest('[class*="select__container"], [class*="field"]');
        if (container) {
          control = container.querySelector('[class*="select__control"]');
        }
      }
    }
    
    // Method 2: direct control selector
    if (!control && field.controlSelector) {
      control = document.querySelector(field.controlSelector);
    }
    
    // Method 3: find by label text
    if (!control) {
      const labels = document.querySelectorAll('label');
      for (const l of labels) {
        if (l.textContent.trim().replace(/\*/g, '').trim() === field.label.replace(/\*/g, '').trim()) {
          const container = l.closest('[class*="select__container"], [class*="field"]');
          if (container) {
            control = container.querySelector('[class*="select__control"]');
          }
          break;
        }
      }
    }
    
    if (!control) return false;

    // Full pointer event sequence for React Select
    control.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const rect = control.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    control.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
    control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
    control.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, button: 0 }));
    control.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y, button: 0 }));
    control.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y, button: 0 }));

    // Wait for menu to open
    await new Promise(r => setTimeout(r, 500));

    // Search in both container and document body (React portals)
    const normalizedTarget = value.toLowerCase().trim();
    const searchRoots = [document.body];

    for (const root of searchRoots) {
      const options = root.querySelectorAll(
        '[role="option"], [class*="select__option"], [class*="option"], li[id*="option"]'
      );

      // Exact match first
      for (const opt of options) {
        const text = opt.textContent?.toLowerCase().trim() || '';
        if (text === normalizedTarget) {
          opt.click();
          return true;
        }
      }
      // Substring match
      if (normalizedTarget.length >= 3) {
        for (const opt of options) {
          const text = opt.textContent?.toLowerCase().trim() || '';
          if (text.includes(normalizedTarget) || normalizedTarget.includes(text)) {
            opt.click();
            return true;
          }
        }
      }
    }

    // Close if nothing matched
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return false;
  }

  function resolveValue(semanticType, profile) {
    const fallbacks = VALUE_FALLBACKS[semanticType];
    if (!fallbacks) return null;
    for (const key of fallbacks) {
      if (profile[key] != null && profile[key] !== '') return String(profile[key]);
    }
    return null;
  }

  function cleanNumericValue(value) {
    // Strip non-numeric chars except dots
    const cleaned = value.replace(/[^0-9.]/g, '');
    return cleaned || value;
  }

  // =====================================================================
  // SECTION 6: MAIN AUTOFILL ORCHESTRATOR
  // =====================================================================

  async function autofill(profile, options = {}) {
    const { skipTypes = [], dryRun = false } = options;
    const fields = scanFields();
    const results = { filled: 0, skipped: 0, errors: 0, details: [] };

    log(`Scanned ${fields.length} fields`);

    for (const field of fields) {
      const { semanticType, type, label, selector, hasValue, isReactSelect, required } = field;

      // Skip already filled
      if (hasValue) {
        results.skipped++;
        results.details.push({ label, semanticType, action: 'skip', reason: 'Already filled' });
        continue;
      }

      // Skip explicitly skipped types
      if (skipTypes.includes(semanticType)) {
        results.skipped++;
        results.details.push({ label, semanticType, action: 'skip', reason: `Skipped type '${semanticType}'` });
        continue;
      }

      // Skip file uploads
      if (type === 'file') {
        results.skipped++;
        results.details.push({ label, semanticType, action: 'skip', reason: 'File upload' });
        continue;
      }

      // Resolve value
      const value = resolveValue(semanticType, profile);
      if (!value) {
        results.skipped++;
        results.details.push({ label, semanticType, action: 'skip', reason: 'No profile match' });
        continue;
      }

      if (dryRun) {
        results.details.push({ label, semanticType, action: 'would-fill', value });
        results.filled++;
        continue;
      }

      // Fill the field
      try {
        let success = false;

        if (isReactSelect || type === 'custom-dropdown') {
          success = await fillReactSelect(field, value);
        } else if (isReactSelect || type === 'mui-autocomplete') {
          // MUI Autocomplete: type to search, then select from dropdown
          const el = document.querySelector(selector);
          if (el) {
            fillTextField(el, value);
            await new Promise(r => setTimeout(r, 300));
            // Try to click the first option in the MUI popup
            const option = document.querySelector('[class*="MuiAutocomplete-option"]');
            if (option) {
              option.click();
              success = true;
            } else {
              // If no popup, the typed value might be accepted
              success = true;
            }
          }
        } else if (type === 'select') {
          const el = document.querySelector(selector);
          if (el) success = fillDropdown(el, value);
        } else if (type === 'checkbox') {
          const el = document.querySelector(selector);
          if (el && !el.checked) {
            el.click();
            success = true;
          } else if (el && el.checked) {
            success = true; // already checked
          }
        } else {
          // Text/number/email/tel/textarea — clean value for number fields
          let cleanVal = value;
          if (type === 'number') {
            cleanVal = cleanNumericValue(value);
          }
          const el = document.querySelector(selector);
          if (el) success = fillTextField(el, cleanVal);
        }

        if (success) {
          results.filled++;
          results.details.push({ label, semanticType, action: 'filled', value });
        } else {
          results.errors++;
          results.details.push({ label, semanticType, action: 'error', reason: 'Fill failed' });
        }
      } catch (err) {
        results.errors++;
        results.details.push({ label, semanticType, action: 'error', reason: err.message });
      }

      // Small delay between fields
      await new Promise(r => setTimeout(r, 100));
    }

    return results;
  }

  // =====================================================================
  // SECTION 7: NOTIFICATION BANNER
  // =====================================================================

  function showBanner(platform) {
    if (document.getElementById('formfiller-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'formfiller-banner';
    banner.style.cssText = `
      position: fixed; top: 16px; right: 16px; z-index: 999999;
      padding: 12px 16px; border-radius: 12px; border: 1px solid #6366f1;
      background: #eef2ff; color: #312e81; font-size: 13px;
      font-family: system-ui, -apple-system, sans-serif;
      box-shadow: 0 10px 30px rgba(0,0,0,0.14); max-width: 340px;
    `;
    banner.innerHTML = `
      <div style="display:flex; align-items:center; gap:12px;">
        <div style="flex:1">
          <div style="font-weight:700; margin-bottom:4px;">📋 FormFiller Pro</div>
          <div id="formfiller-status" style="font-size:12px">
            ${platform !== 'unknown' ? `${platform.charAt(0).toUpperCase() + platform.slice(1)} form detected!` : 'Form detected!'}
            <button id="formfiller-autofill-btn" style="margin-left:8px; padding:4px 10px; border:none; border-radius:6px; background:#6366f1; color:white; cursor:pointer; font-size:12px;">
              Autofill
            </button>
          </div>
        </div>
        <button id="formfiller-close" style="border:none; background:transparent; color:inherit; font-size:18px; cursor:pointer;">×</button>
      </div>
    `;
    document.body.appendChild(banner);

    document.getElementById('formfiller-close')?.addEventListener('click', () => banner.remove());
    document.getElementById('formfiller-autofill-btn')?.addEventListener('click', async () => {
      const resp = await chrome.runtime.sendMessage({ type: 'AUTOFILL' });
      if (resp?.results) {
        document.getElementById('formfiller-status').innerHTML =
          `✅ Filled ${resp.results.filled} fields, skipped ${resp.results.skipped}`;
      }
    });
  }

  // =====================================================================
  // SECTION 8: MESSAGE HANDLER
  // =====================================================================

  // Check if we're in extension context or standalone
  const isExtension = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage;

  if (isExtension) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      switch (message.type) {
        case 'DETECT_FORM': {
          const platform = detectPlatform();
          const fields = scanFields();
          sendResponse({ platform, fieldCount: fields.length, detected: fields.length > 0 });
          break;
        }
        case 'SCAN_FIELDS': {
          const fields = scanFields();
          const platform = detectPlatform();
          sendResponse({ fields, platform, url: window.location.href });
          break;
        }
        case 'AUTOFILL': {
          const profile = message.profile || {};
          const options = message.options || {};
          autofill(profile, options).then(results => {
            sendResponse({ results });
          });
          return true; // async
        }
        default:
          sendResponse({ error: 'Unknown message type' });
      }
    });
  }

  // Expose API for standalone/testing use (window.formFillerPro)
  window.formFillerPro = {
    detectPlatform,
    scanFields,
    autofill,
    fillTextField,
    fillDropdown,
  };

  // =====================================================================
  // SECTION 9: INITIALIZATION
  // =====================================================================

  const platform = detectPlatform();
  if (platform !== 'unknown') {
    log(`Platform detected: ${platform}`);
    showBanner(platform);
  }

  log('FormFiller Pro content script loaded');
})();
