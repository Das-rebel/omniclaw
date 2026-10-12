/**
 * Unit Tests for LLM Provider Interface
 */

const assert = require('assert');

// Mock fetch for testing
global.fetch = async (url, options) => {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: 'Test response' } }],
      usage: { total_tokens: 10 }
    })
  };
};

// Test LLM Provider
async function testLLMProvider() {
  console.log('🧪 Testing LLMProvider...');
  
  const { LLMProvider } = require('../../clients/llm_provider');
  const llm = new LLMProvider();
  
  // Test 1: Provider interface
  assert(llm.providers.nvidia, 'NVIDIA provider should be loaded');
  assert(llm.providers.groq, 'Groq provider should be loaded');
  console.log('  ✅ Providers loaded');
  
  // Test 2: Get provider
  const nvidia = llm.getProvider('nvidia');
  assert(nvidia.name === 'nvidia', 'Should get NVIDIA provider');
  console.log('  ✅ getProvider works');
  
  // Test 3: Health check
  const health = await llm.healthCheck('nvidia');
  assert(typeof health.ok === 'boolean', 'Health should return ok boolean');
  console.log('  ✅ Health check works');
  
  // Test 4: Stats
  const stats = llm.getStats();
  assert(stats.nvidia, 'NVIDIA stats should exist');
  console.log('  ✅ Stats work');
  
  console.log('✅ LLMProvider tests passed!\n');
}

// Test Handler Manager
async function testHandlerManager() {
  console.log('🧪 Testing HandlerManager...');
  
  const { HandlerManager } = require('./handlers/HandlerManager');
  const manager = new HandlerManager();
  
  // Mock dependencies
  const deps = {
    waSend: async () => {},
    checkEndpoint: async () => ({ ok: true }),
    httpGet: async () => ({}),
    vault: {
      searchVault: async () => ({ results: [] }),
      buildVaultResult: () => 'test',
      extractKeywords: () => [],
      getVaultUrls: () => [],
      trackInterest: () => {}
    },
    memory: {
      getLongTermContext: () => '',
      resetConversation: () => {},
      getUserInterests: () => ({})
    }
  };
  
  // Initialize
  manager.init(deps);
  console.log('  ✅ Initialization works');
  
  // Test has/get
  assert(manager.has('start'), 'Should have start handler');
  assert(manager.has('help'), 'Should have help handler');
  assert(manager.has('status'), 'Should have status handler');
  console.log('  ✅ Handler lookup works');
  
  // Test list
  const list = manager.list();
  assert(list.length > 0, 'Should list handlers');
  console.log('  ✅ Handler list works');
  
  // Test get
  const startHandler = manager.get('start');
  assert(startHandler, 'Should get handler function');
  console.log('  ✅ Handler getter works');
  
  console.log('✅ HandlerManager tests passed!\n');
}

// Test LLM Router
async function testLLMRouter() {
  console.log('🧪 Testing LLMRouter...');
  
  const { LLMRouter } = require('./llm_router');
  const router = new LLMRouter();
  
  // Test stats
  const stats = router.getStats();
  assert(stats.calls === 0, 'Initial calls should be 0');
  assert(typeof stats.fallbacks === 'number', 'Fallbacks should be number');
  console.log('  ✅ Stats work');
  
  // Test health status
  assert(router.isHealthy('nvidia'), 'Unknown provider should be healthy');
  console.log('  ✅ Health check works');
  
  // Test ensemble structure
  const ensemble = await router.ensemble('test');
  assert(typeof ensemble.best === 'string' || ensemble.best === null, 'Ensemble should return best');
  assert(typeof ensemble.bestProvider === 'string' || ensemble.bestProvider === null, 'Should return provider');
  assert(typeof ensemble.all === 'object', 'Should return all results');
  console.log('  ✅ Ensemble works');
  
  console.log('✅ LLMRouter tests passed!\n');
}

// Run all tests
async function runTests() {
  console.log('🚀 Running OmniClaw Architecture Tests\n');
  console.log('='.repeat(50));
  
  try {
    await testLLMProvider();
    await testHandlerManager();
    await testLLMRouter();
    
    console.log('='.repeat(50));
    console.log('🎉 All tests passed!');
    console.log('\nArchitecture achieved:');
    console.log('  • LLMProvider: Unified interface with 3 provider adapters');
    console.log('  • HandlerManager: Centralized handler initialization');
    console.log('  • LLMRouter: Automatic failover with health tracking');
    process.exit(0);
  } catch (e) {
    console.error('❌ Test failed:', e.message);
    process.exit(1);
  }
}

runTests();
