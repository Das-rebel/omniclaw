/**
 * RealFast AI Job Alert Service
 * Runs daily, fetches positions, scores against profile, sends email alerts
 */

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// Load env vars
require('dotenv').config();

// ============ CONFIGURATION ============
const REALFAST_MCP_URL = 'https://join.realfast.ai/mcp/core';
const REALFAST_AUTH_TOKEN = 'Bearer applyto_8WUFgJQhWSa0XtGkH_7VYYLNvrAD1lsreIALOSFR8dg';
const PREVIOUS_POSITIONS_FILE = path.join(__dirname, 'previous_positions.json');
const LOG_FILE = path.join(__dirname, 'alert.log');

// Email config from env
const SMTP_CONFIG = {
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '465'),
  secure: process.env.SMTP_SECURE !== 'false', // true for 465, false for 587
  auth: {
    user: process.env.SMTP_USER || 'sdas22@gmail.com',
    pass: process.env.SMTP_PASS || ''
  }
};

const EMAIL_FROM = process.env.EMAIL_FROM || 'sdas22@gmail.com';
const EMAIL_TO = process.env.EMAIL_TO || 'sdas22@gmail.com';

// Subhajit's profile for matching
const CANDIDATE_PROFILE = {
  name: 'Subhajit Das',
  email: 'sdas22@gmail.com',
  title: 'AVP, Lead Growth & Partnerships',
  experience_years: 11,
  location: 'Bangalore, India',
  skills: [
    'D2C GTM', 'Platform Partnerships', 'Lending', 'Fintech', 'CRM', 
    'WebEngage', 'Lifecycle CRM', 'A/B Testing', 'Performance Marketing', 
    'Martech', 'LLM Orchestration', 'Multi-model Routing', 'Agent Pipelines',
    'Python', 'JavaScript', 'React', 'Growth Marketing', 'GTM', 'Strategy',
    'Product', 'AI/ML', 'Transformation', 'Fintech', 'Banking'
  ],
  notice_period: 'immediately available',
  work_style: 'flexible/remote'
};

// Keywords for matching
const TITLE_KEYWORDS = [
  'growth', 'strategy', 'partnerships', 'AI', 'transformation', 'product',
  'fintech', 'banking', 'lending', 'marketing', 'CRM', 'GTM', 'lead',
  'director', 'vp', 'head', 'chief', 'business', 'revenue'
];

const SKILL_KEYWORDS = [
  'lending', 'fintech', 'growth', 'marketing', 'CRM', 'product', 'AI', 'ML',
  'transformation', 'strategy', 'partnerships', 'GTM', 'automation',
  'LLM', 'agent', 'pipeline', 'orchestration', 'fintech', 'banking',
  'WebEngage', 'performance', 'A/B', 'lifecycle', 'martech'
];

// ============ LOGGING ============
function log(message, data = null) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}${data ? ' ' + JSON.stringify(data) : ''}`;
  console.log(logLine);
  fs.appendFileSync(LOG_FILE, logLine + '\n');
}

// ============ MCP CLIENT ============
async function mcpRequest(toolName, args = {}) {
  const response = await fetch(REALFAST_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': REALFAST_AUTH_TOKEN
    },
    body: JSON.stringify({
      tool: toolName,
      args: args
    })
  });

  if (!response.ok) {
    throw new Error(`MCP request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function browsePositions() {
  log('Fetching positions from RealFast AI...');
  try {
    const result = await mcpRequest('browse_positions');
    log('Raw MCP response keys:', Object.keys(result));
    
    // Handle different response formats
    if (result.positions && Array.isArray(result.positions)) {
      return result.positions;
    }
    
    // Try to find positions in response
    for (const key of Object.keys(result)) {
      if (Array.isArray(result[key])) {
        log(`Found array at key: ${key}`);
        return result[key];
      }
    }
    
    // If result is a direct array
    if (Array.isArray(result)) {
      return result;
    }
    
    log('Unexpected response structure', result);
    return [];
  } catch (error) {
    log('Error browsing positions:', { message: error.message });
    return [];
  }
}

async function viewPosition(postingId) {
  try {
    const result = await mcpRequest('view_position', { posting_id: postingId });
    log(`Fetched details for posting: ${postingId}`);
    return result;
  } catch (error) {
    log(`Error fetching position ${postingId}:`, { message: error.message });
    return null;
  }
}

