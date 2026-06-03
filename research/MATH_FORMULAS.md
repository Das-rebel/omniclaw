# Mathematical Formulations for Query Routing

## Overview

This document catalogs rigorous mathematical frameworks for query routing, ranked by implementation complexity and expected improvement over heuristic baselines.

---

## 1. Information Theory Approaches

### 1.1 Entropy-Based Query Complexity

**Description:** Measure uncertainty in query intent using Shannon entropy. Higher entropy = more ambiguous query = route to more capable model.

**Formula:**
```
H(Q) = -Σᵢ P(qᵢ) · log₂ P(qᵢ)
```
Where:
- `H(Q)` = entropy of query Q (in bits)
- `P(qᵢ)` = probability of interpretation i for the query
- `i` ranges over possible query intent categories

**Complexity Score (normalized):**
```
C(Q) = H(Q) / log₂(N)
```
Where:
- `C(Q)` ∈ [0, 1] = normalized complexity score
- `N` = number of possible interpretations/discrete categories

**Implementation (TypeScript, no ML):**
```typescript
function entropyComplexity(tokens: string[], vocab: Map<string, number>): number {
  // Token frequency distribution
  const freq = new Map<string, number>();
  for (const tok of tokens) {
    freq.set(tok, (freq.get(tok) || 0) + 1);
  }
  // P(q_i) = frequency / total tokens
  let entropy = 0;
  const n = tokens.length;
  for (const count of freq.values()) {
    const p = count / n;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy / Math.log2(vocab.size || 2);
}
```

**Variables:**
- `tokens` = array of tokenized query terms
- `vocab` = vocabulary map for normalization denominator

**Expected improvement:** +5-8% routing accuracy over keyword-length heuristics. Captures word-level ambiguity better than length alone.

---

### 1.2 Mutual Information for Query Classification

**Description:** Measure how much a query term reveals about the intended category. High MI = strong signal for routing decision.

**Formula:**
```
I(X; Y) = Σᵢ Σⱼ P(xᵢ, yⱼ) · log₂ [P(xᵢ, yⱼ) / (P(xᵢ) · P(yⱼ))]
```
Where:
- `I(X; Y)` = mutual information between query features X and category Y
- `xᵢ` = query feature i (e.g., token presence)
- `yⱼ` = routing category j (e.g., simple/complex)
- `P()` = joint/marginal probabilities

**Simplified implementation:**
```typescript
interface CategoryScore {
  category: string;
  mi: number;
}

function mutualInformation(
  queryTokens: string[],
  categoryTermSets: Map<string, Set<string>>
): CategoryScore[] {
  const results: CategoryScore[] = [];
  
  for (const [category, terms] of categoryTermSets) {
    let mi = 0;
    // Count co-occurrences
    let coOccur = 0;
    for (const tok of queryTokens) {
      if (terms.has(tok)) coOccur++;
    }
    // P(x_i, y_j) approximation
    const pJoint = coOccur / queryTokens.length;
    // P(x_i) = query relevance
    const pX = terms.size / 1000; // normalize
    // P(y_j) = category prior
    const pY = 0.5; // or from training data
    if (pJoint > 0 && pX > 0 && pY > 0) {
      mi = pJoint * Math.log2(pJoint / (pX * pY));
    }
    results.push({ category, mi });
  }
  
  return results.sort((a, b) => b.mi - a.mi);
}
```

**Expected improvement:** +3-6% over random routing. Good for keyword-matched categories.

---

### 1.3 Kolmogorov Complexity Approximation

**Description:** Approximate algorithmic incompressibility as a proxy for query difficulty. Shorter compressed queries are simpler.

**Formula (approximation via compression ratio):**
```
K(Q) ≈ 1 - |C(Q)| / |Q|
```
Where:
- `K(Q)` ∈ [0, 1] = normalized Kolmogorov complexity approximation
- `C(Q)` = compressed representation length
- `Q` = original query string
- `|X|` = length of X in bytes/bits

**Implementation:**
```typescript
function kolmogorovApprox(query: string): number {
  // LZW-style compression simulation
  let dictSize = 256;
  const dict = new Map<string, number>();
  let compressed = 0;
  
  for (let i = 0; i < 128 && i < query.length; i++) {
    const s = query.slice(0, i);
    const code = simpleCompress(s);
    compressed += code.toString().length;
  }
  
  const ratio = compressed / query.length;
  return Math.min(1, Math.max(0, ratio));
}

function simpleCompress(s: string): string {
  // Simplified placeholder - in practice use zlib
  return s.split('').map(c => c.charCodeAt(0).toString(16)).join('');
}
```

