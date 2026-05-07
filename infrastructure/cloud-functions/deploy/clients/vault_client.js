/**
 * Vault Client - Your Personal Knowledge Graph
 *
 * The vault is your curated knowledge base - bookmarked content enriched with
 * VL tags forming a searchable knowledge graph. This client transforms passive
 * bookmarks into active knowledge leverage.
 *
 * Vault contains:
 * - Topics: AI, Python, Design, etc.
 * - Skills: Programming, Graphic Design, etc.
 * - Places: Restaurants, locations
 * - Food: Cuisines, dishes
 * - Relationships: Cross-platform connections
 */

const path = require('path');
const fs = require('fs');
const https = require('https');

const GCS_BUCKET = 'omniclaw-knowledge-graph';
const GCS_VAULT_PATH = 'vault/instagram_saved_automated.json';
const GCS_KG_PATH = 'unified_knowledge_graph.json';

class VaultClient {
  constructor(options = {}) {
    this.knowledgeGraphPath = options.knowledgeGraphPath ||
      path.join(__dirname, '../learning_base/unified_knowledge_graph.json');
    this.cache = new Map();
    this.cacheExpiry = 10 * 60 * 1000; // 10 minutes
    this.initialized = false;
  }

  /**
   * Get GCS access token from metadata service (Cloud Run/Cloud Functions)
   */
  getGCSToken() {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'metadata.google.internal',
        path: '/computeMetadata/v1/instance/service-accounts/default/identity?audience=https://storage.googleapis.com/',
        method: 'GET',
        headers: { 'Metadata-Flavor': 'Google' }
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) resolve(data);
          else reject(new Error(`Token request failed: ${res.statusCode}`));
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Download file from GCS using service account token
   */
  async downloadFromGCS(gcsPath, localPath) {
    try {
      const token = await this.getGCSToken();
      const objectName = encodeURIComponent(gcsPath);
      const url = `https://storage.googleapis.com/storage/v1/b/${GCS_BUCKET}/o/${objectName}?alt=media`;

      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (response.ok) {
        const data = await response.text();
        const dir = path.dirname(localPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(localPath, data);
        return true;
      }
    } catch (error) {
      console.error('[VaultClient] GCS download failed:', error.message);
    }
    return false;
  }

  /**
   * Sync vault data from GCS to local storage
   */
  async syncFromGCS() {
    try {
      // Sync knowledge graph from GCS
      await this.downloadFromGCS(GCS_KG_PATH, this.knowledgeGraphPath);
      // Clear cache to force reload
      this.cache.clear();
      this.initialized = true;
      console.log('[VaultClient] Synced from GCS');
    } catch (error) {
      console.error('[VaultClient] GCS sync failed:', error.message);
    }
  }

  /**
   * Load knowledge graph from local storage (synced from GCS)
   * Non-blocking: triggers background sync on first call
   */
  loadKnowledgeGraph() {
    // Trigger background sync from GCS if not yet done
    if (!this.initialized) {
      this.initialized = true;
      // Fire and forget - next call will have fresh data
      this.syncFromGCS().catch(e => console.error('[VaultClient] Background sync error:', e.message));
    }

    const cacheKey = 'knowledge_graph';
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
      return cached.data;
    }

    try {
      if (fs.existsSync(this.knowledgeGraphPath)) {
        const stat = fs.statSync(this.knowledgeGraphPath);
        console.log('[VaultClient] Loading KG from', this.knowledgeGraphPath, 'size:', stat.size);
        const data = JSON.parse(fs.readFileSync(this.knowledgeGraphPath, 'utf8'));
        console.log('[VaultClient] KG loaded:', data.nodes?.length, 'nodes');
        this.cache.set(cacheKey, { data, timestamp: Date.now() });
        return data;
      } else {
        console.log('[VaultClient] KG file not found:', this.knowledgeGraphPath);
      }
    } catch (error) {
      console.error('[VaultClient] Error loading knowledge graph:', error.message);
    }

    return null;
  }

  /**
   * Load vault posts from local storage (synced from GCS)
   * Non-blocking: triggers background sync on first call
   */
  loadVaultPosts() {
    const kg = this.loadKnowledgeGraph();
    if (!kg) return [];

    return (kg.nodes || []).filter(node => 
      node.type === 'instagram_post' || node.type === 'twitter_tweet'
    ).map(node => {
      // Normalize to the post format expected by other tools
      if (node.type === 'instagram_post') {
        return {
          id: node.id,
          vlSubject: node.name,
          vlTags: node.metadata?.vlTags || [],
          caption: node.content,
          permalink: node.url,
          source: 'instagram',
          ...node.metadata
        };
      } else {
        return {
          id: node.id,
          vlSubject: node.name,
          vlTags: (node.metadata ? node.metadata.topics : []) || [],
          caption: node.content || node.name,
          permalink: node.url,
          source: 'twitter'
        };
      }
    });
  }

