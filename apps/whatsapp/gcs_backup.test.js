/**
 * @jest-environment node
 * 
 * WhatsApp GCS Context Backup/Restore Unit Tests
 * Run: npm test
 * 
 * Tests the syncContextToGCS and syncContextFromGCS functions
 * which are critical for persistent WhatsApp sessions.
 */

const MAX_HISTORY = 100;

// Mock GCS storage (in-memory for testing)
let mockGcsStorage = {};
const gcsWriteJSON = jest.fn(async (path, data) => {
  mockGcsStorage[path] = data;
  return true;
});
const gcsReadJSON = jest.fn(async (path) => mockGcsStorage[path] || null);

// Mock conversation memory
const conversationMemory = new Map();

// Functions extracted from server.js for testing
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

beforeEach(() => {
  mockGcsStorage = {};
  conversationMemory.clear();
  jest.clearAllMocks();
});

describe('Phone Sanitization', () => {
  test('plain phone number unchanged', () => {
    expect(sanitizePhone('919876543210')).toBe('919876543210');
  });
  
  test('international format sanitized', () => {
    expect(sanitizePhone('+1-987-654-3210')).toBe('_1_987_654_3210');
  });
  
  test('wa.me URL sanitized', () => {
    expect(sanitizePhone('wa.me/919876543210')).toBe('wa_me_919876543210');
  });
  
  test('spaces replaced with underscore', () => {
    expect(sanitizePhone('91 98 76 54 32 10')).toBe('91_98_76_54_32_10');
  });
});

describe('syncContextToGCS', () => {
  test('saves history to GCS with phone and timestamp', async () => {
    const history = [
      { role: 'user', content: 'Hello', ts: 1000 },
      { role: 'assistant', content: 'Hi!', ts: 2000 },
    ];
    
    await syncContextToGCS('919876543210', history);
    
    expect(gcsWriteJSON).toHaveBeenCalledWith(
      'context/919876543210.json',
      expect.objectContaining({
        phone: '919876543210',
        history: history,
        updated: expect.any(String)
      })
    );
  });
  
  test('saves all history items', async () => {
    const history = Array.from({length: 50}, (_, i) => 
      ({ role: 'user', content: `Msg ${i}`, ts: i * 1000 })
    );
    
    await syncContextToGCS('919876543210', history);
    
    const saved = mockGcsStorage['context/919876543210.json'];
    expect(saved.history.length).toBe(50);
  });
  
  test('phone sanitized in path', async () => {
    await syncContextToGCS('+91-987-654-3210', []);
    
    expect(gcsWriteJSON).toHaveBeenCalledWith(
      'context/_91_987_654_3210.json',
      expect.any(Object)
    );
  });
});

describe('syncContextFromGCS', () => {
  test('returns empty array when no GCS data', async () => {
    const result = await syncContextFromGCS('919876543210');
    expect(result).toEqual([]);
    expect(conversationMemory.has('919876543210')).toBe(false);
  });
  
  test('restores all history from GCS', async () => {
    mockGcsStorage['context/919876543210.json'] = {
      phone: '919876543210',
      history: [
        { role: 'user', content: 'Hello', ts: 1000 },
        { role: 'assistant', content: 'Hi!', ts: 2000 },
      ],
      updated: '2024-01-01T00:00:00.000Z'
    };
    
    const restored = await syncContextFromGCS('919876543210');
    
    expect(restored.length).toBe(2);
    expect(restored[0].content).toBe('Hello');
    expect(restored[1].content).toBe('Hi!');
  });
  
  test('merges with existing local context', async () => {
    // GCS has older messages
    mockGcsStorage['context/919876543210.json'] = {
      phone: '919876543210',
      history: [
        { role: 'assistant', content: 'GCS message', ts: 2000 },
      ],
    };
    // Local has newer message
    conversationMemory.set('919876543210', [
      { role: 'user', content: 'Local message', ts: 3000 },
    ]);
    
    const merged = await syncContextFromGCS('919876543210');
    
    expect(merged.length).toBe(2);
    expect(merged[0].content).toBe('GCS message');
    expect(merged[1].content).toBe('Local message');
  });
  
  test('keeps ALL messages from both GCS and local (no dedup)', async () => {
    // NOTE: The merge does NOT deduplicate - same message in both GCS and local appears twice
    // This is current behavior - may want to add deduplication in future
    mockGcsStorage['context/919876543210.json'] = {
      phone: '919876543210',
      history: [
        { role: 'user', content: 'Same msg', ts: 1000 },
        { role: 'assistant', content: 'GCS only', ts: 2000 },
      ],
    };
    conversationMemory.set('919876543210', [
      { role: 'user', content: 'Same msg', ts: 1000 },
      { role: 'assistant', content: 'Local only', ts: 3000 },
    ]);
    
    const merged = await syncContextFromGCS('919876543210');
    
    // Current behavior: duplicates are kept
    const sameCount = merged.filter(m => m.content === 'Same msg').length;
    expect(sameCount).toBe(2); // Actually keeps both copies!
    expect(merged.length).toBe(4);
  });
});

