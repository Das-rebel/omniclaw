/**
 * Auto-Categorization for Vault Bookmarks
 * Uses keyword extraction and topic modeling
 */

const fs = require('fs');

// Topic keywords for classification
const TOPIC_KEYWORDS = {
  'AI & Machine Learning': [
    'AI', 'artificial intelligence', 'machine learning', 'deep learning', 'neural network',
    'GPT', 'LLM', 'Claude', 'ChatGPT', 'OpenAI', 'transformer', 'BERT', 'LangChain',
    'RAG', 'embedding', 'vector', 'Hugging Face', 'PyTorch', 'TensorFlow', 'AGI',
    'autonomous', 'agent', 'reasoning', 'foundation model', 'fine-tuning'
  ],
  'Coding & DevOps': [
    'Python', 'JavaScript', 'TypeScript', 'React', 'Node.js', 'API', 'GitHub',
    'Docker', 'Kubernetes', 'AWS', 'cloud', 'serverless', 'microservice', 'devops',
    'CI/CD', 'pipeline', 'deployment', 'automation', 'infrastructure', 'Terraform',
    'backend', 'frontend', 'fullstack', 'database', 'PostgreSQL', 'MongoDB', 'Redis'
  ],
  'Startup & Business': [
    'startup', 'founder', 'funding', 'Series A', 'VC', 'venture', 'investment',
    'pitch', 'business model', 'revenue', 'SaaS', 'MRR', 'ARR', 'churn', 'growth',
    'product market fit', 'scaling', 'IPO', 'acquisition', 'exit', 'entrepreneur'
  ],
  'Finance & Crypto': [
    'Bitcoin', 'Ethereum', 'crypto', 'blockchain', 'DeFi', 'NFT', 'trading', 'investment',
    'stock market', 'portfolio', 'hedge fund', 'bonds', 'equity', 'commodity',
    'inflation', 'interest rate', 'FED', 'market cap', 'valuation', 'token'
  ],
  'Career & Productivity': [
    'career', 'job', 'resume', 'interview', 'hiring', 'salary', 'promotion', 'leadership',
    'productivity', 'time management', 'remote work', 'work from home', 'collaboration',
    'communication', 'meeting', 'workflow', 'efficiency', 'habit', 'goal setting'
  ],
  'Research & Papers': [
    'paper', 'research', 'arxiv', 'study', 'experiment', 'benchmark', 'evaluation',
    'dataset', 'SOTA', 'state of the art', 'methodology', 'results', 'conclusion',
    'abstract', 'introduction', 'related work', 'references'
  ],
  'Tools & Products': [
    'tool', 'product', 'app', 'software', 'platform', 'service', 'framework', 'library',
    'open source', 'GitHub', 'release', 'launch', 'announcement', 'update', 'version'
  ],
  'Tutorials & Learning': [
    'tutorial', 'guide', 'how to', 'learn', 'course', 'lesson', 'workshop', 'training',
    'example', 'demo', 'walkthrough', 'introduction', 'beginner', 'advanced', 'master'
  ]
};

class AutoCategorizer {
  constructor() {
    this.topics = Object.keys(TOPIC_KEYWORDS);
  }

  // Extract keywords from text
  extractKeywords(text, limit = 10) {
    if (!text) return [];
    const words = text.toLowerCase().split(/\W+/);
    const freq = {};
    words.forEach(w => {
      if (w.length > 3) freq[w] = (freq[w] || 0) + 1;
    });
    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(e => e[0]);
  }

  // Classify text into topics
  classify(text) {
    if (!text) return [];
    
    const textLower = text.toLowerCase();
    const scores = {};
    
    // Score each topic
    for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
      scores[topic] = 0;
      for (const keyword of keywords) {
        if (textLower.includes(keyword.toLowerCase())) {
          scores[topic] += 1;
        }
      }
    }
    
    // Sort by score and return top topics
    const sorted = Object.entries(scores)
      .filter(([_, score]) => score > 0)
      .sort((a, b) => b[1] - a[1]);
    
    return sorted.map(([topic, score]) => ({
      topic,
      score,
      confidence: Math.min(score / 5, 1) // Normalize to 0-1
    }));
  }

  // Categorize a bookmark
  categorizeBookmark(bookmark) {
    const text = `${bookmark.title || ''} ${bookmark.content || ''} ${bookmark.text || ''}`.slice(0, 1000);
    const topTopics = this.classify(text);
    const keywords = this.extractKeywords(text);
    
    return {
      topics: topTopics.slice(0, 3), // Top 3 topics
      keywords: keywords.slice(0, 10), // Top 10 keywords
      primaryTopic: topTopics[0]?.topic || null,
      confidence: topTopics[0]?.confidence || 0
    };
  }
}

module.exports = { AutoCategorizer, TOPIC_KEYWORDS };