  /**
   * Find topics and skills matching a query (searches both knowledge graph and vault posts)
   */
  findKnowledge(query) {
    const kg = this.loadKnowledgeGraph();
    if (!kg) return { topics: [], skills: [], places: [], food: [], vaultPosts: [] };

    const queryLower = query.toLowerCase();
    const results = {
      topics: [],
      skills: [],
      places: [],
      food: [],
      relationships: [],
      vaultPosts: []
    };

    // Search knowledge graph nodes
    for (const node of (kg.nodes || [])) {
      const nameLower = node.name.toLowerCase();
      const contentLower = (node.content || '').toLowerCase();
      const typeLower = node.type.toLowerCase();
      const searchStr = nameLower + ' ' + contentLower;

      // Check if query matches name or content
      if (searchStr.includes(queryLower) || queryLower.includes(nameLower)) {
        if (typeLower === 'topic') results.topics.push(node);
        else if (typeLower === 'skill') results.skills.push(node);
        else if (typeLower === 'place') results.places.push(node);
        else if (typeLower === 'food' || typeLower === 'cuisine') results.food.push(node);
        else if (typeLower === 'twitter_tweet' || typeLower === 'instagram_post') {
          // Limit posts to prevent memory issues
          if (results.vaultPosts.length < 100) {
            results.vaultPosts.push({
              id: node.id,
              vlSubject: node.name,
              vlTags: (node.metadata ? node.metadata.topics || node.metadata.vlTags : []) || [],
              caption: node.content || node.name,
              url: node.url,
              source: node.type === 'twitter_tweet' ? 'twitter' : 'instagram',
              timestamp: node.timestamp || node.createdAt || '',
              author: node.author || ''
            });
          }
        }
      }
    }
    
    console.log('[VaultClient] findKnowledge: searched', (kg.nodes ? kg.nodes.length : 0), 'nodes, found', results.vaultPosts.length, 'posts for "' + query + '"');

    // Search relationships
    for (const rel of (kg.relationships || [])) {
      if (rel.type.includes(queryLower)) {
        results.relationships.push(rel);
      }
    }

    // Removed redundant Instagram-only file search as it's now in the KG
    return results;
  }

  /**
   * Get a topic with its related knowledge
   */
  getTopicWithContext(topicName) {
    const kg = this.loadKnowledgeGraph();
    if (!kg) return null;

    // Find the topic node
    const topic = kg.nodes?.find(n =>
      n.name.toLowerCase() === topicName.toLowerCase() ||
      n.id.toLowerCase().includes(topicName.toLowerCase())
    );

    if (!topic) return null;

    // Find related nodes
    const related = kg.relationships
      ?.filter(r => r.from === topic.id || r.to === topic.id)
      ?.map(r => {
        const relatedId = r.from === topic.id ? r.to : r.from;
        return kg.nodes?.find(n => n.id === relatedId);
      })
      ?.filter(Boolean);

    return {
      ...topic,
      related,
      relationships: kg.relationships?.filter(r =>
        r.from === topic.id || r.to === topic.id
      )
    };
  }

  /**
   * Get food/place recommendations
   */
  getFoodRecommendations(cuisineOrDish) {
    const kg = this.loadKnowledgeGraph();
    if (!kg) return { restaurants: [], dishes: [], cuisine: null };

    // Find cuisine or dish
    const cuisine = kg.nodes?.find(n =>
      n.type === 'cuisine' &&
      (n.name.toLowerCase().includes(cuisineOrDish.toLowerCase()) ||
       cuisineOrDish.toLowerCase().includes(n.name.toLowerCase()))
    );

    const dishes = kg.nodes?.filter(n =>
      n.type === 'food' &&
      (n.name.toLowerCase().includes(cuisineOrDish.toLowerCase()) ||
       n.hashtags?.some(t => t.toLowerCase().includes(cuisineOrDish.toLowerCase())))
    );

    const restaurants = kg.nodes?.filter(n =>
      n.type === 'place' &&
      (n.name.toLowerCase().includes(cuisineOrDish.toLowerCase()) ||
       n.hashtags?.some(t => t.toLowerCase().includes(cuisineOrDish.toLowerCase())))
    );

    // Find relationships
    const dishToRestaurant = [];
    if (cuisine) {
      const rels = kg.relationships?.filter(r =>
        (r.from === cuisine.id || r.to === cuisine.id)
      );
      rels?.forEach(r => {
        const relatedId = r.from === cuisine.id ? r.to : r.from;
        const related = kg.nodes?.find(n => n.id === relatedId);
        if (related?.type === 'place') {
          dishToRestaurant.push({ place: related, relationship: r.type });
        }
      });
    }

    return {
      cuisine,
      dishes: dishes || [],
      restaurants: restaurants || [],
      dishToRestaurant,
      source: 'knowledge_graph'
    };
  }

