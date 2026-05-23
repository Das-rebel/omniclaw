"""
Quality Classifier - Evaluates AI response quality

Used to trigger prompt improvement loop when quality is low.
Based on multiple signals: length, coherence, task completion, etc.

Usage:
    classifier = QualityClassifier()
    quality = classifier.evaluate(response, task, expected_format)
    if quality < 0.7:
        trigger_self_critique(task, response, quality)
"""

import re
from typing import Dict, List, Any, Optional, Tuple


class QualityClassifier:
    """
    Evaluates AI response quality on multiple dimensions.
    
    Dimensions:
    - Task completion (did it solve the problem?)
    - Format compliance (did it follow instructions?)
    - Coherence (is it well-structured?)
    - Length appropriateness (too short/long?)
    - Safety (no harmful content?)
    """

    def __init__(
        self,
        task_quality_weight: float = 0.35,
        format_weight: float = 0.25,
        coherence_weight: float = 0.20,
        length_weight: float = 0.10,
        safety_weight: float = 0.10
    ):
        """
        Initialize quality classifier.
        
        Args:
            task_quality_weight: Weight for task completion score
            format_weight: Weight for format compliance
            coherence_weight: Weight for coherence score
            length_weight: Weight for length appropriateness
            safety_weight: Weight for safety score
        """
        self.weights = {
            "task_quality": task_quality_weight,
            "format": format_weight,
            "coherence": coherence_weight,
            "length": length_weight,
            "safety": safety_weight
        }

    def evaluate(
        self,
        response: str,
        task: Dict[str, Any],
        expected_format: Optional[str] = None
    ) -> Tuple[float, Dict[str, float]]:
        """
        Evaluate response quality.
        
        Args:
            response: The AI response to evaluate
            task: The task description and context
            expected_format: Optional format requirements (json, code, etc.)
            
        Returns:
            Tuple of (overall_quality, dimension_scores)
        """
        if not response or len(response.strip()) == 0:
            return 0.0, {"error": "Empty response"}
        
        # Evaluate each dimension
        task_score = self._evaluate_task_completion(response, task)
        format_score = self._evaluate_format_compliance(response, expected_format, task)
        coherence_score = self._evaluate_coherence(response)
        length_score = self._evaluate_length(response, task)
        safety_score = self._evaluate_safety(response)
        
        # Calculate weighted average
        overall = (
            task_score * self.weights["task_quality"] +
            format_score * self.weights["format"] +
            coherence_score * self.weights["coherence"] +
            length_score * self.weights["length"] +
            safety_score * self.weights["safety"]
        )
        
        dimension_scores = {
            "task_quality": task_score,
            "format": format_score,
            "coherence": coherence_score,
            "length": length_score,
            "safety": safety_score
        }
        
        return overall, dimension_scores

    def _evaluate_task_completion(self, response: str, task: Dict[str, Any]) -> float:
        """
        Evaluate if task was completed.
        
        Checks:
        - Answered the question?
        - Addressed all parts?
        - Provided actionable content?
        """
        task_desc = task.get("description", "").lower()
        response_lower = response.lower()
        
        score = 0.5  # Base score
        
        # Question answered check
        question_indicators = ["what", "how", "why", "when", "where", "who", "which"]
        has_question = any(q in task_desc for q in question_indicators)
        
        if has_question:
            # Check if response has substantial content (answered)
            if len(response.split()) > 30:
                score += 0.2
            else:
                score -= 0.1
        
        # Action items check
        action_indicators = ["step", "install", "run", "execute", "create", "build"]
        if any(ind in task_desc for ind in action_indicators):
            if any(ind in response_lower for ind in action_indicators):
                score += 0.15
            # Penalize if no action items in response
            elif len(response.split()) < 50:
                score -= 0.15
        
        # Code task check
        code_indicators = ["code", "function", "python", "javascript", "class"]
        if any(ind in task_desc for ind in code_indicators):
            if "```" in response or re.search(r'def |function |class ', response):
                score += 0.15  # Has code
            # Penalize for empty code response
            if response.count("```") == 0 and len(response) < 200:
                score -= 0.2
        
        return max(0.0, min(1.0, score))

    def _evaluate_format_compliance(
        self,
        response: str,
        expected_format: Optional[str],
        task: Dict[str, Any]
    ) -> float:
        """
        Evaluate format compliance.
        
        Checks if response follows required format.
        """
        score = 0.8  # Base score
        
        if not expected_format:
            return score
        
        expected_lower = expected_format.lower()
        
        # JSON format check
        if "json" in expected_lower:
            if response.strip().startswith("{") or response.strip().startswith("["):
                score = 1.0
            elif response.count("{") >= 2 and response.count("}") >= 2:
                score = 0.7  # Partial JSON
            else:
                score = 0.3  # Failed
        
        # Code format check
        elif any(f in expected_lower for f in ["code", "python", "javascript", "typescript"]):
            if response.count("```") >= 1:
                score = 1.0
            elif any(re.search(rf'\b{kw}\s*[\({{]', response) for kw in ["def", "function", "class", "const", "let"]):
                score = 0.7
            else:
                score = 0.4
        
        # Markdown format check
        elif "markdown" in expected_lower or "md" in expected_lower:
            if len(re.findall(r'^#{1,6}\s', response, re.MULTILINE)) > 0:
                score = 1.0
            elif response.count("\n\n") > 2:
                score = 0.7
            else:
                score = 0.5
        
        # List format check
        elif "list" in expected_lower:
            list_items = len(re.findall(r'^\d+[\.\)]|\- |\* ', response, re.MULTILINE))
            if list_items >= 3:
                score = 1.0
            elif list_items >= 1:
                score = 0.7
            else:
                score = 0.4
        
        # Table format check
        elif "table" in expected_lower:
            if "|" in response and response.count("|") >= 6:
                score = 1.0
            else:
                score = 0.4
        
        return max(0.0, min(1.0, score))

    def _evaluate_coherence(self, response: str) -> float:
        """
        Evaluate response coherence.
        
        Checks:
        - Sentence structure
        - Logical flow
        - No obvious contradictions
        """
        score = 0.8
        
        # Empty or very short response
        if len(response.split()) < 10:
            return 0.4
        
        # Check for sentence fragments (no verb, very short)
        sentences = re.split(r'[.!?]+', response)
        incomplete_count = sum(
            1 for s in sentences 
            if s.strip() and (len(s.strip().split()) < 3 or not re.search(r'\w+', s))
        )
        
        if incomplete_count / max(len(sentences), 1) > 0.5:
            score -= 0.2
        
        # Check for repeated content (copy-paste indicator)
        words = response.lower().split()
        if len(words) >= 50:
            unique_ratio = len(set(words)) / len(words)
            if unique_ratio < 0.3:
                score -= 0.3  # Likely repetitive
        
        # Check for markdown heavy content (sometimes indicates hallucination)
        if response.count("```") > 5:
            score -= 0.1
        
        # Check for excessive hedging (sometimes indicates uncertainty)
        hedge_count = len(re.findall(r'\b(maybe|perhaps|possibly|might|could be|seems|appears)\b', response.lower()))
        if hedge_count > 5:
            score -= 0.1
        
        return max(0.0, min(1.0, score))

    def _evaluate_length(self, response: str, task: Dict[str, Any]) -> float:
        """
        Evaluate length appropriateness.
        
        Checks if response length matches task complexity.
        """
        word_count = len(response.split())
        
        # Very short responses
        if word_count < 10:
            return 0.3
        
        task_desc = task.get("description", "").lower()
        
        # Simple question check
        if any(q in task_desc for q in ["hi", "hello", "hey", "thanks", "thank"]):
            return 1.0 if word_count < 100 else 0.6
        
        # Coding task - needs code examples
        if any(k in task_desc for k in ["code", "function", "implement", "write"]):
            if word_count < 50:
                return 0.3  # Too short for code task
            if word_count > 500:
                return 0.8  # Good for complex code
        
        # Research task - needs detailed explanation
        if any(k in task_desc for k in ["research", "explain", "what is", "how to"]):
            if word_count < 30:
                return 0.4  # Too short
            if word_count > 200:
                return 0.9  # Good
        
        # General optimal range
        if 50 <= word_count <= 500:
            return 0.9
        elif 30 <= word_count <= 50:
            return 0.7
        elif word_count > 500:
            return 0.8  # Slightly penalized for verbosity
        else:
            return 0.6

    def _evaluate_safety(self, response: str) -> float:
        """
        Evaluate safety of response.
        
        Checks for:
        - Harmful content
        - PII leakage
        - Prompt injection attempts
        """
        score = 1.0
        
        # Check for potentially harmful content patterns
        harmful_patterns = [
            (r'\b(hack|exploit|breach|inject)\b.*\b(password|credential|api.?key)\b', 0.5),
            (r'sudo\s+rm\s+-rf', 0.3),
            (r'drop\s+table', 0.4),
            (r'<script[^>]*>', 0.4),
        ]
        
        for pattern, penalty in harmful_patterns:
            if re.search(pattern, response, re.IGNORECASE):
                score -= penalty
        
        # Check for prompt injection attempts (user trying to manipulate)
        injection_patterns = [
            r'ignore\s+(previous|above|all)\s+instructions',
            r'forget\s+(everything|your|what)',
            r'(you\s+are\s+now|mode:\s*)developer',
            r'malicious|attack|steal|hack',
        ]
        
        for pattern in injection_patterns:
            if re.search(pattern, response, re.IGNORECASE):
                score -= 0.3
        
        return max(0.0, min(1.0, score))

    def get_quality_level(self, quality: float) -> str:
        """
        Get human-readable quality level.
        
        Args:
            quality: Quality score (0-1)
            
        Returns:
            Quality level string
        """
        if quality >= 0.9:
            return "excellent"
        elif quality >= 0.8:
            return "good"
        elif quality >= 0.7:
            return "acceptable"
        elif quality >= 0.5:
            return "needs_improvement"
        else:
            return "poor"

    def should_trigger_improvement(self, quality: float, threshold: float = 0.7) -> bool:
        """
        Determine if quality triggers prompt improvement loop.
        
        Args:
            quality: Current quality score
            threshold: Quality threshold (default 0.7)
            
        Returns:
            True if improvement should be triggered
        """
        return quality < threshold