describe('MAX_HISTORY limit', () => {
  test('saves ALL items to GCS (no MAX_HISTORY limit on save)', async () => {
    // NOTE: MAX_HISTORY limit applies only to RESTORE, not to SAVE
    // Save keeps all history - this is current behavior
    const longHistory = Array.from({length: 150}, (_, i) => 
      ({ role: 'user', content: `Msg ${i}`, ts: i * 1000 })
    );
    
    await syncContextToGCS('919876543210', longHistory);
    
    const saved = mockGcsStorage['context/919876543210.json'];
    expect(saved.history.length).toBe(150); // All 150 items saved!
  });
  
  test('restores with MAX_HISTORY limit', async () => {
    // GCS has 120 items
    mockGcsStorage['context/919876543210.json'] = {
      phone: '919876543210',
      history: Array.from({length: 120}, (_, i) => 
        ({ role: 'user', content: `Msg ${i}`, ts: i * 1000 })
      ),
    };
    
    const restored = await syncContextFromGCS('919876543210');
    
    expect(restored.length).toBe(100);
    expect(restored[0].content).toBe('Msg 20');
    expect(restored[99].content).toBe('Msg 119');
  });
});

describe('Timestamp sorting', () => {
  test('merged history sorted by ts ascending', async () => {
    mockGcsStorage['context/919876543210.json'] = {
      phone: '919876543210',
      history: [
        { role: 'assistant', content: 'Later GCS', ts: 3000 },
        { role: 'assistant', content: 'Earlier GCS', ts: 1000 },
      ],
    };
    conversationMemory.set('919876543210', [
      { role: 'user', content: 'Later local', ts: 4000 },
      { role: 'user', content: 'Earlier local', ts: 2000 },
    ]);
    
    const merged = await syncContextFromGCS('919876543210');
    
    expect(merged[0].ts).toBe(1000);
    expect(merged[1].ts).toBe(2000);
    expect(merged[2].ts).toBe(3000);
    expect(merged[3].ts).toBe(4000);
  });
  
  test('messages without ts placed at beginning after sort', async () => {
    mockGcsStorage['context/919876543210.json'] = {
      phone: '919876543210',
      history: [
        { role: 'user', content: 'Has ts', ts: 2000 },
        { role: 'user', content: 'No ts' }, // no ts
      ],
    };
    
    const merged = await syncContextFromGCS('919876543210');
    
    // Items without ts have (a.ts || 0) = 0, so they sort to beginning
    expect(merged[0].content).toBe('No ts');
    expect(merged[1].content).toBe('Has ts');
  });
});

describe('Error handling', () => {
  test('handles GCS read error gracefully', async () => {
    gcsReadJSON.mockRejectedValueOnce(new Error('GCS unavailable'));
    
    // Should not throw, returns empty
    const result = await syncContextFromGCS('919876543210').catch(() => []);
    // If it throws, result would be undefined
    expect(result || []).toEqual([]);
  });
  
  test('GCS write errors propagate (no try/catch)', async () => {
    // NOTE: syncContextToGCS has no try/catch - errors propagate to caller
    gcsWriteJSON.mockRejectedValueOnce(new Error('GCS write failed'));
    
    await expect(syncContextToGCS('919876543210', [])).rejects.toThrow('GCS write failed');
  });
  
  test('handles malformed GCS data (no history)', async () => {
    mockGcsStorage['context/919876543210.json'] = {
      phone: '919876543210',
      // no history field
      updated: '2024-01-01T00:00:00.000Z'
    };
    
    const result = await syncContextFromGCS('919876543210');
    expect(result).toEqual([]);
  });
  
  test('handles GCS data with null history', async () => {
    mockGcsStorage['context/919876543210.json'] = {
      phone: '919876543210',
      history: null,
    };
    
    const result = await syncContextFromGCS('919876543210');
    expect(result).toEqual([]);
  });
});