  /**
   * Get skill learning path
   */
  getSkillLearningPath(skillName) {
    const kg = this.loadKnowledgeGraph();
    if (!kg) return null;

    // Find the skill
    const skill = kg.nodes?.find(n =>
      n.type === 'skill' &&
      (n.name.toLowerCase().includes(skillName.toLowerCase()) ||
       n.id.toLowerCase().includes(skillName.toLowerCase()))
    );

    if (!skill) return null;

    // Find related topics (learning prerequisites)
    const relatedTopics = kg.relationships
      ?.filter(r => r.from === skill.id || r.to === skill.id)
      ?.map(r => {
        const relatedId = r.from === skill.id ? r.to : r.from;
        return kg.nodes?.find(n => n.id === relatedId);
      })
      ?.filter(n => n?.type === 'topic');

    // Get vault posts about this skill
    const vault = this.loadVaultPosts();
    const skillPosts = (vault || [])
      .filter(post => {
        const text = `${post.text || ''} ${post.vlTags?.join(' ') || ''}`.toLowerCase();
        return text.includes(skill.name.toLowerCase());
      })
      .slice(0, 10);

    return {
      skill,
      relatedTopics: relatedTopics || [],
      recommendedPosts: skillPosts,
      estimatedLearnTime: this.estimateLearnTime(skill.name)
    };
  }

  /**
   * Estimate learning time based on skill complexity
   */
  estimateLearnTime(skillName) {
    const skillLower = skillName.toLowerCase();
    if (skillLower.includes('python') || skillLower.includes('programming')) {
      return '3-6 months';
    }
    if (skillLower.includes('design') || skillLower.includes('graphic')) {
      return '6-12 months';
    }
    if (skillLower.includes('ai') || skillLower.includes('machine learning')) {
      return '12-18 months';
    }
    return '3-6 months';
  }

  /**
   * Get random insight from vault
   */
  getRandomInsight() {
    const kg = this.loadKnowledgeGraph();
    if (!kg || !kg.nodes || kg.nodes.length === 0) return null;

    const randomNode = kg.nodes[Math.floor(Math.random() * kg.nodes.length)];
    const related = kg.relationships
      ?.filter(r => r.from === randomNode.id || r.to === randomNode.id)
      ?.map(r => {
        const relatedId = r.from === randomNode.id ? r.to : r.from;
        return kg.nodes?.find(n => n.id === relatedId);
      })
      ?.filter(Boolean);

    return {
      node: randomNode,
      related: related || [],
      fact: this.generateInsightText(randomNode)
    };
  }

  /**
   * Generate human-readable insight text
   */
  generateInsightText(node) {
    switch (node.type) {
      case 'topic':
        return `You have ${node.mentions || 0} saved items about ${node.name}`;
      case 'skill':
        return `Your ${node.name} skill level appears to be growing - ${node.mentions || 0} related saves`;
      case 'food':
        return `${node.name}: ${node.caption?.substring(0, 100)}...`;
      case 'cuisine':
        return `${node.name} cuisine is well-represented in your vault`;
      case 'place':
        return `${node.name} - ${node.caption?.substring(0, 80)}...`;
      default:
        return `${node.name} is in your personal knowledge graph`;
    }
  }

