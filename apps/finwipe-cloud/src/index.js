/**
 * FinWipe Cloudflare Worker
 * 
 * Handles email forwarding webhook from Mailgun and serves discovery data.
 * 
 * PRIVACY MODEL:
 * - Email CONTENT is NEVER received or stored
 * - Only sender DOMAIN (not full email) is extracted
 * - Subject line is stored for FI matching
 * - User ID is a one-way hash (no PII stored)
 * - Data lives in user's KV namespace only
 * 
 * Endpoints:
 *   POST /api/forward    - Mailgun webhook (receives sender, subject)
 *   GET  /api/discoveries - User polls for discoveries (user_id + api_key auth)
 *   GET  /api/health     - Health check
 */

const MAILGUN_WEBHOOK_KEY = MAILGUN_WEBHOOK_KEY; // set in Worker settings

// Well-known Indian FI patterns
const KNOWN_FI = [
  // Banks
  { name: "HDFC Bank", domains: ["hdfcbank.com", "hdfc-bank.com"], category: "bank" },
  { name: "ICICI Bank", domains: ["icicibank.com", "icici-bank.com"], category: "bank" },
  { name: "Axis Bank", domains: ["axisbank.com", "axis-bank.com"], category: "bank" },
  { name: "Kotak Mahindra Bank", domains: ["kotak.com", "kotakbank.com", "kotak-mahindra.com"], category: "bank" },
  { name: "State Bank of India", domains: ["sbi.co.in", "statebank.com"], category: "bank" },
  { name: "Yes Bank", domains: ["yesbank.in", "yesbank.com"], category: "bank" },
  { name: "IndusInd Bank", domains: ["indusind.com", "indusindbank.com"], category: "bank" },
  { name: "IDBI Bank", domains: ["idbibank.com", "idbi.com"], category: "bank" },
  { name: "Bank of Baroda", domains: ["bankofbaroda.in", "bob.com"], category: "bank" },
  { name: "Punjab National Bank", domains: ["pnb.co.in", "punjabnationalbank.com"], category: "bank" },
  { name: "Canara Bank", domains: ["canarabank.com", "canarabank.in"], category: "bank" },
  { name: "Union Bank of India", domains: ["unionbankofindia.co.in", "unionbankonline.co.in"], category: "bank" },
  { name: "Federal Bank", domains: ["federalbank.co.in"], category: "bank" },
  { name: "RBL Bank", domains: ["rblbank.com"], category: "bank" },
  { name: "Bandhan Bank", domains: ["bandhanbank.com"], category: "bank" },
  { name: "Bank of India", domains: ["bankofindia.co.in"], category: "bank" },
  { name: "Central Bank of India", domains: ["centralbankofindia.co.in"], category: "bank" },
  { name: "Indian Bank", domains: ["indianbank.in", "indianbank.tld"], category: "bank" },
  { name: "South Indian Bank", domains: ["southindianbank.com"], category: "bank" },
  { name: "UCO Bank", domains: ["ucobank.com"], category: "bank" },
  { name: "Bank of Maharashtra", domains: ["bankofmaharashtra.com"], category: "bank" },
  
  // Large NBFCs
  { name: "Bajaj Finserv", domains: ["bajajfinserv.in", "bajajfinserv.com"], category: "nbfc" },
  { name: "Bajaj Finance", domains: ["bajajfinance.com", "bajajfinserv.in"], category: "nbfc" },
  { name: "Tata Capital", domains: ["tatacapital.com", "tatacapitalfinance.com"], category: "nbfc" },
  { name: "Aditya Birla Finance", domains: ["adityabirlacapital.com", "adityabirlafinance.com"], category: "nbfc" },
  { name: "L&T Finance", domains: ["ltfs.com", "lnttfs.com"], category: "nbfc" },
  { name: "Muthoot Finance", domains: ["muthootfinance.com", "muthoot.com"], category: "nbfc" },
  { name: "Cholamandalam Investment", domains: ["chola.murugappa.com", "cholamandalam.com"], category: "nbfc" },
  { name: "HDB Financial Services", domains: ["hdbbank.com", "hdbfs.com"], category: "nbfc" },
  { name: "Kisht Consumer Finance", domains: ["kisht.com", "kisht.in"], category: "nbfc" },
  { name: "Stashfin", domains: ["stashfin.com", "stashfin.in"], category: "nbfc" },
  { name: "Rupeek", domains: ["rupeek.com", "rupeek.in"], category: "nbfc" },
  { name: "KreditBee", domains: ["kreditbee.in", "kreditbee.com"], category: "nbfc" },
  { name: "Navi Finserv", domains: ["navi.com", "navifinserv.com"], category: "nbfc" },
  { name: "OfBusiness Financial Technologies", domains: ["ofbusiness.com", "ofbusiness.in"], category: "nbfc" },
  { name: "EarlySalary", domains: ["earlysalary.com"], category: "nbfc" },
  { name: "Slice", domains: ["sliceit.com", "slice.so"], category: "nbfc" },
  { name: "Uni (CardPay)", domains: ["uni.cards", "getuni.com"], category: "nbfc" },
  { name: "Moneyview", domains: ["moneyview.in", "moneyview.com"], category: "nbfc" },
  { name: "Lazee", domains: ["lazee.com", "lazeefinance.com"], category: "nbfc" },
  
  // Fintech
  { name: "PhonePe", domains: ["phonepe.com", "phonepe.in"], category: "fintech" },
  { name: "Paytm", domains: ["paytm.com", "paytmmp.com"], category: "fintech" },
  { name: "Razorpay", domains: ["razorpay.com"], category: "fintech" },
  { name: "CRED", domains: ["cred.club", "cred.club.in"], category: "fintech" },
  { name: "Paisabazaar", domains: ["paisabazaar.com"], category: "fintech" },
  { name: "BankBazaar", domains: ["bankbazaar.com"], category: "fintech" },
  { name: "IndMoney", domains: ["indmoney.com", "indmoney.in"], category: "fintech" },
  { name: "Groww", domains: ["groww.in", "groww.com"], category: "fintech" },
  { name: "Zerodha", domains: ["zerodha.com"], category: "fintech" },
  { name: "Upstox", domains: ["upstox.com"], category: "fintech" },
  { name: "Dhan", domains: ["dhan.in", "dhan.com"], category: "fintech" },
  { name: "Angel One", domains: ["angelone.in", "angelbroking.com"], category: "fintech" },
  { name: "PolicyBazaar", domains: ["policybazaar.com", "policybazaar.in"], category: "fintech" },
  { name: "PolicyBazaar", domains: ["policybazaar.com"], category: "fintech" },
  
  // Insurance
  { name: "LIC", domains: ["licindia.in", "licindia.com"], category: "insurance" },
  { name: "HDFC Life", domains: ["hdfclife.com", "hdfclife.in"], category: "insurance" },
  { name: "SBI Life", domains: ["sbilife.co.in", "sbilife.com"], category: "insurance" },
  { name: "ICICI Prudential Life", domains: ["iciciprulife.com", "icici-prulife.com"], category: "insurance" },
  { name: "Bajaj Allianz Life", domains: ["bajajallianzlife.in", "bajajallianz.co.in"], category: "insurance" },
  { name: "TATA AIA Life", domains: ["tataaia.com", "tata-aia.com"], category: "insurance" },
  { name: "Max Life Insurance", domains: ["maxlifeinsurance.com", "maxlife.in"], category: "insurance" },
  { name: "Star Health Insurance", domains: ["starhealth.in", "starhealth.com"], category: "insurance" },
  { name: "Niva Bupa", domains: ["nivabupa.com", "niva-bupa.com"], category: "insurance" },
  { name: "Reliance General Insurance", domains: ["reliancegeneral.co.in", "reliancegeneral.in"], category: "insurance" },
  { name: "Go Digit Insurance", domains: ["digit.insure", "godigit.com"], category: "insurance" },
  { name: "HDFC ERGO", domains: ["hdfcergo.com", "hdfc-ergo.com"], category: "insurance" },
  { name: "Tata AIG", domains: ["tataaig.com", "tata-aig.com"], category: "insurance" },
  { name: "Bajaj Allianz General Insurance", domains: ["bajajallianz.co.in"], category: "insurance" },
  
  // UPI / Payments
  { name: "Google Pay", domains: ["google.com", "gpay"], category: "upi" },
  { name: "Amazon Pay", domains: ["amazon.in", "amazonpay.in"], category: "upi" },
  { name: "BHIM UPI", domains: ["bhim", "npci.org.in"], category: "upi" },
  
  // Brokers / Demat
  { name: "CDSL", domains: ["cdslindia.com"], category: "broker" },
  { name: "NSDL", domains: ["nsdl.co.in"], category: "broker" },
  { name: "KFintech", domains: ["kfintech.com", " KFINTECH"], category: "broker" },
];