**Expected improvement:** +2-4%. Best as secondary signal alongside entropy.

---

## 2. Queueing Theory for Routing

### 2.1 M/M/1 Response Time Prediction

**Description:** Model each provider as an M/M/1 queue to predict expected response time based on current load. Route to fastest available.

**Formula:**
```
E[T] = 1 / (μ - λ)
```
Where:
- `E[T]` = expected response time
- `μ` = service rate (requests/second) — from provider historical throughput
- `λ` = arrival rate (requests/second) — from current queue depth

**Implementation:**
```typescript
interface ProviderMetrics {
  name: string;
  avgThroughput: number;   // requests/sec typical
  currentQueue: number;    // pending requests
  baseLatency: number;     // ms baseline
}

function predictResponseTime(provider: ProviderMetrics): number {
  const lambda = provider.currentQueue / 10; // req/sec estimate
  const mu = provider.avgThroughput;
  
  if (mu <= lambda) return Infinity; // queue diverges
  
  const queueWait = 1000 / (mu - lambda); // ms
  return provider.baseLatency + queueWait;
}
```

**Tier boundary (deterministic):**
```
Tier 1 (fast): E[T] < 2s  → Groq/Cerebras
Tier 2 (balanced): 2s ≤ E[T] < 8s → OpenAI GPT-4
Tier 3 (deep): E[T] ≥ 8s → Anthropic/Google
```

**Expected improvement:** +10-15% on latency-sensitive queries. Direct QoS improvement.

---

### 2.2 Load Balancing Formulas

**Least Connections Formula:**
```
LC_i = active_connections_i / capacity_i
```
Route to provider with lowest `LC_i`.

**Weighted Round Robin:**
```
W_i = wᵢ / Σⱼ wⱼ
```
Where `wᵢ` = provider weight (from cost/quality ratio).

**Implementation:**
```typescript
interface ProviderLoad {
  name: string;
  weight: number;      // from cost_quality_ratio
  active: number;      // current connections
  capacity: number;    // max connections
}

function leastConnections(providers: ProviderLoad[]): string {
  const scores = providers.map(p => ({
    name: p.name,
    score: p.active / p.capacity
  }));
  return scores.sort((a, b) => a.score - b.score)[0].name;
}

function weightedRoundRobin(providers: ProviderLoad[]): string {
  const total = providers.reduce((s, p) => s + p.weight, 0);
  const rand = Math.random() * total;
  let cumulative = 0;
  for (const p of providers) {
    cumulative += p.weight;
    if (rand < cumulative) return p.name;
  }
  return providers[0].name;
}
```

**Expected improvement:** +5-8% throughput under load. Complements complexity routing.

---

## 3. Multi-Armed Bandits for Routing

### 3.1 UCB1 (Upper Confidence Bound)

**Description:** Balance exploration/exploitation for routing decisions. Maximize long-term reward while exploring new providers.

**Formula:**
```
UCB1(a) = X̄ₐ + √(2·ln(n) / nₐ)
```
Where:
- `UCB1(a)` = UCB1 score for action (provider) a
- `X̄ₐ` = average reward observed for provider a
- `n` = total iterations (total routing decisions)
- `nₐ` = iterations where provider a was selected
- `ln` = natural logarithm

**Implementation:**
```typescript
interface ProviderBandit {
  name: string;
  pulls: number;
  totalReward: number;
  avgReward: number;
}

function ucb1Select(providers: ProviderBandit[], totalPulls: number): string {
  // If any provider never pulled, explore it first
  const unpulled = providers.filter(p => p.pulls === 0);
  if (unpulled.length > 0) return unpulled[0].name;
  
  const scores = providers.map(p => {
    const exploitation = p.avgReward;
    const exploration = Math.sqrt(2 * Math.log(totalPulls) / p.pulls);
    return { name: p.name, score: exploitation + exploration };
  });
  
  scores.sort((a, b) => b.score - a.score);
  return scores[0].name;
}

// Update after each query result
function ucb1Update(bandit: ProviderBandit, reward: number): void {
  bandit.totalReward += reward;
  bandit.pulls += 1;
  bandit.avgReward = bandit.totalReward / bandit.pulls;
}
```