  /**
   * Connect two topics from your vault
   */
  connectTheDots(topic1, topic2) {
    const kg = this.loadKnowledgeGraph();
    if (!kg) return null;

    const node1 = kg.nodes?.find(n =>
      n.name.toLowerCase().includes(topic1.toLowerCase())
    );
    const node2 = kg.nodes?.find(n =>
      n.name.toLowerCase().includes(topic2.toLowerCase())
    );

    if (!node1 || !node2) {
      return { connected: false, path: null };
    }

    // Find direct relationship
    const directRel = kg.relationships?.find(r =>
      (r.from === node1.id && r.to === node2.id) ||
      (r.from === node2.id && r.to === node1.id)
    );

    if (directRel) {
      return {
        connected: true,
        type: directRel.type,
        strength: directRel.strength,
        path: [node1, directRel, node2]
      };
    }

    // Find indirect path (through common nodes)
    const node1Rels = kg.relationships?.filter(r =>
      r.from === node1.id || r.to === node1.id
    );
    const node2Rels = kg.relationships?.filter(r =>
      r.from === node2.id || r.to === node2.id
    );

    const node1RelatedIds = new Set([
      ...node1Rels?.map(r => r.from === node1.id ? r.to : r.from) || []
    ]);
    const common = node2Rels?.find(r => {
      const relatedId = r.from === node2.id ? r.to : r.from;
      return node1RelatedIds.has(relatedId);
    });

    if (common) {
      const middleId = common.from === node2.id ? common.to : common.from;
      const middleNode = kg.nodes?.find(n => n.id === middleId);
      return {
        connected: true,
        type: 'indirect',
        path: [node1, middleNode, node2],
        explanation: `${node1.name} connects to ${node2.name} through ${middleNode?.name}`
      };
    }

    return {
      connected: false,
      path: null,
      suggestion: `No relationship found between ${node1.name} and ${node2.name} in your vault`
    };
  }

  /**
   * Get vault statistics
   */
  getStats() {
    const kg = this.loadKnowledgeGraph();
    const vault = this.loadVaultPosts();

    const stats = {
      knowledgeGraph: {
        totalNodes: kg?.nodes?.length || 0,
        topics: kg?.nodes?.filter(n => n.type === 'topic').length || 0,
        skills: kg?.nodes?.filter(n => n.type === 'skill').length || 0,
        places: kg?.nodes?.filter(n => n.type === 'place').length || 0,
        food: kg?.nodes?.filter(n => n.type === 'food' || n.type === 'cuisine').length || 0,
        relationships: kg?.relationships?.length || 0
      },
      vault: {
        totalPosts: Array.isArray(vault) ? vault.length : 0,
        lastUpdated: kg?.metadata?.lastUpdated || null
      }
    };

    return stats;
  }

  /**
   * Parse natural language mood and find vault posts matching that emotional state
   */
  getVaultByMood(moodQuery, limit = 10) {
    const moodPatterns = {
      'curious but lazy': ['thoughtful', 'intriguing', 'exploratory'],
      'energetic': ['enthusiastic', 'excited', 'joyful'],
      'contemplative': ['thoughtful', 'reverent', 'calm'],
      'hungry': ['appetizing', 'enticing', 'delicious'],
      'creative': ['creative', 'artistic', 'inspiring'],
      'analytical': ['analytical', 'technical', 'detailed'],
      'inspired': ['inspired', 'motivational', 'uplifting']
    };
    const targetMoods = moodPatterns[moodQuery.toLowerCase()] || [moodQuery];

    const vault = this.loadVaultPosts();
    const scored = vault
      .map(post => ({
        post,
        moodScore: targetMoods.some(m =>
          (post.vlMood || '').toLowerCase().includes(m.toLowerCase())
        ) ? 1 : 0
      }))
      .filter(x => x.moodScore > 0)
      .slice(0, limit);

    return {
      query: moodQuery,
      matchedMoods: targetMoods,
      posts: scored.map(x => x.post),
      count: scored.length
    };
  }

  /**
   * Show what topics/interests are trending in the user's vault over time
   */
  getVaultTrends(timeRangeDays = 30) {
    const vault = this.loadVaultPosts();

    const tagCounts = {};
    vault.forEach(post => {
      (post.vlTags || []).forEach(tag => {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      });
    });

    const ranked = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);

    const topTags = ranked.map(([tag, count]) => ({ tag, count }));
    const topTag = topTags[0];

    return {
      topTags,
      topTag,
      totalPosts: vault.length,
      discovery: topTag
        ? `You have ${topTag.count} posts about '${topTag.tag}' - you're clearly into that!`
        : 'Not enough data for trends yet.',
      timeRange: `${timeRangeDays} days`
    };
  }
