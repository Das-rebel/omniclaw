"""
Prompt Learning Store - Captures successful prompt patterns

Extends EpisodicMemoryStore to capture what makes prompts successful.
Based on DSPy Teleprompter pattern and gpt-engineer self-critique.

Usage:
    store = PromptLearningStore()
    store.store_prompt_pattern(
        task_type="coding",
        prompt="Write a Python function...",
        response="def sort_array():...",
        quality=0.9,
        provider="openai",
        model="gpt-4"
    )
"""

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Any, Optional, Tuple
from collections import defaultdict


class PromptLearningStore:
    """
    Captures and retrieves successful prompt patterns.
    
    Features:
    - Stores prompt + response pairs with quality scores
    - Extracts what worked (prompt elements, constraints, examples)
    - Builds few-shot examples from stored patterns
    - Classifies task types automatically
    """

    def __init__(self, base_dir: str = ".omniclaw/memory/prompt_learning"):
        """
        Initialize prompt learning store.
        
        Args:
            base_dir: Directory to store prompt patterns
        """
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)
        
        self.patterns_file = self.base_dir / "patterns.json"
        self.quality_file = self.base_dir / "quality_history.json"
        self.templates_file = self.base_dir / "compiled_templates.json"
        
        self.patterns = self._load_patterns()
        self.quality_history = self._load_quality_history()
        self.templates = self._load_templates()

    def _load_patterns(self) -> Dict:
        """Load stored patterns"""
        if self.patterns_file.exists():
            with open(self.patterns_file, 'r') as f:
                return json.load(f)
        return {"by_task_type": defaultdict(list), "by_hash": {}}

    def _save_patterns(self):
        """Save patterns to disk"""
        with open(self.patterns_file, 'w') as f:
            json.dump(self.patterns, f, indent=2)

    def _load_quality_history(self) -> List[Dict]:
        """Load quality evaluation history"""
        if self.quality_file.exists():
            with open(self.quality_file, 'r') as f:
                return json.load(f)
        return []

    def _save_quality_history(self):
        """Save quality history"""
        with open(self.quality_file, 'w') as f:
            json.dump(self.quality_history, f, indent=2)

    def _load_templates(self) -> Dict:
        """Load compiled prompt templates"""
        if self.templates_file.exists():
            with open(self.templates_file, 'r') as f:
                return json.load(f)
        return {}

    def _save_templates(self):
        """Save compiled templates"""
        with open(self.templates_file, 'w') as f:
            json.dump(self.templates, f, indent=2)

    def classify_task(self, task_description: str) -> str:
        """
        Classify task into categories for pattern matching.
        
        Categories:
        - coding: Writing, debugging, refactoring code
        - research: Searching, analyzing, summarizing information
        - creative: Writing stories, brainstorming ideas
        - analysis: Data analysis, comparisons, evaluations
        - planning: Roadmaps, strategies, scheduling
        - general: Unclassified tasks
        """
        task_lower = task_description.lower()
        
        # Coding patterns
        coding_keywords = ['code', 'python', 'javascript', 'function', 'class', 
                         'debug', 'fix', 'implement', 'api', 'script', 'sql',
                         'write code', 'programming', 'typescript', 'react']
        if any(kw in task_lower for kw in coding_keywords):
            return "coding"
        
        # Research patterns
        research_keywords = ['research', 'find', 'search', 'lookup', 'find me',
                           'what is', 'how to', 'explain', 'information', 'tell me about']
        if any(kw in task_lower for kw in research_keywords):
            return "research"
        
        # Creative patterns
        creative_keywords = ['write', 'story', 'blog', 'creative', 'brainstorm',
                           'generate', 'idea', 'design', 'plan', 'outline']
        if any(kw in task_lower for kw in creative_keywords):
            return "creative"
        
        # Analysis patterns
        analysis_keywords = ['analyze', 'compare', 'evaluate', 'review', 'score',
                           'rank', 'assess', 'calculate', 'measure']
        if any(kw in task_lower for kw in analysis_keywords):
            return "analysis"
        
        # Planning patterns
        planning_keywords = ['plan', 'roadmap', 'strategy', 'schedule', 'timeline',
                           'roadmap', 'milestones', 'agenda']
        if any(kw in task_lower for kw in planning_keywords):
            return "planning"
        
        return "general"

    def extract_prompt_elements(self, prompt: str, response: str = "") -> Dict:
        """
        Extract what elements make this prompt effective.
        
        Returns:
            Dict with has_system_context, has_constraints, has_examples, etc.
        """
        elements = {}
        
        # Check for system context
        elements['has_system_context'] = bool(
            re.search(r'system|prompt|instruction|role|you are|context', prompt.lower())
        )
        
        # Check for constraints
        constraints_found = re.findall(
            r'(must|should|need to|required|important|only|do not|avoid)',
            prompt,
            re.IGNORECASE
        )
        elements['constraint_count'] = len(constraints_found)
        
        # Check for examples (few-shot)
        elements['has_examples'] = bool(
            re.search(r'for example|example:|e\.g\.|such as|like this', prompt, re.IGNORECASE)
        )
        
        # Prompt length buckets
        word_count = len(prompt.split())
        if word_count < 20:
            elements['length_category'] = 'short'
        elif word_count < 100:
            elements['length_category'] = 'medium'
        elif word_count < 500:
            elements['length_category'] = 'long'
        else:
            elements['length_category'] = 'extended'
        
        elements['word_count'] = word_count
        
        # Format indicators
        elements['has_formatting'] = bool(
            re.search(r'\n|```|\d+\.|- |\t|step', prompt)
        )
        
        # Response length (indicator of task complexity handled)
        if response:
            elements['response_word_count'] = len(response.split())
        
        return elements

    def store_prompt_pattern(
        self,
        task_type: str,
        prompt: str,
        response: str,
        quality: float,
        provider: str,
        model: str,
        metadata: Optional[Dict] = None
    ) -> str:
        """
        Store a successful prompt pattern.
        
        Args:
            task_type: Category of task (coding, research, etc.)
            prompt: The prompt that worked
            response: The successful response
            quality: Quality score (0-1)
            provider: LLM provider used
            model: Model used
            metadata: Additional metadata
            
        Returns:
            Pattern ID
        """
        pattern_id = f"pattern_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{hash(prompt[:50]) % 10000}"
        
        # Extract what worked
        elements = self.extract_prompt_elements(prompt, response)
        
        # Build pattern structure
        pattern = {
            "id": pattern_id,
            "timestamp": datetime.now().isoformat(),
            "task_type": task_type,
            "quality": quality,
            "prompt": prompt,
            "response_preview": response[:500] if response else "",
            "elements": elements,
            "execution": {
                "provider": provider,
                "model": model
            },
            "metadata": metadata or {},
            "use_count": 0,
            "last_used": datetime.now().isoformat()
        }
        
        # Store by task type
        self.patterns["by_task_type"][task_type].append(pattern)
        
        # Store by prompt hash for dedup
        prompt_hash = hash(prompt)
        self.patterns["by_hash"][str(prompt_hash)] = pattern_id
        
        self._save_patterns()
        
        # Record quality history
        self.quality_history.append({
            "timestamp": datetime.now().isoformat(),
            "task_type": task_type,
            "quality": quality,
            "provider": provider,
            "model": model
        })
        self._save_quality_history()
        
        return pattern_id

    def get_prompt_patterns(
        self,
        task_type: str,
        min_quality: float = 0.7,
        top_k: int = 5
    ) -> List[Dict]:
        """
        Get best prompt patterns for task type.
        
        Args:
            task_type: Category to search
            min_quality: Minimum quality threshold
            top_k: Maximum patterns to return
            
        Returns:
            List of prompt patterns sorted by quality
        """
        patterns = self.patterns["by_task_type"].get(task_type, [])
        
        # Filter by quality and sort
        high_quality = [p for p in patterns if p.get("quality", 0) >= min_quality]
        high_quality.sort(key=lambda x: x.get("quality", 0), reverse=True)
        
        return high_quality[:top_k]

    def build_few_shot_examples(self, task_type: str, top_k: int = 3) -> str:
        """
        Build few-shot examples from stored patterns.
        
        Args:
            task_type: Category of task
            top_k: Number of examples to include
            
        Returns:
            Formatted few-shot examples string
        """
        patterns = self.get_prompt_patterns(task_type, min_quality=0.8, top_k=top_k)
        
        if not patterns:
            return ""
        
        examples = []
        for i, p in enumerate(patterns):
            examples.append(
                f"Example {i+1} (quality: {p['quality']:.2f}):\n"
                f"Task: {p['prompt'][:200]}...\n"
                f"Response: {p['response_preview'][:150]}..."
            )
        
        return "\n\n".join(examples)

    def analyze_quality_trends(self) -> Dict:
        """
        Analyze quality trends across stored patterns.
        
        Returns:
            Dict with quality stats by task type and provider
        """
        if not self.quality_history:
            return {"error": "No quality history yet"}
        
        stats = {
            "by_task_type": defaultdict(lambda: {"count": 0, "avg_quality": 0, "total_quality": 0}),
            "by_provider": defaultdict(lambda: {"count": 0, "avg_quality": 0}),
            "overall": {"count": 0, "avg_quality": 0}
        }
        
        for entry in self.quality_history:
            task_type = entry.get("task_type", "unknown")
            provider = entry.get("provider", "unknown")
            quality = entry.get("quality", 0)
            
            stats["by_task_type"][task_type]["count"] += 1
            stats["by_task_type"][task_type]["total_quality"] += quality
            stats["by_task_type"][task_type]["avg_quality"] = (
                stats["by_task_type"][task_type]["total_quality"] / 
                stats["by_task_type"][task_type]["count"]
            )
            
            stats["by_provider"][provider]["count"] += 1
            stats["by_provider"][provider]["avg_quality"] = (
                sum(e["quality"] for e in self.quality_history if e.get("provider") == provider) /
                stats["by_provider"][provider]["count"]
            )
            
            stats["overall"]["count"] += 1
            stats["overall"]["avg_quality"] += quality
        
        stats["overall"]["avg_quality"] /= stats["overall"]["count"]
        
        return dict(stats)

    def get_improvement_suggestions(self, task_type: str) -> List[str]:
        """
        Get prompt improvement suggestions based on stored patterns.
        
        Args:
            task_type: Category to get suggestions for
            
        Returns:
            List of improvement suggestions
        """
        patterns = self.get_prompt_patterns(task_type, min_quality=0.6, top_k=10)
        
        if len(patterns) < 3:
            return ["Not enough patterns yet. Keep using prompts to build patterns."]
        
        suggestions = []
        
        # Analyze element patterns
        has_context_count = sum(1 for p in patterns if p.get("elements", {}).get("has_system_context"))
        has_examples_count = sum(1 for p in patterns if p.get("elements", {}).get("has_examples"))
        avg_length = sum(p.get("elements", {}).get("word_count", 0) for p in patterns) / len(patterns)
        
        # Suggest based on patterns
        if has_context_count / len(patterns) > 0.7:
            suggestions.append("✓ Most successful prompts have clear system context")
        elif has_context_count / len(patterns) < 0.3:
            suggestions.append("→ Add system context to improve quality")
        
        if has_examples_count / len(patterns) > 0.5:
            suggestions.append("✓ Including examples leads to better responses")
        elif has_examples_count / len(patterns) < 0.2:
            suggestions.append("→ Try adding examples (few-shot) for this task type")
        
        if avg_length < 50:
            suggestions.append("→ Longer prompts tend to work better for this task type")
        elif avg_length > 300:
            suggestions.append("✓ Detailed prompts work well for this task type")
        
        return suggestions if suggestions else ["Patterns look healthy. Keep using!"]