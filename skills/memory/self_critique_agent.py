"""
Self-Critique Agent - Analyzes failures and extracts prompt improvements

Based on gpt-engineer's self-critique pattern and DSPyteleprompter.

Usage:
    critique_agent = SelfCritiqueAgent(provider_executor)
    improvements = await critique_agent.analyze_failure(task, response, quality)
"""

from typing import Dict, List, Any, Optional, Tuple


class SelfCritiqueAgent:
    """
    Analyzes failed responses and extracts actionable improvements.
    
    The loop:
    1. Detect low quality (QualityClassifier)
    2. Analyze why it failed (SelfCritiqueAgent)
    3. Extract specific fixes
    4. Update prompt template
    """

    def __init__(self, llm_provider: Any = None):
        """
        Initialize self-critique agent.
        
        Args:
            llm_provider: LLM executor for analysis (optional - can use rule-based fallback)
        """
        self.llm_provider = llm_provider

    async def analyze_failure(
        self,
        task: Dict[str, Any],
        response: str,
        quality: float,
        dimension_scores: Dict[str, float]
    ) -> Dict[str, Any]:
        """
        Analyze a failed response and extract improvements.
        
        Args:
            task: The task that was executed
            response: The failed response
            quality: Overall quality score
            dimension_scores: Per-dimension scores from QualityClassifier
            
        Returns:
            Dict with: what_went_wrong, why, specific_fixes, updated_prompt_elements
        """
        analysis = {
            "timestamp": None,
            "task_type": self._classify_task(task),
            "quality": quality,
            "dimension_scores": dimension_scores,
            "what_went_wrong": [],
            "why": [],
            "specific_fixes": [],
            "updated_prompt_elements": {}
        }
        
        # Identify failure dimensions
        failure_dimensions = [
            dim for dim, score in dimension_scores.items()
            if score < 0.7 and dim != "error"
        ]
        
        # Analyze each failure
        for dim in failure_dimensions:
            dim_analysis = self._analyze_dimension(dim, task, response, dimension_scores[dim])
            analysis["what_went_wrong"].extend(dim_analysis["issues"])
            analysis["why"].extend(dim_analysis["causes"])
            analysis["specific_fixes"].extend(dim_analysis["fixes"])
        
        # Build updated prompt elements based on fixes
        analysis["updated_prompt_elements"] = self._build_prompt_elements(analysis["specific_fixes"])
        
        return analysis

    def _classify_task(self, task: Dict[str, Any]) -> str:
        """Classify task type for pattern matching"""
        task_desc = task.get("description", "").lower()
        
        if any(k in task_desc for k in ["code", "function", "class", "implement", "python"]):
            return "coding"
        if any(k in task_desc for k in ["research", "find", "search", "information"]):
            return "research"
        if any(k in task_desc for k in ["write", "story", "creative", "brainstorm"]):
            return "creative"
        if any(k in task_desc for k in ["analyze", "compare", "evaluate"]):
            return "analysis"
        
        return "general"

    def _analyze_dimension(
        self,
        dimension: str,
        task: Dict[str, Any],
        response: str,
        score: float
    ) -> Dict[str, List[str]]:
        """
        Analyze a specific failure dimension.
        
        Returns:
            Dict with issues, causes, and fixes
        """
        analysis = {"issues": [], "causes": [], "fixes": []}
        
        if dimension == "task_quality":
            return self._analyze_task_completion(task, response, score)
        
        if dimension == "format":
            return self._analyze_format(task, response, score)
        
        if dimension == "coherence":
            return self._analyze_coherence(response, score)
        
        if dimension == "length":
            return self._analyze_length(task, response, score)
        
        if dimension == "safety":
            return self._analyze_safety(response, score)
        
        return analysis

    def _analyze_task_completion(
        self,
        task: Dict[str, Any],
        response: str,
        score: float
    ) -> Dict[str, List[str]]:
        """Analyze task completion failures"""
        analysis = {"issues": [], "causes": [], "fixes": []}
        
        task_desc = task.get("description", "")
        
        # Check if response is too short
        if len(response.split()) < 30:
            analysis["issues"].append("Response too brief to complete task")
            analysis["causes"].append("Prompt may not specify depth requirement")
            analysis["fixes"].append("Add: 'Provide a detailed response with examples'")
        
        # Check if code task but no code
        if any(k in task_desc.lower() for k in ["code", "function", "implement"]):
            if "```" not in response and not re.search(r'\bdef\b|\bfunction\b', response):
                analysis["issues"].append("Code task but no code provided")
                analysis["causes"].append("Prompt may not explicitly request code")
                analysis["fixes"].append("Add: 'Include working code examples'")
        
        # Check if question not answered
        question_words = ["what", "how", "why", "when", "where", "who"]
        if any(q in task_desc.lower() for q in question_words):
            if response.count("?") > 0 and response.count("?") >= len(task_desc.split()):
                analysis["issues"].append("Question format not followed")
                analysis["causes"].append("Prompt may lack explicit question format")
                analysis["fixes"].append("Start prompt with: 'Answer the following question:'")
        
        return analysis

    def _analyze_format(
        self,
        task: Dict[str, Any],
        response: str,
        score: float
    ) -> Dict[str, List[str]]:
        """Analyze format compliance failures"""
        analysis = {"issues": [], "causes": [], "fixes": []}
        
        task_desc = task.get("description", "").lower()
        
        # JSON format required but not provided
        if "json" in task_desc:
            if not (response.strip().startswith("{") or response.strip().startswith("[")):
                analysis["issues"].append("Required JSON format not provided")
                analysis["causes"].append("Prompt didn't specify JSON requirement clearly")
                analysis["fixes"].append("Add: 'Return your response as valid JSON'")
        
        # Code format required but not provided
        if any(k in task_desc for k in ["code", "python", "javascript"]):
            if response.count("```") == 0:
                analysis["issues"].append("Code formatting not used")
                analysis["causes"].append("Prompt didn't request code formatting")
                analysis["fixes"].append("Add: 'Format code with proper syntax highlighting'")
        
        # List format required but not provided
        if "list" in task_desc:
            if not re.search(r'^\d+[\.\)]|\- |\* ', response, re.MULTILINE):
                analysis["issues"].append("List format not used")
                analysis["causes"].append("Prompt didn't specify list structure")
                analysis["fixes"].append("Add: 'Provide your answer as a numbered list'")
        
        return analysis

    def _analyze_coherence(
        self,
        response: str,
        score: float
    ) -> Dict[str, List[str]]:
        """Analyze coherence failures"""
        analysis = {"issues": [], "causes": [], "fixes": []}
        
        # Check for repetitive content
        words = response.lower().split()
        if len(words) >= 50:
            unique_ratio = len(set(words)) / len(words)
            if unique_ratio < 0.4:
                analysis["issues"].append("Response is repetitive")
                analysis["causes"].append("Prompt may not provide enough structure")
                analysis["fixes"].append("Add: 'Vary your wording and provide distinct points'")
        
        # Check for sentence fragments
        sentences = response.split(".")
        short_sentences = [s for s in sentences if len(s.strip().split()) < 3]
        if len(short_sentences) > len(sentences) * 0.5:
            analysis["issues"].append("Many incomplete sentences")
            analysis["causes"].append("Prompt may need clearer structure")
            analysis["fixes"].append("Add: 'Use complete sentences with proper punctuation'")
        
        return analysis

    def _analyze_length(
        self,
        task: Dict[str, Any],
        response: str,
        score: float
    ) -> Dict[str, List[str]]:
        """Analyze length failures"""
        analysis = {"issues": [], "causes": [], "fixes": []}
        
        word_count = len(response.split())
        
        if word_count < 20:
            analysis["issues"].append("Response too short")
            analysis["causes"].append("Prompt may not specify depth")
            analysis["fixes"].append("Add: 'Provide a comprehensive response (minimum 100 words)'")
        elif word_count > 1000:
            analysis["issues"].append("Response too long")
            analysis["causes"].append("Prompt may not specify brevity")
            analysis["fixes"].append("Add: 'Keep response concise (under 200 words)'")
        
        return analysis

    def _analyze_safety(
        self,
        response: str,
        score: float
    ) -> Dict[str, List[str]]:
        """Analyze safety failures"""
        analysis = {"issues": [], "causes": [], "fixes": []}
        
        # This is mostly for reporting - safety issues need different handling
        analysis["issues"].append("Potential safety concern detected")
        analysis["causes"].append("Response may contain sensitive patterns")
        analysis["fixes"].append("Add: 'Ensure response follows safety guidelines'")
        
        return analysis

    def _build_prompt_elements(self, fixes: List[str]) -> Dict[str, Any]:
        """
        Convert fixes to prompt element updates.
        
        Returns:
            Dict with elements to add to prompts
        """
        elements = {
            "add_constraints": [],
            "add_examples": False,
            "add_format": None,
            "add_depth": None
        }
        
        for fix in fixes:
            fix_lower = fix.lower()
            
            if "constraint" in fix_lower or "include" in fix_lower or "add:" in fix_lower:
                # Extract the constraint from the fix
                constraint = fix.split("Add:")[-1].strip().strip('"').strip("'")
                if constraint:
                    elements["add_constraints"].append(constraint)
            
            if "example" in fix_lower:
                elements["add_examples"] = True
            
            if "json" in fix_lower:
                elements["add_format"] = "json"
            elif "code" in fix_lower or "syntax" in fix_lower:
                elements["add_format"] = "code"
            elif "list" in fix_lower:
                elements["add_format"] = "list"
            
            if "detailed" in fix_lower or "comprehensive" in fix_lower:
                elements["add_depth"] = "detailed"
            elif "concise" in fix_lower or "brief" in fix_lower:
                elements["add_depth"] = "concise"
        
        return elements

    def generate_improved_prompt(
        self,
        original_prompt: str,
        improvements: Dict[str, Any]
    ) -> str:
        """
        Generate an improved prompt based on analysis.
        
        Args:
            original_prompt: The original prompt
            improvements: Output from analyze_failure
            
        Returns:
            Improved prompt string
        """
        improved = original_prompt
        
        # Add constraints
        constraints = improvements.get("updated_prompt_elements", {}).get("add_constraints", [])
        for constraint in constraints:
            improved += f"\n\nConstraint: {constraint}"
        
        # Add format specification
        fmt = improvements.get("updated_prompt_elements", {}).get("add_format")
        if fmt == "json":
            improved += "\n\nFormat: Return valid JSON."
        elif fmt == "code":
            improved += "\n\nFormat: Use code blocks with syntax highlighting."
        elif fmt == "list":
            improved += "\n\nFormat: Use numbered list."
        
        # Add depth specification
        depth = improvements.get("updated_prompt_elements", {}).get("add_depth")
        if depth == "detailed":
            improved += "\n\nDepth: Provide comprehensive details with examples."
        elif depth == "concise":
            improved += "\n\nDepth: Keep response brief and to the point."
        
        return improved

    def summarize_improvements(self, analysis: Dict[str, Any]) -> str:
        """
        Generate a human-readable summary of improvements.
        
        Args:
            analysis: Output from analyze_failure
            
        Returns:
            Summary string
        """
        summary = []
        
        summary.append(f"Quality: {analysis['quality']:.2f}")
        summary.append(f"Task Type: {analysis['task_type']}")
        summary.append("")
        
        if analysis["what_went_wrong"]:
            summary.append("What went wrong:")
            for issue in analysis["what_went_wrong"][:3]:
                summary.append(f"  - {issue}")
            summary.append("")
        
        if analysis["specific_fixes"]:
            summary.append("Suggested fixes:")
            for fix in analysis["specific_fixes"][:3]:
                summary.append(f"  → {fix}")
        
        return "\n".join(summary)