// ============ SCORING & MATCHING ============
function calculateMatchScore(position) {
  let score = 0;
  let matchedReasons = [];
  
  const titleLower = (position.title || '').toLowerCase();
  const locationLower = (position.location || '').toLowerCase();
  const descriptionLower = (position.description || position.summary || '').toLowerCase();
  const companyLower = (position.company || position.company_name || '').toLowerCase();
  
  // Title keyword matching (highest weight)
  for (const keyword of TITLE_KEYWORDS) {
    if (titleLower.includes(keyword)) {
      score += 25;
      matchedReasons.push(`Title contains "${keyword}"`);
    }
  }
  
  // Skills overlap (high weight)
  for (const skill of SKILL_KEYWORDS) {
    const skillLower = skill.toLowerCase();
    if (titleLower.includes(skillLower) || descriptionLower.includes(skillLower)) {
      score += 15;
      matchedReasons.push(`Skill match: "${skill}"`);
    }
  }
  
  // Location preference (bonus for Bangalore/India/Remote)
  if (locationLower.includes('bangalore') || 
      locationLower.includes('bangalore') ||
      locationLower.includes('india') ||
      locationLower.includes('remote') ||
      locationLower.includes('hybrid')) {
    score += 10;
    matchedReasons.push('Location matches preference');
  }
  
  // Seniority check (AVP level → mid-senior roles)
  const seniorityPatterns = [
    /lead|manager|senior/i,
    /director|head|vp|principal/i,
    /AVP|Vice President|SVP/i
  ];
  
  for (const pattern of seniorityPatterns) {
    if (pattern.test(titleLower)) {
      score += 5;
      matchedReasons.push('Seniority level match');
      break;
    }
  }
  
  // Fintech/Financial Services bonus
  if (companyLower.includes('fintech') || 
      companyLower.includes('bank') ||
      companyLower.includes('lending') ||
      companyLower.includes('finance') ||
      descriptionLower.includes('fintech') ||
      descriptionLower.includes('banking')) {
    score += 10;
    matchedReasons.push('Fintech/Financial services domain');
  }
  
  return { score, matchedReasons };
}

function isRelevantPosition(position) {
  const minScoreThreshold = 30;
  const { score } = calculateMatchScore(position);
  return score >= minScoreThreshold;
}

