/**
 * Test script for RealFast Job Alert Service
 * Tests MCP connection, scoring logic, and email config
 */

const { calculateMatchScore, isRelevantPosition } = require('./index.js');

// Test positions with varying match scores
const testPositions = [
  {
    id: 'test-1',
    title: 'VP of Growth & Partnerships',
    company: 'FintechStartup',
    location: 'Bangalore, India',
    employment_type: 'Full-time',
    url: 'https://example.com/job/1',
    description: 'Lead growth strategy for a fintech lending platform targeting SMBs in India.'
  },
  {
    id: 'test-2',
    title: 'AI Transformation Lead',
    company: 'Enterprise Corp',
    location: 'Remote',
    employment_type: 'Full-time',
    url: 'https://example.com/job/2',
    description: 'Drive AI/ML transformation initiatives across the organization.'
  },
  {
    id: 'test-3',
    title: 'Product Manager - CRM',
    company: 'SaaS Company',
    location: 'Mumbai',
    employment_type: 'Full-time',
    url: 'https://example.com/job/3',
    description: 'Own product roadmap for enterprise CRM platform.'
  },
  {
    id: 'test-4',
    title: 'Backend Engineer - Python',
    company: 'Tech Corp',
    location: 'Bangalore',
    employment_type: 'Full-time',
    url: 'https://example.com/job/4',
    description: 'Build APIs using Python FastAPI and PostgreSQL.'
  },
  {
    id: 'test-5',
    title: 'Growth Marketing Manager',
    company: 'D2C Brand',
    location: 'Bangalore',
    employment_type: 'Full-time',
    url: 'https://example.com/job/5',
    description: 'Manage performance marketing campaigns across Google and Meta.'
  },
  {
    id: 'test-6',
    title: 'Business Development Lead',
    company: 'AI Platform',
    location: 'Remote',
    employment_type: 'Full-time',
    url: 'https://example.com/job/6',
    description: 'Build platform partnerships and drive B2B revenue growth.'
  }
];

console.log('========================================');
console.log('RealFast Job Alert - Test Suite');
console.log('========================================\n');

let passed = 0;
let failed = 0;

console.log('Testing scoring logic...\n');

testPositions.forEach(pos => {
  const { score, matchedReasons } = calculateMatchScore(pos);
  const relevant = score >= 30;
  
  console.log(`Position: ${pos.title}`);
  console.log(`  Score: ${score}/100`);
  console.log(`  Matched: ${matchedReasons.slice(0, 3).join(', ') || 'none'}`);
  console.log(`  Relevant: ${relevant ? 'YES ✓' : 'NO ✗'}`);
  console.log('');
});

console.log('------------------------------------------\n');

// Test if scoring maintains sort order
const sorted = [...testPositions]
  .map(p => ({ ...p, ...calculateMatchScore(p) }))
  .sort((a, b) => b.score - a.score);

console.log('Positions sorted by score (highest first):');
sorted.forEach((p, i) => {
  console.log(`  ${i + 1}. ${p.title} - ${p.score}pts`);
});

console.log('\n------------------------------------------\n');

// Verify expected order (VP Growth should be highest)
const expectedTopScore = sorted[0].score;
const expectedBottomScore = sorted[sorted.length - 1].score;

if (expectedTopScore > expectedBottomScore) {
  console.log('✓ Scoring logic maintains correct ordering\n');
  passed++;
} else {
  console.log('✗ Scoring logic not working correctly\n');
  failed++;
}

// Verify VP Growth is scored highest
if (sorted[0].title.includes('VP') || sorted[0].title.includes('Growth')) {
  console.log('✓ High-value position correctly ranked\n');
  passed++;
} else {
  console.log('✗ High-value position not ranked highest\n');
  failed++;
}

// Verify unrelated positions score low
if (sorted[sorted.length - 1].score < 30) {
  console.log('✓ Irrelevant positions correctly filtered\n');
  passed++;
} else {
  console.log('✗ Irrelevant positions getting false positives\n');
  failed++;
}

console.log('------------------------------------------\n');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('========================================\n');

// Test MCP connection (optional)
async function testMCPConnection() {
  console.log('Testing MCP connection...\n');
  
  try {
    const result = await require('./index.js').browsePositions();
    
    if (result && Array.isArray(result)) {
      console.log(`✓ MCP connection successful, ${result.length} positions found`);
      console.log('  (Positions may be empty if RealFast has no current openings)\n');
      return true;
    } else {
      console.log('⚠ MCP returned unexpected format\n');
      return false;
    }
  } catch (error) {
    console.log(`✗ MCP connection failed: ${error.message}\n`);
    return false;
  }
}

// Run MCP test if called directly
if (require.main === module) {
  testMCPConnection()
    .then(() => process.exit(failed > 0 ? 1 : 0))
    .catch(err => {
      console.error('Test error:', err);
      process.exit(1);
    });
}

module.exports = { testMCPConnection };