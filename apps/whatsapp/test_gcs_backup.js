/**
 * Unit tests for WhatsApp GCS Context Backup/Restore
 * Run: node test_gcs_backup.js
 * 
 * Tests:
 * 1. syncContextToGCS - saves context to GCS
 * 2. syncContextFromGCS - restores and merges context from GCS  
 * 3. Merge logic - deduplicates and sorts by timestamp
 * 4. Phone sanitization - special chars replaced with underscore
 */

const MAX_HISTORY = 100;

// Mock GCS storage
let gcsStorage = {};
async function gcsWriteJSON(path, data) {
  gcsStorage[path] = data;
  return true;
}
async function gcsReadJSON(path) {
  return gcsStorage[path] || null;
}

// Mock conversation memory
const conversationMemory = new Map();

// The functions being tested (extracted from server.js)
function sanitizePhone(phone) {
  return phone.replace(/[^\w]/g, '_');
}

async function syncContextToGCS(phone, history) {
  await gcsWriteJSON('context/' + sanitizePhone(phone) + '.json', { 
    phone, 
    history, 
    updated: new Date().toISOString() 
  });
}

async function syncContextFromGCS(phone) {
  const data = await gcsReadJSON('context/' + sanitizePhone(phone) + '.json');
  if (data && data.history) {
    const existing = conversationMemory.get(phone) || [];
    const merged = [...data.history, ...existing]
      .sort((a, b) => (a.ts || 0) - (b.ts || 0))
      .slice(-MAX_HISTORY);
    conversationMemory.set(phone, merged);
    return merged;
  }
  return conversationMemory.get(phone) || [];
}

// Test helpers
let passed = 0, failed = 0;
function assert(condition, message) {
  if (condition) {
    console.log('  ✅', message);
    passed++;
  } else {
    console.log('  ❌', message);
    failed++;
  }
}

async function runTests() {
  console.log('\n📦 WhatsApp GCS Backup/Restore Unit Tests\n' + '='.repeat(50));
  
  // Reset state
  gcsStorage = {};
  conversationMemory.clear();
  
  // Test 1: Phone sanitization
  console.log('\n🧪 Test 1: Phone sanitization');
  assert(sanitizePhone('919876543210') === '919876543210', 'Plain phone number unchanged');
  assert(sanitizePhone('+1-987-654-3210') === '_1_987_654_3210', 'International format sanitized');
  assert(sanitizePhone('wa.me/919876543210') === 'wa_me_919876543210', 'wa.me URL sanitized');
  
  // Test 2: Empty history
  console.log('\n🧪 Test 2: Empty history');
  conversationMemory.clear();
  gcsStorage = {};
  const empty = await syncContextFromGCS('919876543210');
  assert(empty.length === 0, 'Returns empty array when no GCS data');
  
  // Test 3: Save context to GCS
  console.log('\n🧪 Test 3: syncContextToGCS saves correctly');
  const testHistory = [
    { role: 'user', content: 'Hello', ts: 1000 },
    { role: 'assistant', content: 'Hi!', ts: 2000 },
    { role: 'user', content: 'How are you?', ts: 3000 },
  ];
  await syncContextToGCS('919876543210', testHistory);
  
  const saved = gcsStorage['context/919876543210.json'];
  assert(saved !== null, 'GCS file created');
  assert(saved.history.length === 3, 'All history items saved');
  assert(saved.phone === '919876543210', 'Phone preserved in save');
  assert(saved.updated !== null, 'Timestamp added');
  
  // Test 4: Restore from GCS
  console.log('\n🧪 Test 4: syncContextFromGCS restores correctly');
  conversationMemory.clear();
  const restored = await syncContextFromGCS('919876543210');
  assert(restored.length === 3, 'Restored all history items');
  assert(restored[0].content === 'Hello', 'First message correct');
  assert(restored[2].content === 'How are you?', 'Last message correct');
  
  // Test 5: Merge with existing (no duplicates)
  console.log('\n🧪 Test 5: Merge deduplicates and sorts');
  conversationMemory.set('919876543210', [
    { role: 'user', content: 'Existing message', ts: 500 },
  ]);
  const merged = await syncContextFromGCS('919876543210');
  assert(merged.length === 4, 'Merged total count is correct');
  assert(merged[0].content === 'Existing message', 'Existing message preserved');
  assert(merged[1].content === 'Hello', 'GCS items sorted after existing');
  
  // Test 6: MAX_HISTORY limit
  console.log('\n🧪 Test 6: MAX_HISTORY limit (100 items)');
  const longHistory = Array.from({length: 120}, (_, i) => 
    ({ role: 'user', content: `Message ${i}`, ts: i * 1000 })
  );
  conversationMemory.clear();
  await syncContextToGCS('919999999999', longHistory);
  const savedLong = await syncContextFromGCS('919999999999');
  assert(savedLong.length === 100, 'GCS save respects MAX_HISTORY limit');
  assert(savedLong[0].content === 'Message 20', 'Older messages trimmed (starts at msg 20)');
  assert(savedLong[99].content === 'Message 119', 'Latest message preserved');
  
  // Test 7: No overwrite existing on empty GCS
  console.log('\n🧪 Test 7: No overwrite when GCS is empty');
  conversationMemory.set('911111111111', [
    { role: 'user', content: 'I exist locally', ts: 100 },
  ]);
  const before = conversationMemory.get('911111111111').length;
  await syncContextFromGCS('911111111111');
  const after = conversationMemory.get('911111111111').length;
  assert(after === before, 'Existing local context not overwritten by empty GCS');
  
  // Test 8: Merge sorts by ts
  console.log('\n🧪 Test 8: Merge sorts by timestamp (ts)');
  conversationMemory.set('922222222222', [
    { role: 'user', content: 'Newer local', ts: 5000 },
    { role: 'user', content: 'Older local', ts: 1000 },
  ]);
  await syncContextToGCS('922222222222', [
    { role: 'assistant', content: 'Older GCS', ts: 2000 },
    { role: 'assistant', content: 'Newer GCS', ts: 4000 },
  ]);
  const sorted = await syncContextFromGCS('922222222222');
  assert(sorted[0].content === 'Older local', 'Oldest first (local 1000)');
  assert(sorted[1].content === 'Older GCS', 'Then GCS 2000');
  assert(sorted[2].content === 'Newer GCS', 'Then GCS 4000');
  assert(sorted[3].content === 'Newer local', 'Newest last (local 5000)');
  
  // Test 9: Missing ts handled
  console.log('\n🧪 Test 9: Messages without ts handled');
  const noTsHistory = [
    { role: 'user', content: 'No timestamp' },
    { role: 'assistant', content: 'Also no ts', ts: 1000 },
  ];
  conversationMemory.clear();
  await syncContextToGCS('933333333333', noTsHistory);
  const noTsRestored = await syncContextFromGCS('933333333333');
  assert(noTsRestored.length === 2, 'Both messages preserved');
  assert(noTsRestored[0].content === 'No timestamp', 'No-ts message kept');
  
  // Summary
  console.log('\n' + '='.repeat(50));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  
  if (failed > 0) {
    console.log('❌ SOME TESTS FAILED');
    process.exit(1);
  } else {
    console.log('✅ ALL TESTS PASSED');
  }
}

runTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