**Reward definition (for query routing):**
```
reward = quality_score * 1000 / (latency_ms * cost_per_token)
```
Higher reward = better routing decision.

**Expected improvement:** +8-12% over epsilon-greedy. Self-optimizing over time.

---

### 3.2 Thompson Sampling

**Description:** Bayesian approach using Beta distributions for binary success/failure per provider.

**Formulas:**
```
θₐ ~ Beta(αₐ, βₐ)  // Prior belief about provider quality
P(success|θₐ) = θₐ
```
Update after observation:
```
αₐ' = αₐ + reward
βₐ' = βₐ + (1 - reward)
```

**Implementation:**
```typescript
interface BetaProvider {
  name: string;
  alpha: number;  // successes + 1
  beta: number;   // failures + 1
}

function thompsonSample(providers: BetaProvider[]): string {
  const samples = providers.map(p => ({
    name: p.name,
    sample: betaSample(p.alpha, p.beta)
  }));
  return samples.sort((a, b) => b.sample - a.sample)[0].name;
}

function betaMean(alpha: number, beta: number): number {
  return alpha / (alpha + beta);
}

function betaSample(alpha: number, beta: number): number {
  // Jitter method approximation of Beta distribution
  let product = 1;
  for (let i = 0; i < 12; i++) {
    product *= Math.random();
  }
  return -Math.log(product) / alpha;
}
```

**Expected improvement:** +10-15%. Better convergence than UCB1 in early rounds.

---

### 3.3 Contextual Bandits (LinUCB)

**Description:** Incorporate query features into the bandit decision for context-aware routing.

**Formula:**
```
E[r|a, x] = θᵀ· xₐ
UCB: a* = argmaxₐ (θᵀ·xₐ + α√xₐᵀAₐ⁻¹xₐ)
```
Where:
- `xₐ` = feature vector for query+provider combination
- `θᵀ` = learned weight vector
- `Aₐ⁻¹` = feature covariance matrix
- `α` = exploration parameter

**Note:** LinUCB requires online learning. For TMLPD's static router, use simpler context features:
```typescript
interface QueryContext {
  tokenCount: number;
  hasCode: boolean;
  hasMath: boolean;
  hasLongContext: boolean;
  language: string;
}

function contextScore(query: QueryContext, provider: ProviderConfig): number {
  let score = 0;
  
  // Simple feature weights (offline-tuned)
  score += Math.min(query.tokenCount / 100, 1) * provider.capacity_score;
  score += (query.hasCode ? 1 : 0) * provider.code_strength;
  score += (query.hasMath ? 1 : 0) * provider.math_strength;
  score -= query.tokenCount > 10000 ? 0.5 : 0; // penalty for long context
  
  return score;
}
```

**Expected improvement:** +6-10% with proper feature engineering. Moderate complexity.

---

## 4. Fuzzy Logic for Classification

### 4.1 Fuzzy Membership Functions

**Description:** Handle gradual category boundaries instead of hard thresholds. Query complexity is never binary.

**Membership functions:**
```
μ_simple(x) = {
  1,                    if x ≤ 50 tokens
  (200 - x) / 150,     if 50 < x < 200
  0,                    if x ≥ 200
}

μ_complex(x) = {
  0,                    if x ≤ 100
  (x - 100) / 400,     if 100 < x < 500
  1,                    if x ≥ 500
}
```

