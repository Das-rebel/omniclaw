"""
TMLPD v2.1 - Unified Agent

Integration layer combining all phases:
- Phase 1: Multi-Provider System
- Phase 2: Difficulty-Aware Routing
- Phase 3: Advanced Memory System
- Phase 4: Workflow Executors

Built by TMLPD using parallel execution.
"""

import asyncio
from typing import Dict, List, Any, Optional
from datetime import datetime
from pathlib import Path

# Import all components
from .providers.registry import MultiProviderExecutor, IntelligentRouter
from .skills.skill_manager import SkillManager
from .workflows.difficulty_integration import DifficultyAwareSkillAgent
from .workflows.advanced_difficulty_classifier import AdvancedDifficultyClassifier
from .workflows.chaining_executor import ChainingExecutor
from .workflows.parallelization_executor import ParallelizationExecutor
from .workflows.orchestrator_executor import OrchestratorExecutor
from .memory.agentic_memory import EpisodicMemoryStore
from .memory.semantic_memory import SemanticMemoryStore
from .memory.working_memory import WorkingMemoryCache
from .memory.prompt_learning_store import PromptLearningStore
from .memory.quality_classifier import QualityClassifier
from .memory.self_critique_agent import SelfCritiqueAgent
from .memory.prompt_learning_integration import PromptLearningIntegration