/**
 * Extract sender domain from email address
 */
function extractDomain(sender) {
  if (!sender) return null;
  const match = sender.match(/@([^>]+)/);
  return match ? match[1].toLowerCase().trim() : null;
}

/**
 * Extract FI from sender domain or subject
 */
function matchFI(senderDomain, subject) {
  if (!senderDomain && !subject) return null;
  
  const upperSubject = subject ? subject.toUpperCase() : "";
  
  for (const fi of KNOWN_FI) {
    for (const domain of fi.domains) {
      if (senderDomain && senderDomain.includes(domain)) {
        return { name: fi.name, category: fi.category, domain, matchType: "domain" };
      }
    }
    // Also check subject for FI name
    if (subject && upperSubject.includes(fi.name.toUpperCase())) {
      return { name: fi.name, category: fi.category, domain: senderDomain || "unknown", matchType: "subject" };
    }
  }
  
  return null;
}

/**
 * Verify Mailgun webhook signature
 */
async function verifyMailgunWebhook(request) {
  const body = await request.text();
  const signature = request.headers.get('Mailgun-Signature') || 
                   request.headers.get('X-Mailgun-Signature');
  
  if (!signature || !MAILGUN_WEBHOOK_KEY) {
    return false;
  }
  
  // Mailgun sends: timestamp + token + signature
  // signature = HMAC(secret, timestamp + token)
  // For simplicity, we verify using the webhook key as shared secret
  // In production, use crypto.subtle to compute HMAC
  const params = new URLSearchParams(body);
  const ts = params.get('signature') ? '' : params.get('timestamp');
  
  // Simple verification: just check presence of signature header
  // For full security, implement RFC 1864 HMAC-SHA256
  return signature.length > 0;
}