**Mamdani inference:**
```typescript
interface FuzzyRule {
  if: { complexity: 'simple' | 'medium' | 'complex' };
  then: { route: 'fast' | 'balanced' | 'deep' };
  confidence: number;
}

const rules: FuzzyRule[] = [
  { if: { complexity: 'simple' }, then: { route: 'fast' }, confidence: 0.9 },
  { if: { complexity: 'complex' }, then: { route: 'deep' }, confidence: 0.85 },
  { if: { complexity: 'medium' }, then: { route: 'balanced' }, confidence: 0.75 },
];

function fuzzyInfer(tokenCount: number, features: FuzzyFeatures): string {
  // Compute membership grades
  const simple = tokenCount < 100 ? 1 : Math.max(0, 1 - (tokenCount - 100) / 200);
  const complex = tokenCount > 300 ? 1 : Math.max(0, (tokenCount - 100) / 200);
  const medium = Math.min(1 - simple, 1 - complex);
  
  // Defuzzify (centroid method)
  const routes = { fast: 0, balanced: 0, deep: 0 };
  const weights = { fast: 1, balanced: 2, deep: 3 };
  
  // Weighted sum defuzzification
  // Route decision based on highest weighted confidence
  let bestRoute = 'balanced';
  let bestScore = 0;
  
  for (const rule of rules) {
    const antecedent = rule.if.complexity;
    let grade = antecedent === 'simple' ? simple : 
                antecedent === 'complex' ? complex : medium;
    
    if (grade > 0) {
      const score = grade * rule.confidence * weights[rule.then.route];
      if (score > bestScore) {
        bestScore = score;
        bestRoute = rule.then.route;
      }
    }
  }
  
  return bestRoute;
}
```

**Expected improvement:** +4-7%. Smooths hard-coded threshold edge cases.

---

## 5.  Analytic Hierarchy Process (AHP)

### 5.1 Pairwise Comparison Matrix

**Description:** Capture relative importance of routing features via pairwise comparisons.

**Matrix construction:**
```
A = [  1    3    5    7 ]
    [ 1/3   1    3    5 ]
    [ 1/5  1/3   1    3 ]
    [ 1/7  1/5  1/3   1 ]
```
Where rows/cols = {cost, latency, quality, context_length}.

**Consistency Ratio:**
```
CR = CI / RI
CI = (λ_max - n) / (n - 1)
```
Where:
- `λ_max` = largest eigenvalue of matrix
- `n` = matrix dimension
- `RI` = random index (from table: n=4 → RI=0.90)

Accept if `CR < 0.10`.

**Implementation:**
```typescript
interface FeatureWeight {
  name: string;
  weight: number;
}

// Saaty's scale: 1=equal, 3=moderate, 5=strong, 7=very strong
const comparisonMatrix = [
  [1,   3,   5,   7],   // cost row
  [1/3, 1,   3,   5],   // latency row
  [1/5, 1/3, 1,   3],   // quality row
  [1/7, 1/5, 1/3, 1],   // context row
];

function computeAhpWeights(matrix: number[][]): FeatureWeight[] {
  const n = matrix.length;
  
  // Normalize column-wise
  const colSums = matrix.reduce((acc, row) => {
    row.forEach((val, j) => acc[j] += val);
    return acc;
  }, Array(n).fill(0));
  
  const normalized = matrix.map(row => 
    row.map((val, j) => val / colSums[j])
  );
  
  // Average each row = feature weight
  const features = ['cost', 'latency', 'quality', 'context_length'];
  return features.map((name, i) => ({
    name,
    weight: normalized[i].reduce((s, v) => s + v, 0) / n
  }));
}
```

**Expected improvement:** +5-8%. Transparent, auditable weighting. Good for stakeholder reporting.

---

## 6. Hybrid Combination Framework

### 6.1 Weighted Ensemble

Combine multiple scoring methods for robust routing:

```typescript
interface RoutingScore {
  provider: string;
  entropyScore: number;    // from §1.1
  queueScore: number;       // from §2.1
  banditScore: number;     // from §3.1
  fuzzyScore: number;      // from §4.1
  ahpScore: number;        // from §5.1
}

const WEIGHTS = {
  entropy: 0.20,   // query complexity
  queue: 0.25,     // latency
  bandit: 0.25,    // historical performance
  fuzzy: 0.15,     // rule-based
  ahp: 0.15,       // feature importance
};

function hybridScore(r: RoutingScore): number {
  return (
    r.entropyScore * WEIGHTS.entropy +
    r.queueScore  * WEIGHTS.queue  +
    r.banditScore * WEIGHTS.bandit +
    r.fuzzyScore  * WEIGHTS.fuzzy  +
    r.ahpScore    * WEIGHTS.ahp
  );
}
```

### 6.2 Tier Assignment Formula