/**
   * Find unexpected connections between two different interest areas in the vault
   */
  findCrossConnections(domain1, domain2) {
    const vault = this.loadVaultPosts();

    // Get posts for each domain
    const domain1Posts = vault.filter(p =>
      (p.vlSubject || '').toLowerCase().includes(domain1.toLowerCase()) ||
      (p.vlTags || []).some(t => t.toLowerCase().includes(domain1.toLowerCase()))
    );
    const domain2Posts = vault.filter(p =>
      (p.vlSubject || '').toLowerCase().includes(domain2.toLowerCase()) ||
      (p.vlTags || []).some(t => t.toLowerCase().includes(domain2.toLowerCase()))
    );

    // Find shared vlTags
    const tags1 = new Set(domain1Posts.flatMap(p => p.vlTags || []));
    const tags2 = new Set(domain2Posts.flatMap(p => p.vlTags || []));
    const sharedTags = [...tags1].filter(t => tags2.has(t));

    // Find shared vlStyles
    const styles1 = new Set(domain1Posts.map(p => p.vlStyle).filter(Boolean));
    const styles2 = new Set(domain2Posts.map(p => p.vlStyle).filter(Boolean));
    const sharedStyles = [...styles1].filter(s => styles2.has(s));

    return {
      domain1: { name: domain1, postCount: domain1Posts.length },
      domain2: { name: domain2, postCount: domain2Posts.length },
      sharedTags,
      sharedStyles,
      insight: sharedTags.length > 0
        ? `Your ${domain1} and ${domain2} interests connect through: ${sharedTags.slice(0, 5).join(', ')}`
        : sharedStyles.length > 0
          ? `${domain1} and ${domain2} share aesthetic styles: ${sharedStyles.slice(0, 3).join(', ')}`
          : `Your ${domain1} and ${domain2} interests connect through similar perspectives`
    };
  }

  /**
   * Turn a single bookmarked post into a structured learning path
   */
  getDeepDive(postId) {
    const vault = this.loadVaultPosts();
    const post = vault.find(p => p.id === postId || p.permalink?.includes(postId));
    if (!post) return null;

    // Find related posts by vlTags, vlSubject similarity
    const related = vault
      .filter(p => p.id !== post.id)
      .map(p => ({
        post: p,
        relevance: this.calculateRelevance(post, p)
      }))
      .filter(x => x.relevance > 0.3)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 10);

    // Get knowledge graph context
    const kg = this.loadKnowledgeGraph();
    const topicNodes = kg?.nodes?.filter(n =>
      post.vlTags?.some(tag => n.name.toLowerCase().includes(tag.toLowerCase()))
    );

    return {
      anchor: {
        id: post.id,
        vlSubject: post.vlSubject,
        vlTags: post.vlTags,
        caption: post.caption?.substring(0, 100),
        url: post.permalink
      },
      learningPath: related.map(r => ({
        post: r.post,
        relevance: Math.round(r.relevance * 100) + '%',
        whyRelevant: `Matches your interest in ${r.post.vlSubject}`
      })),
      knowledgeGraphConnections: topicNodes,
      summary: `You bookmarked ${post.vlSubject}. Here are ${related.length} related posts and ${topicNodes?.length || 0} topics to explore.`
    };
  }

  /**
   * Calculate relevance score between two posts
   */
  calculateRelevance(post1, post2) {
    const tagOverlap = (post1.vlTags || []).filter(t =>
      (post2.vlTags || []).includes(t)
    ).length;
    const subjectMatch = post1.vlSubject === post2.vlSubject ? 1 : 0;
    const styleMatch = post1.vlStyle === post2.vlStyle ? 0.5 : 0;
    return (tagOverlap * 0.7) + (subjectMatch * 0.3) + styleMatch;
  }

  /**
   * Find surprising connections based on hidden gems - posts with niche tags
   */
  getSerendipity(nicheThreshold = 5) {
    const vault = this.loadVaultPosts();
    const kg = this.loadKnowledgeGraph();

    // Count tag frequencies
    const tagCounts = {};
    vault.forEach(p => (p.vlTags || []).forEach(t => {
      tagCounts[t] = (tagCounts[t] || 0) + 1;
    }));

    // Find niche tags (appearing <= threshold times)
    const nicheTags = Object.entries(tagCounts)
      .filter(([_, count]) => count <= nicheThreshold)
      .map(([tag]) => tag);

    // Find posts with these niche tags
    const serendipityPosts = vault.filter(p =>
      (p.vlTags || []).some(t => nicheTags.includes(t))
    );

    if (serendipityPosts.length === 0) {
      return {
        discovery: null,
        message: 'Not enough niche content for serendipity right now.'
      };
    }

    // Pick a random one
    const pick = serendipityPosts[Math.floor(Math.random() * serendipityPosts.length)];
    const nicheTag = (pick.vlTags || []).find(t => nicheTags.includes(t));
    const tagCount = tagCounts[nicheTag] || 0;

    // Find related knowledge graph nodes
    const relatedKG = kg?.nodes?.filter(n =>
      n.hashtags?.some(h => nicheTags.includes(h)) ||
      (n.name && nicheTags.some(t => n.name.toLowerCase().includes(t.toLowerCase())))
    );

    return {
      discovery: {
        id: pick.id,
        vlSubject: pick.vlSubject,
        vlTags: pick.vlTags,
        vlMood: pick.vlMood,
        caption: pick.caption?.substring(0, 100),
        url: pick.permalink
      },
      whyInteresting: `Only ${tagCount} people have saved posts about '${nicheTag}' - this is rare material!`,
      relatedKnowledge: relatedKG?.slice(0, 3),
      similarHiddenGems: serendipityPosts.slice(0, 5).map(p => ({
        vlSubject: p.vlSubject,
        vlTags: p.vlTags,
        url: p.permalink
      }))
    };
  }

  /**
   * Analyzes dimensions and mediaType to reconstruct your visual taste evolution over time.
   * Your saved posts ARE an implicit visual diary.
   */
  getAestheticEvolution() {
    const vault = this.loadVaultPosts();
    const now = Date.now();

    // Analyze dimension patterns over time
    const dimensionTimeline = vault
      .filter(p => p.dimensions && p.postDate)
      .map(p => ({
        date: new Date(p.postDate).getTime(),
        width: p.dimensions.width,
        height: p.dimensions.height,
        aspectRatio: p.dimensions.width / p.dimensions.height,
        isPortrait: p.dimensions.height > p.dimensions.width,
        isLandscape: p.dimensions.width > p.dimensions.height,
        isSquare: Math.abs(p.dimensions.width - p.dimensions.height) < 50,
        mediaType: p.mediaType,
        vlStyle: p.vlStyle,
        vlMood: p.vlMood
      }))
      .sort((a, b) => a.date - b.date);

    // Group by month
    const monthlyPatterns = {};
    dimensionTimeline.forEach(p => {
      const monthKey = new Date(p.date).toISOString().substring(0, 7);
      if (!monthlyPatterns[monthKey]) {
        monthlyPatterns[monthKey] = { portrait: 0, landscape: 0, square: 0, carousel: 0, video: 0, image: 0, total: 0 };
      }
      monthlyPatterns[monthKey].total++;
      if (p.isPortrait) monthlyPatterns[monthKey].portrait++;
      if (p.isLandscape) monthlyPatterns[monthKey].landscape++;
      if (p.isSquare) monthlyPatterns[monthKey].square++;
      if (p.mediaType === 'carousel') monthlyPatterns[monthKey].carousel++;
      if (p.mediaType === 'video') monthlyPatterns[monthKey].video++;
      if (p.mediaType === 'image') monthlyPatterns[monthKey].image++;
    });

    // Find aesthetic shifts
    const months = Object.entries(monthlyPatterns).sort();
    const shifts = [];
    for (let i = 1; i < months.length; i++) {
      const prev = months[i - 1][1];
      const curr = months[i][1];
      const prevRatio = prev.landscape / prev.total;
      const currRatio = curr.landscape / curr.total;
      if (Math.abs(currRatio - prevRatio) > 0.3) { // 30% shift
        shifts.push({
          month: months[i][0],
          shift: currRatio > prevRatio ? 'more landscape' : 'more portrait',
          change: Math.round((currRatio - prevRatio) * 100)
        });
      }
    }

    // Current preferences
    const recent = months.slice(-3);
    const avgRecent = recent.reduce((acc, [, m]) => ({
      portrait: acc.portrait + m.portrait / recent.length,
      landscape: acc.landscape + m.landscape / recent.length,
      square: acc.square + m.square / recent.length
    }), { portrait: 0, landscape: 0, square: 0 });

    const dominant = Object.entries(avgRecent).sort((a, b) => b[1] - a[1])[0];
    const dominantLabel = dominant[0];

    // Most common styles/moods in recent posts
    const recentPosts = vault.filter(p => {
      if (!p.postDate) return false;
      const age = now - new Date(p.postDate).getTime();
      return age < 90 * 24 * 60 * 60 * 1000; // Last 90 days
    });
    const recentStyles = recentPosts.map(p => p.vlStyle).filter(Boolean);
    const recentMoods = recentPosts.map(p => p.vlMood).filter(Boolean);
    const styleCounts = {};
    const moodCounts = {};
    recentStyles.forEach(s => { styleCounts[s] = (styleCounts[s] || 0) + 1; });
    recentMoods.forEach(m => { moodCounts[m] = (moodCounts[m] || 0) + 1; });
    const topStyle = Object.entries(styleCounts).sort((a, b) => b[1] - a[1])[0];
    const topMood = Object.entries(moodCounts).sort((a, b) => b[1] - a[1])[0];

    return {
      currentPreference: `Your recent aesthetic: ${dominantLabel} (${Math.round(dominant[1]/recent.length)}%)`,
      shifts: shifts.slice(0, 3),
      insight: shifts.length > 0
        ? `Your visual taste shifted ${shifts[0].shift} around ${shifts[0].month}!`
        : topStyle
          ? `Currently favoring ${topStyle[0]} style and ${topMood?.[0] || 'varied'} moods.`
          : 'Not enough visual data for aesthetic analysis yet.',
      aestheticSummary: {
        dominantFormat: dominantLabel,
        aestheticStyle: topStyle?.[0] || 'varied',
        emotionalTone: topMood?.[0] || 'varied'
      },
      totalAnalyzed: dimensionTimeline.length
    };
  }

  /**
   * Trace the evolution of interests over time using postDate
   * Shows when interests were born, how they grew, and seasonal patterns
   */
  getInterestArchaeology(timeRangeDays = 365) {
    const vault = this.loadVaultPosts();
    const now = Date.now();
    const cutoff = now - (timeRangeDays * 24 * 60 * 60 * 1000);

    // Build timeline for each vlTag
    const tagTimeline = {};
    vault.forEach(post => {
      if (!post.postDate || new Date(post.postDate).getTime() < cutoff) return;
      (post.vlTags || []).forEach(tag => {
        if (!tagTimeline[tag]) tagTimeline[tag] = { firstSeen: post.postDate, count: 0, posts: [] };
        tagTimeline[tag].count++;
        tagTimeline[tag].posts.push({ id: post.id, date: post.postDate });
        if (new Date(post.postDate).getTime() < new Date(tagTimeline[tag].firstSeen).getTime()) {
          tagTimeline[tag].firstSeen = post.postDate;
        }
      });
    });

    // Find oldest interests
    const sorted = Object.entries(tagTimeline)
      .map(([tag, data]) => ({ tag, firstSeen: data.firstSeen, count: data.count, age: Math.floor((now - new Date(data.firstSeen).getTime()) / (1000 * 60 * 60 * 24)) }))
      .filter(t => t.age > 30) // At least 30 days old
      .sort((a, b) => a.age - b.age);

    const oldest = sorted.slice(0, 5);
    const longest = oldest.length > 0 ? oldest[0] : null;

    // Detect seasonal patterns (month-of-year distribution)
    const monthlyCounts = {};
    vault.forEach(post => {
      if (post.postDate) {
        const month = new Date(post.postDate).getMonth();
        monthlyCounts[month] = (monthlyCounts[month] || 0) + 1;
      }
    });
    const peakMonth = Object.entries(monthlyCounts).sort((a, b) => b[1] - a[1])[0];
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

    return {
      oldestInterests: oldest.map(t => ({ tag: t.tag, since: t.firstSeen.substring(0, 10), age: t.age + ' days', posts: t.count })),
      insight: longest
        ? `You've been interested in "${longest.tag}" for ${longest.age} days - your longest running interest!`
        : 'Not enough historical data yet.',
      peakMonth: peakMonth ? `${monthNames[parseInt(peakMonth[0])]} had the most saves (${peakMonth[1]})` : null,
      totalTracked: Object.keys(tagTimeline).length
    };
  }

  /**
   * Find "quietly powerful" posts - content that hit harder than its save count suggests
   * Uses save ratios relative to post age, not raw counts
   */
  getResonanceScore(minSaves = 1) {
    const vault = this.loadVaultPosts();
    const now = Date.now();

    // Calculate resonance for each post
    const scored = vault
      .filter(p => (p.saves || 0) >= minSaves)
      .map(post => {
        const age = post.postDate
          ? Math.floor((now - new Date(post.postDate).getTime()) / (1000 * 60 * 60 * 24))
          : 365;
        const expectedSaves = Math.max(1, age / 30); // Expected saves per month
        const actualSaves = post.saves || 1;
        const resonanceRatio = actualSaves / expectedSaves;
        const engagement = (post.saves || 0) + (post.comments || 0) * 2;

        return {
          post,
          age,
          resonanceRatio: Math.round(resonanceRatio * 100) / 100,
          engagement
        };
      })
      .filter(x => x.resonanceRatio > 2) // Posts that outperformed by 2x
      .sort((a, b) => b.resonanceRatio - a.resonanceRatio);

    const topPosts = scored.slice(0, 5);
    const top = topPosts[0];

    return {
      topResonators: topPosts.map((x, i) => ({
        rank: i + 1,
        subject: x.post.vlSubject,
        resonanceRatio: x.resonanceRatio + 'x',
        saves: x.post.saves,
        age: x.age + ' days',
        caption: x.post.caption?.substring(0, 80) + '...'
      })),
      insight: top
        ? `"${top.post.vlSubject}" hit ${top.resonanceRatio}x harder than expected for its age - quietly powerful!`
        : 'Not enough engagement data for resonance analysis.',
      totalAnalyzed: vault.length
    };
  }

  /**
   * Find pairs of interests that share audiences but have no knowledge graph connection
   */
  getBlindSpot() {
    const vault = this.loadVaultPosts();

    // Get unique subjects from vault
    const subjects = [...new Set(vault.map(p => p.vlSubject).filter(Boolean))];

    // Find pairs that share 3+ tags
    const pairs = [];
    for (let i = 0; i < subjects.length; i++) {
      for (let j = i + 1; j < subjects.length; j++) {
        const s1 = subjects[i];
        const s2 = subjects[j];
        if (s1 === s2) continue;

        const posts1 = vault.filter(p => p.vlSubject === s1);
        const posts2 = vault.filter(p => p.vlSubject === s2);

        const tags1 = new Set(posts1.flatMap(p => p.vlTags || []));
        const tags2 = new Set(posts2.flatMap(p => p.vlTags || []));
        const shared = [...tags1].filter(t => tags2.has(t));

        if (shared.length >= 3) {
          pairs.push({ topic1: s1, topic2: s2, shared, strength: shared.length });
        }
      }
    }

    // Dedupe similar subjects
    const filtered = pairs.filter(p => {
      const s1 = p.topic1.toLowerCase();
      const s2 = p.topic2.toLowerCase();
      if (s1 === s2) return false;
      if (s1.includes(s2) || s2.includes(s1)) return false;
      if (s1.split(' ').length === 1 && s2.split(' ').length === 1 && levenshtein(s1, s2) <= 3) return false;
      return true;
    }).slice(0, 5);

    const top = filtered[0];

    return {
      missingConnections: filtered.map(p => ({
        connection: p.topic1 + ' <-> ' + p.topic2,
        via: p.shared.slice(0, 3).join(', '),
        tagCount: p.strength
      })),
      insight: top
        ? '"' + top.topic1 + '" and "' + top.topic2 + '" both appear in your vault with ' + top.strength + ' shared tags but are not connected!'
        : 'Your interests are well-connected!',
      totalMissing: filtered.length
    };
  }

  /**
   * Analyze caption text for topics you mention often but never saved
   */
  getGhostTopics() {
    const vault = this.loadVaultPosts();

    // Count hashtags that appear in captions but NOT in vlTags
    const allCaptionHashtags = vault.flatMap(p => (p.hashtags || []).map(h => h.toLowerCase()));
    const allVlTags = new Set(vault.flatMap(p => (p.vlTags || []).map(t => t.toLowerCase())));
    const orphanedHashtags = allCaptionHashtags.filter(h => !allVlTags.has(h));
    const hashtagCounts = {};
    orphanedHashtags.forEach(h => { hashtagCounts[h] = (hashtagCounts[h] || 0) + 1; });
    const orphanedSorted = Object.entries(hashtagCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);

    // Extract words from captions that don't exist in vlTags
    const captionWords = vault.flatMap(p => {
      const words = (p.caption || '').toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
      return words.filter(w => !allVlTags.has(w) && !hashtagCounts[w]);
    });
    const wordCounts = {};
    captionWords.forEach(c => { wordCounts[c] = (wordCounts[c] || 0) + 1; });
    const ghostWords = Object.entries(wordCounts).filter(([c, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 5);

    const topWord = ghostWords[0];
    const topHashtag = orphanedSorted[0];

    return {
      ghostConcepts: ghostWords.map(([concept, count]) => ({ concept, mentions: count })),
      orphanedHashtags: orphanedSorted.map(([tag, count]) => ({ tag, count })),
      insight: topWord
        ? `You mention "${topWord[0]}" ${topWord[1]} times in captions but never saved a post about it!`
        : topHashtag
          ? `You use #${topHashtag[0]} in captions ${topHashtag[1]} times but never saved related content!`
          : 'No ghost topics detected - you save what matters to you.',
      totalGhosts: ghostWords.length + orphanedSorted.length
    };
  }
}

function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
      }
    }
  }
  return matrix[b.length][a.length];
}

module.exports = VaultClient;