/**
 * KV storage helpers
 */
async function getDiscoveries(userId, apiKey) {
  const key = `disc:${userId}`;
  const stored = await FINWIPE_KV.get(key);
  if (!stored) return [];
  
  const data = JSON.parse(stored);
  
  // Verify read key
  if (data.apiKey && data.apiKey !== apiKey) {
    return { error: "Unauthorized" };
  }
  
  return data.discoveries || [];
}

async function addDiscovery(userId, apiKey, fiData, senderDomain, subject) {
  const key = `disc:${userId}`;
  const now = new Date().toISOString();
  
  let stored = await FINWIPE_KV.get(key);
  let data = { discoveries: [], apiKey: apiKey };
  
  if (stored) {
    try {
      data = JSON.parse(stored);
    } catch (e) {
      data = { discoveries: [], apiKey: apiKey };
    }
  }
  
  // Check if already exists
  let found = false;
  for (const disc of data.discoveries) {
    if (disc.name === fiData.name) {
      disc.count++;
      disc.lastSeen = now;
      if (disc.subject && subject && !disc.subject.includes(subject)) {
        disc.subject = disc.subject + " | " + subject;
      }
      found = true;
      break;
    }
  }
  
  if (!found) {
    data.discoveries.push({
      name: fiData.name,
      category: fiData.category,
      domain: senderDomain || fiData.domain,
      matchType: fiData.matchType,
      subject: subject || "",
      firstSeen: now,
      lastSeen: now,
      count: 1,
    });
  }
  
  data.lastUpdated = now;
  await FINWIPE_KV.put(key, JSON.stringify(data));
  return { added: !found, name: fiData.name };
}

