#!/usr/bin/env node
/**
 * GreenAPI CLI - send WhatsApp messages via GreenAPI REST API.
 * 
 * Usage:
 *   node whatsapp-greenapi.js send <jid> <message>
 *   node whatsapp-greenapi.js status
 * 
 * Environment:
 *   GREENAPI_INSTANCE  - GreenAPI instance ID (default: from .env)
 *   GREENAPI_TOKEN    - GreenAPI token (default: from .env)
 */

const fs = require('fs');
const path = require('path');

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && v.length) process.env[k.trim()] = v.join('=').trim();
  });
}

const INSTANCE = process.env.GREENAPI_INSTANCE || '7107630227';
const TOKEN = process.env.GREENAPI_TOKEN || 'f9e7484d874043239fc97bbe3cfcef23660f6dc83a504591ae';
const BASE_URL = `https://${INSTANCE.slice(0, 4)}.api.greenapi.com`;

async function request(method, endpoint, payload) {
  const res = await fetch(`${BASE_URL}/waInstance${INSTANCE}/${endpoint}/${TOKEN}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || data?.message || res.statusText);
  return data;
}

async function send(jid, message) {
  if (!jid || !message) {
    console.error('Usage: node whatsapp-greenapi.js send <jid> <message>');
    process.exit(1);
  }
  // Normalize JID
  jid = jid.includes('@') ? jid : `${jid}@c.us`;
  const result = await request('POST', 'sendMessage', { chatId: jid, message });
  if (result.idMessage) {
    console.log(`✅ Sent to ${jid}: ${result.idMessage}`);
    return 0;
  }
  console.error('❌ Failed:', JSON.stringify(result));
  return 1;
}

async function status() {
  const result = await request('GET', 'getStateInstance', null);
  console.log(JSON.stringify(result, null, 2));
  return result.stateInstance === 'authorized' ? 0 : 1;
}

async function main() {
  const [,, cmd, ...args] = process.argv;
  try {
    const exitCode = cmd === 'send' ? await send(args[0], args.slice(1).join(' '))
      : cmd === 'status' ? await status()
      : (console.error('Usage: whatsapp-greenapi.js send <jid> <message>'), 1);
    process.exit(exitCode);
  } catch (e) {
    console.error('❌ Error:', e.message);
    process.exit(1);
  }
}

main();
