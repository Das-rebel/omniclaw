"""
TMLPD Memory Module

Provides memory stores for pattern learning and prompt optimization.

Components:
- EpisodicMemoryStore: Stores task executions with context
- SemanticMemoryStore: Vector-based pattern storage (optional ChromaDB)
- PromptLearningStore: Captures successful prompt patterns for optimization
- QualityClassifier: Evaluates response quality to trigger improvement
- SelfCritiqueAgent: Analyzes failures and extracts prompt improvements
"""

from .simple_memory import (
    SimpleProjectMemory,
    remember_success
)
from .agentic_memory import EpisodicMemoryStore
from .semantic_memory import SemanticMemoryStore
from .prompt_learning_store import PromptLearningStore
from .quality_classifier import QualityClassifier
from .self_critique_agent import SelfCritiqueAgent

__all__ = [
    # Core memory
    "SimpleProjectMemory",
    "remember_success",
    "EpisodicMemoryStore",
    "SemanticMemoryStore",
    
    # Prompt learning (new)
    "PromptLearningStore",
    "QualityClassifier",
    "SelfCritiqueAgent",
]

# Quick usage example:
#
# from omniclaw.skills.memory import PromptLearningStore, QualityClassifier, SelfCritiqueAgent
#
# # Initialize
# prompt_store = PromptLearningStore()
# classifier = QualityClassifier()
# critique = SelfCritiqueAgent()
#
# # After response
# quality, scores = classifier.evaluate(response, task)
#
# # Store pattern if good
# if quality >= 0.8:
#     prompt_store.store_prompt_pattern(
#         task_type=prompt_store.classify_task(task["description"]),
#         prompt=original_prompt,
#         response=response,
#         quality=quality,
#         provider=provider,
#         model=model
#     )
#
# # Analyze failure if poor
# if quality < 0.7:
#     analysis = await critique.analyze_failure(task, response, quality, scores)
#     improved_prompt = critique.generate_improved_prompt(original_prompt, analysis)