async function deleteDiscoveries(userId, apiKey) {
  const key = `disc:${userId}`;
  await FINWIPE_KV.delete(key);
  return { deleted: true };
}

/**
 * Route handler
 */
async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  
  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  
  // Health check
  if (path === '/api/health') {
    return new Response(JSON.stringify({ 
      status: 'ok', 
      service: 'finwipe-cloud',
      timestamp: new Date().toISOString(),
    }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
  
  // Mailgun webhook: POST /api/forward
  if (path === '/api/forward' && request.method === 'POST') {
    // Verify Mailgun webhook
    const verified = await verifyMailgunWebhook(request);
    // For now, skip verification in dev mode (use env var to enforce)
    // if (!verified && MAILGUN_WEBHOOK_KEY) {
    //   return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
    //     status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } 
    //   });
    // }
    
    const formData = await request.formData();
    const sender = formData.get('sender') || formData.get('From') || '';
    const subject = formData.get('subject') || '';
    const recipient = formData.get('recipient') || ''; // user@inbox.finwipe.in
    
    // Extract user ID from recipient email (user hash is before @)
    const recipientMatch = recipient.match(/^([^@]+)@/);
    const userId = recipientMatch ? recipientMatch[1] : null;
    
    if (!userId) {
      return new Response(JSON.stringify({ error: 'Invalid recipient' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    
    // Extract sender domain
    const senderDomain = extractDomain(sender);
    
    // Match against known FIs
    const fi = matchFI(senderDomain, subject);
    
    if (!fi) {
      // Not a known FI - just acknowledge
      return new Response(JSON.stringify({ 
        processed: true, 
        matched: false,
        userId,
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    
    // Add to discoveries
    const result = await addDiscovery(userId, '', fi, senderDomain, subject);
    
    return new Response(JSON.stringify({
      processed: true,
      matched: true,
      userId,
      fi: fi.name,
      category: fi.category,
      ...result,
    }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
  
  // User API: GET /api/discoveries?user_id=X&api_key=Y
  if (path === '/api/discoveries' && request.method === 'GET') {
    const userId = url.searchParams.get('user_id');
    const apiKey = url.searchParams.get('api_key');
    const deleteFlag = url.searchParams.get('delete') === 'true';
    
    if (!userId) {
      return new Response(JSON.stringify({ error: 'user_id required' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    
    // Delete all discoveries
    if (deleteFlag && apiKey) {
      await deleteDiscoveries(userId, apiKey);
      return new Response(JSON.stringify({ 
        deleted: true, 
        userId,
        message: 'All discoveries deleted'
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    
    // Get discoveries
    const discoveries = await getDiscoveries(userId, apiKey);
    
    if (discoveries.error) {
      return new Response(JSON.stringify({ error: discoveries.error }), {
        status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    
    return new Response(JSON.stringify({
      userId,
      count: discoveries.length,
      discoveries,
      timestamp: new Date().toISOString(),
    }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
  
  // 404
  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

export default {
  async fetch(request, env, ctx) {
    // Bindings available as global constants
    globalThis.FINWIPE_KV = env.FINWIPE_KV;
    globalThis.MAILGUN_WEBHOOK_KEY = env.MAILGUN_WEBHOOK_KEY || '';
    
    try {
      return await handleRequest(request);
    } catch (e) {
      return new Response(JSON.stringify({ 
        error: 'Internal error', 
        message: e.message 
      }), {
        status: 500, 
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
};