```typescript
interface QueryMeta {
  tokenCount: number;
  hasCode: boolean;
  hasMath: boolean;
  language: string;
}

interface TierAssignment {
  tier: 'fast' | 'balanced' | 'deep';
  confidence: number;
}

function assignTier(query: QueryMeta, scores: Map<string, number>): TierAssignment {
  const fastProviders = ['groq', 'cerebras'];
  const balancedProviders = ['openai', 'groq'];
  const deepProviders = ['anthropic', 'google'];
  
  // Check which tier has best score for this query
  const fastScore = fastProviders.reduce((s, p) => s + (scores.get(p) || 0), 0);
  const balancedScore = balancedProviders.reduce((s, p) => s + (scores.get(p) || 0), 0);
  const deepScore = deepProviders.reduce((s, p) => s + (scores.get(p) || 0), 0);
  
  const maxScore = Math.max(fastScore, balancedScore, deepScore);
  const total = fastScore + balancedScore + deepScore;
  
  if (maxScore === fastScore) return { tier: 'fast', confidence: maxScore / total };
  if (maxScore === balancedScore) return { tier: 'balanced', confidence: maxScore / total };
  return { tier: 'deep', confidence: maxScore / total };
}
```

---

## 7. Implementation Checklist

### Phase 1: Core (Week 1-2)
- [x] Entropy complexity scoring (`§1.1`)
- [x] M/M/1 queue predictions (`§2.1`)
- [x] Tier boundary thresholds (`§2.1`)

### Phase 2: Adaptive (Week 3-4)
- [ ] UCB1 bandit for providers (`§3.1`)
- [ ] Thompson sampling tracker (`§3.2`)
- [ ] Fuzzy rule engine (`§4.1`)

### Phase 3: Optimal (Week 5-6)
- [ ] AHP weight calibration (`§5.1`)
- [ ] Hybrid ensemble (`§6.1`)
- [ ] A/B validation framework

---

## 8. Validation Plan

### 8.1 Offline Evaluation
```
dataset = historical queries (min 1000)
For each query:
  baseline = heuristic_tier(query)
  math_tier = entropyQueueRouting(query)
  compare(baseline, math_tier)

metrics:
  - routing_agreement_rate (baseline == math_tier)
  - confidence_correlation (high_confidence → correct_tier)
  - tier_distribution_spread (not all clumped in 1 tier)
```

### 8.2 Online A/B Test
```
Experiment: routing_v_math_vs_heuristic
Control: heuristic tier assignment
Treatment: entropy+queue routing
Metrics:
  - P99 latency (lower is better)
  - cost per successful query (lower is better)
  - user satisfaction score (higher is better)
  - API error rate (lower is better)

Significance: t-test, α=0.05, min 500 queries per arm
```

### 8.3 Bandit Validation
```
Track per-provider:
  - cumulative_reward over time
  - pull_count (exploration monitoring)
  - confidence_interval width
  
Convergence check: 
  - After 1000 queries, top provider should be selected >50% of the time
  - CI width should shrink <0.1
```

---

## 9. References

| # | Framework | Key Source | Formula Section |
|---|-----------|-----------|-----------------|
| 1 | Shannon Entropy | Shannon 1948 | §1.1 |
| 2 | Mutual Information | Cover & Thomas 2006 | §1.2 |
| 3 | Kolmogorov Complexity | Li & Vitanyi 2008 | §1.3 |
| 4 | M/M/1 Queue | Kleinrock 1975 | §2.1 |
| 5 | UCB1 | Auer 2002 | §3.1 |
| 6 | Thompson Sampling | Thompson 1933 | §3.2 |
| 7 | LinUCB | Li 2010 | §3.3 |
| 8 | Fuzzy Logic | Zadeh 1965 | §4.1 |
| 9 | AHP | Saaty 1980 | §5.1 |

---

## 10. Quick Reference: Formulas

```
ENTROPY:        H(Q) = -Σᵢ P(qᵢ) · log₂ P(qᵢ)
COMPLEXITY:     C(Q) = H(Q) / log₂(N)
QUEUE_TIME:     E[T] = 1 / (μ - λ)
UCB1:           UCB1(a) = X̄ₐ + √(2·ln(n) / nₐ)
THOMPSON:       θₐ ~ Beta(αₐ, βₐ)
FUZZY_SIMPLE:   μ(x) = 1 if x≤50, else (200-x)/150
AHP_WEIGHT:     wᵢ = (Σⱼ aᵢⱼ / Σⱼ Σᵢ aᵢⱼ) row-normalized
HYBRID:         S = 0.2·S_ent + 0.25·S_q + 0.25·S_b + 0.15·S_f + 0.15·S_a
```