class TMLPDUnifiedAgent:
    """
    Unified TMLPD v2.1 Agent with all capabilities.

    Features:
    - Multi-provider support with intelligent routing
    - Difficulty-aware task classification
    - Three-tier memory system (episodic, semantic, working)
    - Advanced workflow execution (chain, parallel, orchestrator)
    - Skill integration
    - Cost optimization (40-60% savings)

    Usage:
        agent = TMLPDUnifiedAgent()
        await agent.initialize()

        result = await agent.execute({
            "description": "Build a REST API with authentication"
        })

        await agent.cleanup()
    """

    def __init__(
        self,
        provider_config: Optional[str] = None,
        skills_dir: str = "tmlpd-skills",
        memory_dir: str = ".taskmaster/memory",
        use_chromadb: bool = False,
        enable_learning: bool = True
    ):
        """
        Initialize TMLPD unified agent.

        Args:
            provider_config: Path to provider configuration
            skills_dir: Directory containing skills
            memory_dir: Directory for memory storage
            use_chromadb: Whether to use ChromaDB for semantic memory
            enable_learning: Enable learning from past executions
        """
        # Configuration
        self.provider_config = provider_config
        self.skills_dir = skills_dir
        self.memory_dir = Path(memory_dir)
        self.use_chromadb = use_chromadb
        self.enable_learning = enable_learning

        # Components (initialized in initialize())
        self.provider_executor = None
        self.skill_manager = None
        self.difficulty_classifier = None

        # Workflow executors
        self.difficulty_agent = None
        self.chaining_executor = None
        self.parallel_executor = None
        self.orchestrator = None

        # Memory system
        self.episodic_memory = None
        self.semantic_memory = None
        self.working_memory = None

        # Prompt learning system
        self.prompt_learning = None  # Initialized in initialize()
        self.quality_classifier = None
        self.self_critique = None

        # Statistics
        self.stats = {
            "total_executions": 0,
            "successful_executions": 0,
            "total_cost": 0.0,
            "total_tokens": 0,
            "total_time": 0.0
        }

    async def initialize(self):
        """Initialize all components"""
        print("\n🚀 Initializing TMLPD v2.1 Unified Agent")

        # Initialize provider system
        print("\n📦 Phase 1: Multi-Provider System")
        self.provider_executor = MultiProviderExecutor(self.provider_config)
        await self.provider_executor.start()

        status = self.provider_executor.get_status()
        print(f"   ✓ Providers: {status['registry']['total_providers']}")
        print(f"   ✓ Healthy: {status['registry']['healthy_providers']}")

        # Initialize skill manager
        print("\n📚 Phase 2: Skill System")
        self.skill_manager = SkillManager(self.skills_dir)
        skill_count = len(list(Path(self.skills_dir).rglob("SKILL.md")))
        print(f"   ✓ Loaded {skill_count} skills")

        # Initialize difficulty classifier
        print("\n🎯 Phase 2: Difficulty-Aware Routing")
        self.difficulty_classifier = AdvancedDifficultyClassifier(
            learning_enabled=self.enable_learning
        )
        print("   ✓ Advanced difficulty classifier ready")

        # Initialize workflow executors
        print("\n⚙️  Phase 4: Workflow Executors")

        self.difficulty_agent = DifficultyAwareSkillAgent(
            skills_dir=self.skills_dir,
            provider_config=self.provider_config
        )
        await self.difficulty_agent.start()
        print("   ✓ Difficulty-aware skill agent")

        self.chaining_executor = ChainingExecutor(
            self.provider_executor,
            self.skill_manager
        )
        print("   ✓ Chaining executor")

        self.parallel_executor = ParallelizationExecutor(
            self.provider_executor,
            self.skill_manager
        )
        print("   ✓ Parallelization executor")

        self.orchestrator = OrchestratorExecutor(
            self.provider_executor,
            self.skill_manager
        )
        print("   ✓ Orchestrator executor")

        # Initialize memory system
        print("\n🧠 Phase 3: Advanced Memory System")

        self.episodic_memory = EpisodicMemoryStore(
            str(self.memory_dir / "episodic")
        )
        print("   ✓ Episodic memory (JSON)")

        self.semantic_memory = SemanticMemoryStore(
            str(self.memory_dir / "semantic"),
            use_chromadb=self.use_chromadb
        )
        print(f"   ✓ Semantic memory ({'ChromaDB' if self.use_chromadb else 'keyword-based'})")

        self.working_memory = WorkingMemoryCache()
        print("   ✓ Working memory (cache)")

        # Initialize prompt learning system
        print("\n🧠 Phase 3b: Prompt Learning System")
        self.quality_classifier = QualityClassifier()
        self.self_critique = SelfCritiqueAgent()
        self.prompt_learning = PromptLearningIntegration(self)
        print("   ✓ Quality classifier")
        print("   ✓ Self-critique agent")
        print("   ✓ Prompt learning integration")

        print("\n✅ TMLPD v2.1 Agent Ready!")
        print(f"   Multi-provider: ✓")
        print(f"   Difficulty-aware routing: ✓")
        print(f"   Advanced memory: ✓")
        print(f"   Prompt learning: ✓")
        print(f"   Workflow executors: ✓")
        print(f"   Skill integration: ✓")

    async def execute(
        self,
        task: Dict[str, Any],
        mode: str = "auto",
        store_memory: bool = True,
        use_memory: bool = True
    ) -> Dict[str, Any]:
        """
        Execute task with full TMLPD capabilities.

        Args:
            task: Task to execute
            mode: Execution mode ("auto", "orchestrator", "chain", "parallel", "direct")
            store_memory: Store execution in episodic memory
            use_memory: Use past experiences from memory

        Returns:
            Execution result with metadata
        """
        if not self.provider_executor:
            raise RuntimeError("Agent not initialized. Call await agent.initialize() first.")

        start_time = datetime.now()

        # Update stats
        self.stats["total_executions"] += 1

        print(f"\n{'='*70}")
        print(f"🎯 TMLPD v2.1 Execution #{self.stats['total_executions']}")
        print(f"{'='*70}")

        # Step 1: Recall relevant experiences (if enabled)
        relevant_episodes = []
        if use_memory:
            print("\n🧠 Recalling relevant experiences...")
            relevant_episodes = self.episodic_memory.recall(
                task,
                top_k=3,
                min_importance=0.3
            )

            if relevant_episodes:
                print(f"   ✓ Found {len(relevant_episodes)} relevant episodes")

                # Add to working memory
                self.working_memory.set(
                    f"current_task_relevant_episodes",
                    relevant_episodes,
                    ttl=3600,
                    category="memory"
                )

        # Step 2: Classify difficulty
        print("\n📊 Classifying task difficulty...")
        classification = self.difficulty_classifier.classify_difficulty(task)
        difficulty = classification["difficulty"]
        score = classification["score"]

        print(f"   Difficulty: {difficulty} (score: {score:.1f})")
        print(f"   Confidence: {classification['confidence']*100:.0f}%")

        # Step 3: Select execution mode
        if mode == "auto":
            # Use orchestrator for automatic mode selection
            print(f"\n🎮 Using orchestrator mode")
            result = await self.orchestrator.execute(task, strategy="auto")

        elif mode == "orchestrator":
            print(f"\n🎮 Using orchestrator mode")
            result = await self.orchestrator.execute(task, strategy="auto")

        elif mode == "chain":
            print(f"\n🔗 Using chain mode")
            # Decompose and execute sequentially
            result = await self.orchestrator.execute(task, strategy="chain")

        elif mode == "parallel":
            print(f"\n🚀 Using parallel mode")
            # Decompose and execute concurrently
            result = await self.orchestrator.execute(task, strategy="parallel")

        elif mode == "direct":
            print(f"\n⚡ Using direct mode")
            # Execute directly without decomposition
            result = await self.orchestrator.execute(task, strategy="direct")

        else:
            raise ValueError(f"Unknown mode: {mode}")

        end_time = datetime.now()
        execution_time = (end_time - start_time).total_seconds()

        # Step 4: Store in episodic memory
        if store_memory and result.get("success"):
            print("\n💾 Storing execution in episodic memory...")

            # Calculate importance
            importance = self._calculate_importance(task, result, classification)

            episode_id = self.episodic_memory.store(
                task=task,
                result={
                    "success": result.get("success", False),
                    "tokens_used": result.get("tokens_used", 0),
                    "cost": result.get("cost", 0.0),
                    "execution_time": execution_time
                },
                agent_id="tmlpd_v2.1",
                skills=[],
                provider=result.get("provider", "unknown"),
                model=result.get("model", "unknown"),
                importance=importance,
                metadata={
                    "difficulty": difficulty,
                    "strategy": result.get("orchestrator_metadata", {}).get("strategy", "unknown"),
                    "mode": mode
                }
            )

            print(f"   ✓ Stored as {episode_id}")

            # Store in working memory for quick access
            self.working_memory.set(
                f"last_execution",
                {
                    "task": task,
                    "result": result,
                    "episode_id": episode_id
                },
                ttl=7200,
                category="recent_executions"
            )

        # Step 5: Record outcome for learning (if enabled)
        if self.enable_learning:
            actual_difficulty = self._determine_actual_difficulty(result, execution_time)
            self.difficulty_classifier.record_outcome(
                task=task,
                predicted_difficulty=difficulty,
                actual_difficulty=actual_difficulty,
                execution_time=execution_time,
                success=result.get("success", False)
            )

        # Step 5b: Learn from response (prompt learning)
        if self.prompt_learning:
            learning_outcome = await self.prompt_learning.learn_from_response(task, result)
            if learning_outcome.get("action") == "stored_pattern":
                print(f"\n   📚 Stored prompt pattern: {learning_outcome.get('pattern_id', '')[:30]}...")
            elif learning_outcome.get("action") == "analyzed_failure":
                print(f"\n   🔧 Prompt improvement triggered (quality: {learning_outcome.get('quality', 0):.2f})")

        # Update statistics
        if result.get("success"):
            self.stats["successful_executions"] += 1

        self.stats["total_cost"] += result.get("cost", 0.0)
        self.stats["total_tokens"] += result.get("tokens_used", 0)
        self.stats["total_time"] += execution_time

        # Print summary
        print(f"\n{'='*70}")
        print(f"📊 Execution Summary")
        print(f"{'='*70}")
        print(f"Status: {'✅ Success' if result.get('success') else '❌ Failed'}")
        print(f"Time: {execution_time:.2f}s")
        print(f"Cost: ${result.get('cost', 0.0):.6f}")
        print(f"Tokens: {result.get('tokens_used', 0)}")
        print(f"Provider: {result.get('provider', 'unknown')}")
        print(f"Model: {result.get('model', 'unknown')}")
        print(f"{'='*70}\n")

        return result

    def _calculate_importance(
        self,
        task: Dict[str, Any],
        result: Dict[str, Any],
        classification: Dict[str, Any]
    ) -> float:
        """Calculate importance score for memory storage"""
        importance = 0.5  # Base importance

        # Higher importance for complex tasks
        difficulty = classification["difficulty"]
        if difficulty == "EXPERT":
            importance += 0.3
        elif difficulty == "COMPLEX":
            importance += 0.2
        elif difficulty == "MEDIUM":
            importance += 0.1

        # Higher importance for successful executions
        if result.get("success"):
            importance += 0.1

        # Higher importance for expensive tasks (learn from them)
        cost = result.get("cost", 0.0)
        if cost > 1.0:
            importance += 0.1

        return min(importance, 1.0)

    def _determine_actual_difficulty(
        self,
        result: Dict[str, Any],
        execution_time: float
    ) -> str:
        """Determine actual difficulty based on execution metrics"""
        # Simple heuristic based on execution time
        if execution_time < 5:
            return "TRIVIAL"
        elif execution_time < 15:
            return "SIMPLE"
        elif execution_time < 30:
            return "MEDIUM"
        elif execution_time < 60:
            return "COMPLEX"
        else:
            return "EXPERT"

    def get_stats(self) -> Dict[str, Any]:
        """Get agent statistics"""
        success_rate = (
            self.stats["successful_executions"] / self.stats["total_executions"]
            if self.stats["total_executions"] > 0 else 0
        )

        return {
            **self.stats,
            "success_rate": success_rate,
            "avg_cost_per_execution": (
                self.stats["total_cost"] / self.stats["total_executions"]
                if self.stats["total_executions"] > 0 else 0
            ),
            "avg_time_per_execution": (
                self.stats["total_time"] / self.stats["total_executions"]
                if self.stats["total_executions"] > 0 else 0
            ),
            "episodic_memory_stats": self.episodic_memory.get_stats(),
            "semantic_memory_stats": self.semantic_memory.get_stats(),
            "working_memory_stats": self.working_memory.get_stats(),
            "learning_stats": self.difficulty_classifier.get_learning_stats() if self.enable_learning else {},
            "prompt_learning_stats": self.prompt_learning.get_quality_trends() if self.prompt_learning else {}
        }

    async def cleanup(self):
        """Cleanup and shutdown"""
        print("\n🧹 Cleaning up TMLPD v2.1 Agent...")

        if self.provider_executor:
            await self.provider_executor.stop()

        if self.difficulty_agent:
            await self.difficulty_agent.stop()

        print("✅ Cleanup complete")

    async def __aenter__(self):
        """Async context manager entry"""
        await self.initialize()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit"""
        await self.cleanup()


# Convenience function for quick usage
async def execute_task(
    description: str,
    mode: str = "auto",
    **kwargs
) -> Dict[str, Any]:
    """
    Quick task execution helper.

    Usage:
        result = await execute_task("Build a REST API")
    """
    agent = TMLPDUnifiedAgent()

    try:
        await agent.initialize()
        result = await agent.execute(
            {"description": description},
            mode=mode,
            **kwargs
        )
        return result
    finally:
        await agent.cleanup()
