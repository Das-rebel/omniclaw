/**
 * Hyperbrowser Client
 * 
 * AI-powered browser automation via Hyperbrowser API.
 * API Key: hb_5ee5c3a046d8e744beff563b0256
 * Docs: https://docs.hyperbrowser.ai
 * 
 * Usage:
 *   const { HyperbrowserClient } = require('./clients/hyperbrowser_client');
 *   const hb = new HyperbrowserClient();
 *   
 *   // Direct scrape (returns job ID, poll for result)
 *   const job = await hb.scrape('https://example.com', 'Extract content');
 *   
 *   // With session (full browser control)
 *   const session = await hb.createSession();
 *   await session.navigate('https://example.com');
 *   const content = await session.getContent();
 */

let SDK;
try {
  SDK = require('@hyperbrowser/sdk');
} catch (e) {
  try {
    SDK = require('/Users/Subho/.pi/agent/npm/node_modules/@hyperbrowser/sdk');
  } catch (e2) {
    console.warn('⚠️ Hyperbrowser SDK not installed. Run: npm install @hyperbrowser/sdk');
  }
}

const HyperbrowserClient = SDK?.HyperbrowserClient;

module.exports = { HyperbrowserClient };