// ============ EMAIL SENDING ============
async function sendEmail(positions) {
  if (positions.length === 0) {
    log('No matching positions, skipping email');
    return false;
  }

  const nodemailer = require('nodemailer');
  
  log('Creating email transporter...');
  const transporter = nodemailer.createTransport({
    host: SMTP_CONFIG.host,
    port: SMTP_CONFIG.port,
    secure: SMTP_CONFIG.secure,
    auth: {
      user: SMTP_CONFIG.auth.user,
      pass: SMTP_CONFIG.auth.pass
    }
  });

  // Build email HTML
  const positionsHtml = positions.map((pos, i) => {
    const { score, matchedReasons } = calculateMatchScore(pos);
    return `
      <div style="border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin-bottom: 16px; background: #f9f9f9;">
        <h3 style="margin: 0 0 8px 0; color: #2c3e50;">
          ${i + 1}. ${escapeHtml(pos.title || 'Unknown Title')}
        </h3>
        <p style="margin: 4px 0; color: #555;">
          <strong>Company:</strong> ${escapeHtml(pos.company || pos.company_name || 'N/A')}
        </p>
        <p style="margin: 4px 0; color: #555;">
          <strong>Location:</strong> ${escapeHtml(pos.location || 'N/A')}
        </p>
        <p style="margin: 4px 0; color: #555;">
          <strong>Type:</strong> ${escapeHtml(pos.employment_type || 'N/A')}
        </p>
        <p style="margin: 4px 0; color: #555;">
          <strong>Match Score:</strong> <span style="color: #27ae60; font-weight: bold;">${score}/100</span>
        </p>
        <p style="margin: 4px 0; color: #666; font-size: 13px;">
          <strong>Why it matches:</strong> ${matchedReasons.slice(0, 5).join(', ')}
        </p>
        ${pos.url ? `<p style="margin: 8px 0 0 0;"><a href="${escapeHtml(pos.url)}" style="color: #3498db;">View Position →</a></p>` : ''}
      </div>
    `;
  }).join('');

  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>RealFast AI Job Alert</title>
    </head>
    <body style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 24px; border-radius: 12px 12px 0 0;">
        <h1 style="color: white; margin: 0;">🎯 RealFast AI Job Alert</h1>
        <p style="color: rgba(255,255,255,0.9); margin: 8px 0 0 0;">
          ${positions.length} new matching position${positions.length > 1 ? 's' : ''} found for Subhajit Das
        </p>
      </div>
      
      <div style="background: white; padding: 24px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 12px 12px;">
        <p style="color: #666; font-size: 14px;">
          Based on your profile: <strong>AVP Growth & Partnerships</strong> with 11 years in Fintech/Lending/Growth.
          Looking for: Growth, Strategy, Partnerships, AI, Product roles in Fintech.
        </p>
        
        <h2 style="color: #2c3e50; border-bottom: 2px solid #667eea; padding-bottom: 8px;">Matching Positions</h2>
        
        ${positionsHtml}
        
        <div style="margin-top: 24px; padding: 16px; background: #f0f4f8; border-radius: 8px;">
          <p style="margin: 0; color: #555; font-size: 13px;">
            <strong>Profile Summary:</strong><br>
            • 11 years in Fintech, Banking & Lending Growth<br>
            • Skills: LLM Orchestration, Multi-model Routing, Growth Marketing, CRM<br>
            • Location: Bangalore, India | Available: Immediately<br>
            • Open to: Remote, Hybrid opportunities
          </p>
        </div>
        
        <p style="margin-top: 24px; color: #999; font-size: 12px;">
          This alert was sent by the RealFast Job Alert Service running on GCP Cloud Run.
          To modify your profile or preferences, contact sdas22@gmail.com.
        </p>
      </div>
    </body>
    </html>
  `;

  const textContent = positions.map((pos, i) => {
    return `${i + 1}. ${pos.title}\n   Company: ${pos.company || 'N/A'}\n   Location: ${pos.location || 'N/A'}\n   URL: ${pos.url || 'N/A'}\n`;
  }).join('\n');

  try {
    const info = await transporter.sendMail({
      from: `"RealFast Job Alert" <${EMAIL_FROM}>`,
      to: EMAIL_TO,
      subject: `🎯 RealFast AI Alert: ${positions.length} New Matching Position${positions.length > 1 ? 's' : ''}`,
      text: textContent,
      html: emailHtml
    });

    log('Email sent successfully', { messageId: info.messageId });
    return true;
  } catch (error) {
    log('Email sending failed', { error: error.message });
    return false;
  }
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ============ POSITION STORAGE ============
function loadPreviousPositions() {
  try {
    if (fs.existsSync(PREVIOUS_POSITIONS_FILE)) {
      const data = fs.readFileSync(PREVIOUS_POSITIONS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    log('Error loading previous positions:', { error: error.message });
  }
  return { positions: [], lastCheck: null };
}

function savePositions(positions) {
  const data = {
    positions: positions.map(p => p.id || p.posting_id || JSON.stringify(p)),
    lastCheck: new Date().toISOString(),
    count: positions.length
  };
  fs.writeFileSync(PREVIOUS_POSITIONS_FILE, JSON.stringify(data, null, 2));
  log('Saved positions to tracking file', { count: positions.length });
}

function isNewPosition(position) {
  const prevData = loadPreviousPositions();
  const posId = position.id || position.posting_id;
  
  if (!posId) return true; // If no ID, consider it new
  
  const knownIds = prevData.positions.map(p => {
    try {
      return typeof p === 'string' ? JSON.parse(p).id : p.id;
    } catch {
      return p;
    }
  });
  
  return !knownIds.includes(posId);
}

// ============ MAIN EXECUTION ============
async function main() {
  log('========== RealFast Job Alert Service Starting ==========');
  const startTime = Date.now();
  
  try {
    // 1. Fetch all positions
    log('Step 1: Fetching positions from RealFast MCP...');
    const allPositions = await browsePositions();
    log(`Found ${allPositions.length} total positions`);
    
    if (allPositions.length === 0) {
      log('No positions returned, checking if MCP endpoint is accessible...');
      // Try direct fetch to verify endpoint
      const testResponse = await fetch(REALFAST_MCP_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': REALFAST_AUTH_TOKEN
        },
        body: JSON.stringify({ tool: 'browse_positions', args: {} })
      });
      log('MCP endpoint test', { status: testResponse.status });
    }
    
    // 2. Score and filter positions
    log('Step 2: Scoring positions against Subhajit profile...');
    const scoredPositions = allPositions
      .map(pos => {
        const { score, matchedReasons } = calculateMatchScore(pos);
        return { ...pos, matchScore: score, matchedReasons };
      })
      .filter(pos => pos.matchScore >= 30)
      .sort((a, b) => b.matchScore - a.matchScore);
    
    log(`Found ${scoredPositions.length} positions meeting threshold (score >= 30)`);
    
    // 3. Filter for truly new positions only
    const newPositions = scoredPositions.filter(pos => isNewPosition(pos));
    log(`Found ${newPositions.length} genuinely new positions (not in last run)`);
    
    // 4. Send email if new positions found
    if (newPositions.length > 0) {
      log('Step 3: Sending email alert...');
      const emailSent = await sendEmail(newPositions);
      
      if (emailSent) {
        log('✅ Email alert sent successfully');
      } else {
        log('⚠️ Email alert failed');
      }
    } else {
      log('No new matching positions since last check');
    }
    
    // 5. Always update position tracking (regardless of email)
    savePositions(allPositions);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`========== Completed in ${duration}s ==========`);
    
    // Exit with appropriate code
    process.exit(newPositions.length > 0 ? 0 : 0); // 0 = success regardless
    
  } catch (error) {
    log('Fatal error in main execution:', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(err => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
}

module.exports = { main, browsePositions, viewPosition, calculateMatchScore, isRelevantPosition };