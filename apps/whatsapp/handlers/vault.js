/**
 * Vault Handler - Knowledge graph search
 */
const { send, httpGet } = require('./base');

async function handleVault(phone, text, deps = {}) {
  const { searchVault, buildVaultResult, extractKeywords, getVaultUrls, trackInterest } = deps;
  const query = text.replace(/^\/vault\s*/i, '').trim();
  
  if (!query) {
    return send(phone, '🔍 *Vault Search*\n\n/vault <keyword> - Search your knowledge graph\nExample: /vault AI agents\n\nWorks with both keywords and natural language.');
  }
  if (query.length < 2) return send(phone, 'Query too short. Try /vault <keyword>');

  if (trackInterest) trackInterest(phone, query, 'search');
  let result = await searchVault(query);

  // Tag drill-down
  if (result && result.isTagView) {
    const tags = result.tags || {};
    const sorted = Object.entries(tags).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return send(phone, '🏷 No tags found for "' + query + '".');
    const tagLines = ['🏷 *Tags in "' + result.query + '"*\n'];
    for (const [tag, count] of sorted.slice(0, 20)) {
      tagLines.push('· ' + tag + ' (' + count + ')');
    }
    return send(phone, tagLines.join('\n'));
  }

  let items = result && result.results ? result.results : [];
  
  // Fallback to broader queries
  if (items.length < 3 && extractKeywords) {
    const keywords = extractKeywords(query);
    if (keywords.length > 0) {
      const combined = keywords.join(' ');
      const altResult = await searchVault(combined);
      let altItems = altResult && altResult.results ? altResult.results : [];
      
      if (altItems.length === 0 && keywords.length > 1) {
        for (const kw of keywords) {
          const kwRes = await searchVault(kw);
          const kwItems = kwRes && kwRes.results ? kwRes.results : [];
          altItems.push(...kwItems);
        }
      }
      
      const seenIds = new Set(items.map(i => i.id));
      for (const item of altItems) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          items.push(item);
        }
      }
      result.total = items.length;
      result.results = items;
    }
  }

  if (!items.length) {
    const isQuestion = /^(find|suggest|recommend|what|how|why|best|ideas|give me|tell me|list|top|create|generate)(\s|$)/i.test(query);
    if (isQuestion) {
      return deps.handleAgent ? deps.handleAgent(phone, '/ask ' + query) : null;
    }
    return send(phone, '❌ No results for "' + query + '".\n\nTry a broader keyword.');
  }

  // Filter valid items
  const validItems = items.filter(item => (item.source || item.type) !== 'entity' && !!item.url);
  if (!validItems.length) {
    return send(phone, '❌ No content results for "' + query + '".');
  }

  // Header
  let headerLine = '🔍 *Vault Search:* "' + result.query + '"\n📊 ' + result.total + ' results';
  await send(phone, headerLine);

  // Send results in batches
  const BATCH_SIZE = 5;
  for (let i = 0; i < Math.min(items.length, 10); i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    try {
      const batchText = batch.map((item, j) => buildVaultResult(item, i + j)).join('\n\n');
      await send(phone, batchText);
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error('❌ Vault batch error: ' + e.message);
    }
  }

  if (result.total > 10) {
    await send(phone, '📋 +' + (result.total - 10) + ' more results. Try a more specific query.');
  }
}

module.exports = { handleVault };
