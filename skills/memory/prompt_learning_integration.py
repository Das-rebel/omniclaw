"""
Prompt Learning Integration for TMLPD

Adds self-improving prompt capabilities to TMLPDUnifiedAgent.

Usage:
    from omniclaw.skills.memory.prompt_learning_integration import PromptLearningIntegration
    
    integration = PromptLearningIntegration(tmlpd_agent)
    
    # After execute() returns, call:
    await integration.learn_from_response(task, result)
    
    # To build optimized prompts:
    optimized = integration.get_optimized_prompt(task_type, current_task)
"""

from typing import Dict, Any, Optional
from .prompt_learning_store import PromptLearningStore
from .quality_classifier import QualityClassifier
from .self_critique_agent import SelfCritiqueAgent


class PromptLearningIntegration:
    """
    Integrates prompt learning with TMLPD agent execution.
    
    Call learn_from_response() after each execution to:
    - Store successful patterns
    - Trigger self-critique on failures
    
    Call get_optimized_prompt() before execution to:
    - Build prompts with few-shot examples from past successes
    """

    def __init__(self, tmlpd_agent: Any = None):
        """
        Initialize prompt learning integration.
        
        Args:
            tmlpd_agent: TMLPDUnifiedAgent instance (optional)
        """
        self.agent = tmlpd_agent
        
        # Initialize components
        self.prompt_store = PromptLearningStore()
        self.classifier = QualityClassifier()
        self.critique = SelfCritiqueAgent()
        
        # Configuration
        self.quality_threshold_high = 0.8  # Store pattern
        self.quality_threshold_low = 0.7   # Trigger critique

    async def learn_from_response(
        self,
        task: Dict[str, Any],
        response: Dict[str, Any],
        original_prompt: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Learn from a response - store good patterns, critique bad ones.
        
        Args:
            task: Task that was executed
            response: Response from execution
            original_prompt: The prompt used (if different from task description)
            
        Returns:
            Dict with learning outcome and any improvements generated
        """
        outcome = {
            "action": None,
            "quality": 0.0,
            "task_type": self.prompt_store.classify_task(task.get("description", "")),
            "pattern_id": None,
            "improvements": None
        }
        
        # Get response content
        response_content = response.get("content", "") or response.get("result", {}).get("content", "")
        
        if not response_content:
            outcome["action"] = "skipped_empty_response"
            return outcome
        
        # Determine prompt used
        prompt_used = original_prompt or task.get("description", "")
        
        # Evaluate quality
        quality, dimension_scores = self.classifier.evaluate(
            response_content,
            task,
            expected_format=task.get("format")
        )
        
        outcome["quality"] = quality
        outcome["dimension_scores"] = dimension_scores
        
        # Get provider/model info
        provider = response.get("provider", "unknown")
        model = response.get("model", "unknown")
        
        if quality >= self.quality_threshold_high:
            # Store successful pattern
            pattern_id = self.prompt_store.store_prompt_pattern(
                task_type=outcome["task_type"],
                prompt=prompt_used,
                response=response_content,
                quality=quality,
                provider=provider,
                model=model,
                metadata={
                    "success": response.get("success", False),
                    "difficulty": response.get("difficulty", "unknown")
                }
            )
            
            outcome["action"] = "stored_pattern"
            outcome["pattern_id"] = pattern_id
            
            # If agent provided, update its episodic memory
            if self.agent and self.agent.episodic_memory:
                self.agent.episodic_memory.store(
                    task=task,
                    result={
                        "success": response.get("success", False),
                        "quality": quality
                    },
                    agent_id="prompt_learning",
                    skills=[],
                    provider=provider,
                    model=model,
                    importance=quality  # Use quality as importance
                )
        
        elif quality < self.quality_threshold_low:
            # Trigger self-critique
            analysis = await self.critique.analyze_failure(
                task,
                response_content,
                quality,
                dimension_scores
            )
            
            outcome["action"] = "analyzed_failure"
            outcome["improvements"] = analysis
            
            # Optionally update agent's memory with failure context
            if self.agent and self.agent.episodic_memory:
                self.agent.episodic_memory.store(
                    task=task,
                    result={
                        "success": False,
                        "quality": quality,
                        "failure_analysis": self.critique.summarize_improvements(analysis)
                    },
                    agent_id="prompt_learning",
                    skills=[],
                    provider=provider,
                    model=model,
                    importance=quality
                )
        
        else:
            outcome["action"] = "acceptable_no_learning"
        
        return outcome

    def get_optimized_prompt(
        self,
        task_type: str,
        current_task: Dict[str, Any]
    ) -> str:
        """
        Build an optimized prompt using stored patterns.
        
        Args:
            task_type: Category of current task
            current_task: The current task description
            
        Returns:
            Optimized prompt with few-shot examples (or original if no patterns)
        """
        # Get best patterns for this task type
        patterns = self.prompt_store.get_prompt_patterns(
            task_type,
            min_quality=0.8,
            top_k=3
        )
        
        if not patterns:
            return current_task.get("description", "")
        
        # Build few-shot examples
        examples = self.prompt_store.build_few_shot_examples(task_type, top_k=3)
        
        if not examples:
            return current_task.get("description", "")
        
        # Get base prompt
        base_prompt = current_task.get("description", "")
        
        # Build optimized prompt with examples
        optimized = (
            f"{base_prompt}\n\n"
            f"## Reference Examples (learn from these patterns):\n"
            f"{examples}\n\n"
            f"## Task:\n"
            f"{base_prompt}"
        )
        
        return optimized

    def get_task_type(self, task: Dict[str, Any]) -> str:
        """Classify task type for prompt learning"""
        return self.prompt_store.classify_task(task.get("description", ""))

    def get_quality_trends(self) -> Dict:
        """Get quality trends analysis"""
        return self.prompt_store.analyze_quality_trends()

    def get_improvement_suggestions(self, task_type: str) -> list:
        """Get prompt improvement suggestions for task type"""
        return self.prompt_store.get_improvement_suggestions(task_type)


# Integration helper for TMLPDUnifiedAgent
async def enhance_tmlpd_with_learning(
    agent: Any,
    task: Dict[str, Any],
    result: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Helper to enhance TMLPD execution with prompt learning.
    
    Call this after agent.execute() returns.
    
    Usage:
        agent = TMLPDUnifiedAgent()
        await agent.initialize()
        
        result = await agent.execute({"description": "Build a REST API"})
        
        # Add prompt learning
        learning = await enhance_tmlpd_with_learning(agent, {"description": "Build a REST API"}, result)
        print(f"Learned: {learning['action']}")
    """
    integration = PromptLearningIntegration(agent)
    return await integration.learn_from_response(task, result)