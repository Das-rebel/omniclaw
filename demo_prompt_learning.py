#!/usr/bin/env python3
"""
Prompt Learning System Demo

Quick test of the prompt learning components:
- PromptLearningStore
- QualityClassifier
- SelfCritiqueAgent

Run:
    python3 demo_prompt_learning.py
"""

from skills.memory import (
    PromptLearningStore,
    QualityClassifier,
    SelfCritiqueAgent,
    PromptLearningIntegration
)


def demo_quality_classifier():
    """Demo: Evaluate response quality"""
    print("\n" + "="*60)
    print("DEMO: Quality Classifier")
    print("="*60)
    
    classifier = QualityClassifier()
    
    # Test cases
    test_cases = [
        {
            "name": "Good coding response",
            "response": """
            Here's a Python function to sort an array:
            
            ```python
            def sort_array(arr):
                return sorted(arr)
            ```
            
            This uses Python's built-in sorted() which implements TimSort
            with O(n log n) complexity.
            """,
            "task": {"description": "Write a Python function to sort an array"}
        },
        {
            "name": "Poor response - too brief",
            "response": "def sort_array(arr): return sorted(arr)",
            "task": {"description": "Write a Python function to sort an array"}
        },
        {
            "name": "Format violation - JSON needed",
            "response": "Here is the data you requested. Name: John, Age: 30",
            "task": {"description": "Return user data as JSON"}
        }
    ]
    
    for tc in test_cases:
        print(f"\n📋 Test: {tc['name']}")
        quality, scores = classifier.evaluate(tc["response"], tc["task"])
        
        print(f"   Quality: {quality:.2f} ({classifier.get_quality_level(quality)})")
        print(f"   Dimensions:")
        for dim, score in scores.items():
            if dim != "error":
                print(f"     - {dim}: {score:.2f}")


def demo_prompt_learning_store():
    """Demo: Store and retrieve patterns"""
    print("\n" + "="*60)
    print("DEMO: Prompt Learning Store")
    print("="*60)
    
    store = PromptLearningStore()
    
    # Store some patterns
    patterns = [
        {
            "task_type": "coding",
            "prompt": "Write a Python function to calculate fibonacci numbers",
            "response": "def fib(n):\n    if n <= 1: return n\n    return fib(n-1) + fib(n-2)",
            "quality": 0.9,
            "provider": "openai",
            "model": "gpt-4"
        },
        {
            "task_type": "coding",
            "prompt": "Write a REST API endpoint in Python with FastAPI",
            "response": "from fastapi import FastAPI\napp = FastAPI()\n@app.get('/items/{item_id}')\nasync def read_item(item_id: int):\n    return {'item_id': item_id}",
            "quality": 0.85,
            "provider": "anthropic",
            "model": "claude-3-sonnet"
        },
        {
            "task_type": "research",
            "prompt": "What is machine learning?",
            "response": "Machine learning is a subset of AI that enables systems to learn from data without being explicitly programmed. It uses algorithms to identify patterns and make decisions.",
            "quality": 0.88,
            "provider": "openai",
            "model": "gpt-4"
        }
    ]
    
    print("\n📝 Storing patterns...")
    for p in patterns:
        pid = store.store_prompt_pattern(**p)
        print(f"   ✓ Stored: {pid[:30]}... (quality: {p['quality']:.2f})")
    
    # Retrieve patterns
    print("\n🔍 Retrieving patterns for 'coding' task:")
    coding_patterns = store.get_prompt_patterns("coding", min_quality=0.8)
    for p in coding_patterns:
        print(f"   - {p['prompt'][:40]}... (quality: {p['quality']:.2f})")
    
    # Build few-shot examples
    print("\n📚 Few-shot examples for 'coding':")
    examples = store.build_few_shot_examples("coding")
    print(examples[:200] if examples else "   (no examples)")
    
    # Quality trends
    print("\n📊 Quality trends:")
    trends = store.analyze_quality_trends()
    for task_type, stats in trends.get("by_task_type", {}).items():
        print(f"   - {task_type}: {stats['count']} patterns, avg quality: {stats['avg_quality']:.2f}")
    
    # Improvement suggestions
    print("\n💡 Improvement suggestions for 'coding':")
    suggestions = store.get_improvement_suggestions("coding")
    for s in suggestions:
        print(f"   → {s}")


async def demo_self_critique():
    """Demo: Analyze failures"""
    print("\n" + "="*60)
    print("DEMO: Self-Critique Agent")
    print("="*60)
    
    critique = SelfCritiqueAgent()
    
    # Test a failing response
    task = {"description": "Write a REST API endpoint that returns JSON"}
    response = "Here's how you make an API endpoint. Use Express. It should work."
    quality = 0.45
    dimension_scores = {
        "task_quality": 0.4,
        "format": 0.3,
        "coherence": 0.6,
        "length": 0.5,
        "safety": 1.0
    }
    
    print(f"\n❌ Analyzing failed response (quality: {quality:.2f})")
    analysis = await critique.analyze_failure(task, response, quality, dimension_scores)
    
    print("\n📋 What went wrong:")
    for issue in analysis["what_went_wrong"][:3]:
        print(f"   - {issue}")
    
    print("\n🔧 Suggested fixes:")
    for fix in analysis["specific_fixes"][:3]:
        print(f"   → {fix}")
    
    print("\n📝 Improved prompt:")
    improved = critique.generate_improved_prompt(task["description"], analysis)
    print(f"   {improved[:150]}...")


async def main():
    """Run all demos"""
    print("\n" + "="*70)
    print("🚀 Prompt Learning System Demo")
    print("="*70)
    
    demo_quality_classifier()
    demo_prompt_learning_store()
    await demo_self_critique()
    
    print("\n" + "="*70)
    print("✅ Demo Complete!")
    print("="*70)
    print("""
Next steps:
1. Integrate with TMLPD agent:
   from omniclaw.skills.memory import enhance_tmlpd_with_learning
   result = await agent.execute(task)
   learning = await enhance_tmlpd_with_learning(agent, task, result)

2. View stored patterns:
   ls ~/.omniclaw/memory/prompt_learning/

3. Get improvement suggestions for your task type:
   store = PromptLearningStore()
   suggestions = store.get_improvement_suggestions("coding")
""")


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())