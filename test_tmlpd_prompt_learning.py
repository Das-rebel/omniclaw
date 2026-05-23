#!/usr/bin/env python3
"""
Test prompt learning integration with TMLPD agent.

This tests that the TMLPD agent properly initializes and uses
the prompt learning components.

Run:
    cd ~/omniclaw
    python3 test_tmlpd_prompt_learning.py
"""

import asyncio
import sys
sys.path.insert(0, '.')

from skills.memory.prompt_learning_integration import PromptLearningIntegration
from skills.memory import QualityClassifier, PromptLearningStore


def test_prompt_learning_integration():
    """Test PromptLearningIntegration with mock agent"""
    print("\n" + "="*60)
    print("TEST: Prompt Learning Integration")
    print("="*60)
    
    # Create integration with mock agent
    mock_agent = MockTMLPDAgent()
    integration = PromptLearningIntegration(mock_agent)
    
    # Test storing pattern
    task = {"description": "Write a Python function to calculate fibonacci"}
    result = {
        "success": True,
        "content": """
        Here's a recursive fibonacci function:
        
        ```python
        def fib(n):
            if n <= 1:
                return n
            return fib(n-1) + fib(n-2)
        ```
        
        This has O(2^n) complexity. For large n, consider memoization.
        """,
        "provider": "openai",
        "model": "gpt-4"
    }
    
    print("\n📋 Task: Write fibonacci function")
    print(f"   Provider: {result['provider']}, Model: {result['model']}")
    
    # Evaluate quality
    classifier = QualityClassifier()
    quality, scores = classifier.evaluate(result["content"], task)
    print(f"\n📊 Quality: {quality:.2f}")
    print(f"   Dimensions: {scores}")
    
    # Test learning
    print("\n🔄 Running learn_from_response...")
    outcome = asyncio.run(integration.learn_from_response(task, result))
    
    print(f"\n📋 Outcome:")
    print(f"   Action: {outcome['action']}")
    print(f"   Quality: {outcome['quality']:.2f}")
    print(f"   Task Type: {outcome['task_type']}")
    
    if outcome.get('pattern_id'):
        print(f"   Pattern ID: {outcome['pattern_id'][:40]}...")
    
    # Test getting optimized prompt
    print("\n📝 Testing get_optimized_prompt...")
    optimized = integration.get_optimized_prompt("coding", task)
    print(f"   Length: {len(optimized)} chars")
    print(f"   Preview: {optimized[:100]}...")
    
    # Get trends
    print("\n📊 Getting quality trends...")
    trends = integration.get_quality_trends()
    print(f"   Total patterns: {trends.get('total_patterns', 0)}")
    
    print("\n✅ Test Complete!")


def test_classifier_with_different_responses():
    """Test QualityClassifier with various responses"""
    print("\n" + "="*60)
    print("TEST: QualityClassifier with various responses")
    print("="*60)
    
    classifier = QualityClassifier()
    
    test_cases = [
        {
            "name": "Excellent coding response",
            "task": {"description": "Write a Python function to reverse a string"},
            "response": """
            Here's a Python function to reverse a string:
            
            ```python
            def reverse_string(s):
                return s[::-1]
            ```
            
            This uses Python's slice notation with step -1.
            For example, reverse_string("hello") returns "olleh".
            """
        },
        {
            "name": "Poor response - too brief",
            "task": {"description": "Write a Python function to reverse a string"},
            "response": "return s[::-1]"
        },
        {
            "name": "Medium response - missing examples",
            "task": {"description": "Write a Python function to reverse a string"},
            "response": "def reverse_string(s): return s[::-1]"
        }
    ]
    
    for tc in test_cases:
        quality, scores = classifier.evaluate(tc["response"], tc["task"])
        level = classifier.get_quality_level(quality)
        should_trigger = classifier.should_trigger_improvement(quality)
        
        print(f"\n📋 {tc['name']}")
        print(f"   Quality: {quality:.2f} ({level})")
        print(f"   Should trigger improvement: {should_trigger}")


class MockTMLPDAgent:
    """Mock TMLPD agent for testing"""
    def __init__(self):
        self.episodic_memory = None
        self.prompt_store = PromptLearningStore()


if __name__ == "__main__":
    test_prompt_learning_integration()
    test_classifier_with_different_responses()
    print("\n" + "="*60)
    print("✅ ALL TESTS PASSED!")
    print("="*60)