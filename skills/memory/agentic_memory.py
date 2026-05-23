"""
Phase 3a: Episodic Memory Store

JSON-based episodic memory following Memoria framework (arXiv:2512.12686)
and A-Mem pattern (arXiv:2502.12110).

Episodic memory stores specific task executions with full context.
"""

import json
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Any, Optional
from collections import defaultdict
import re


class EpisodicMemoryStore:
    """
    Episodic memory: stores specific task executions.

    Based on Memoria framework (arXiv:2512.12686)
    and A-Mem (arXiv:2502.12110)

    Features:
    - Full context storage
    - Keyword indexing for fast retrieval
    - Importance scoring
    - Time-based decay
    """

    def __init__(self, base_dir: str = ".taskmaster/memory/episodic"):
        """
        Initialize episodic memory store.

        Args:
            base_dir: Directory to store episodic memories
        """
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)

        # Index: keywords -> episode IDs
        self.index_file = self.base_dir / "index.json"
        self.keyword_index = self._load_index()

    def _load_index(self) -> Dict[str, List[str]]:
        """Load keyword index"""
        if self.index_file.exists():
            with open(self.index_file, 'r') as f:
                return json.load(f)
        return {}

    def _save_index(self):
        """Save keyword index"""
        with open(self.index_file, 'w') as f:
            json.dump(self.keyword_index, f, indent=2)

    def store(
        self,
        task: Dict[str, Any],
        result: Dict[str, Any],
        agent_id: str,
        skills: List[str],
        provider: str,
        model: str,
        importance: float = 0.5,
        metadata: Optional[Dict] = None
    ) -> str:
        """
        Store an episodic memory.

        Args:
            task: Task that was executed
            result: Execution result
            agent_id: Agent that executed
            skills: Skills used
            provider: LLM provider used
            model: Model used
            importance: Importance score (0-1)
            metadata: Additional metadata

        Returns:
            Episode ID
        """
        episode_id = f"episode_{uuid.uuid4().hex[:12]}"

        # Extract keywords from task description
        keywords = self._extract_keywords(task.get("description", ""))

        # Create episode
        episode = {
            "id": episode_id,
            "timestamp": datetime.now().isoformat(),
            "task": {
                "description": task.get("description", ""),
                "keywords": keywords,
                "requirements": task.get("requirements", ""),
                "context": task.get("context", "")
            },
            "execution": {
                "agent_id": agent_id,
                "provider": provider,
                "model": model,
                "skills": skills
            },
            "result": {
                "success": result.get("success", False),
                "tokens_used": result.get("tokens_used", 0),
                "cost": result.get("cost", 0.0),
                "execution_time": result.get("execution_time", 0.0),
                "latency_ms": result.get("latency_ms", 0.0)
            },
            "importance": importance,
            "metadata": metadata or {},
            "access_count": 0,
            "last_accessed": datetime.now().isoformat()
        }

        # Save episode to file
        episode_file = self.base_dir / f"{episode_id}.json"
        with open(episode_file, 'w') as f:
            json.dump(episode, f, indent=2)

        # Update keyword index
        for keyword in keywords:
            if keyword not in self.keyword_index:
                self.keyword_index[keyword] = []
            self.keyword_index[keyword].append(episode_id)

        self._save_index()

        return episode_id

    def recall(
        self,
        task: Dict[str, Any],
        top_k: int = 5,
        min_importance: float = 0.0,
        max_age_days: int = 30
    ) -> List[Dict[str, Any]]:
        """
        Recall relevant episodes based on task similarity.

        Args:
            task: Current task
            top_k: Maximum number of episodes to return
            min_importance: Minimum importance threshold
            max_age_days: Maximum age of episodes (days)

        Returns:
            List of relevant episodes with similarity scores
        """
        # Extract keywords from current task
        task_keywords = self._extract_keywords(task.get("description", ""))

        # Find episodes with keyword overlap
        episode_scores = defaultdict(float)

        for keyword in task_keywords:
            if keyword in self.keyword_index:
                for episode_id in self.keyword_index[keyword]:
                    episode_scores[episode_id] += 1.0

        # Load and score episodes
        scored_episodes = []
        cutoff_date = datetime.now() - timedelta(days=max_age_days)

        for episode_id, score in episode_scores.items():
            # Load episode
            episode_file = self.base_dir / f"{episode_id}.json"

            if not episode_file.exists():
                continue

            with open(episode_file, 'r') as f:
                episode = json.load(f)

            # Check age
            episode_date = datetime.fromisoformat(episode["timestamp"])
            if episode_date < cutoff_date:
                continue

            # Check importance
            if episode["importance"] < min_importance:
                continue

            # Calculate final score
            # Keyword similarity (40%)
            keyword_score = score / max(len(task_keywords), 1)

            # Recency boost (20%) - more recent = higher score
            days_old = (datetime.now() - episode_date).days
            recency_score = max(0, 1 - days_old / 365)  # Decays over 1 year

            # Access frequency boost (20%)
            access_score = min(episode["access_count"] / 100, 1.0)

            # Importance boost (20%)
            importance_score = episode["importance"]

            total_score = (
                keyword_score * 0.4 +
                recency_score * 0.2 +
                access_score * 0.2 +
                importance_score * 0.2
            )

            scored_episodes.append({
                "episode": episode,
                "similarity": keyword_score,
                "total_score": total_score
            })

            # Update access count
            episode["access_count"] += 1
            episode["last_accessed"] = datetime.now().isoformat()

            # Save updated episode
            with open(episode_file, 'w') as f:
                json.dump(episode, f, indent=2)

        # Sort by total score
        scored_episodes.sort(key=lambda x: x["total_score"], reverse=True)

        return scored_episodes[:top_k]

    def get_episode(self, episode_id: str) -> Optional[Dict[str, Any]]:
        """Get specific episode by ID"""
        episode_file = self.base_dir / f"{episode_id}.json"

        if not episode_file.exists():
            return None

        with open(episode_file, 'r') as f:
            return json.load(f)

    def _extract_keywords(self, text: str) -> set:
        """
        Extract keywords from text.

        Removes common stop_words and short words.
        """
        # Stop words
        stop_words = {
            "the", "a", "an", "and", "or", "but", "in", "on", "at", "to",
            "for", "of", "with", "by", "from", "as", "is", "was", "are",
            "been", "be", "have", "has", "had", "do", "does", "did", "will",
            "would", "should", "could", "may", "might", "can", "this", "that"
        }

        # Extract words
        words = re.findall(r'\w+', text.lower())

        # Filter
        keywords = {
            w for w in words
            if w not in stop_words and len(w) > 2
        }

        return keywords

    def get_stats(self) -> Dict[str, Any]:
        """Get episodic memory statistics"""
        total_episodes = len(list(self.base_dir.glob("*.json")))

        # Calculate stats
        total_importance = 0.0
        total_tokens = 0
        total_cost = 0.0

        for episode_file in self.base_dir.glob("*.json"):
            with open(episode_file, 'r') as f:
                episode = json.load(f)

            total_importance += episode.get("importance", 0)
            total_tokens += episode["result"]["tokens_used"]
            total_cost += episode["result"]["cost"]

        return {
            "total_episodes": total_episodes,
            "total_keywords": len(self.keyword_index),
            "avg_importance": total_importance / total_episodes if total_episodes > 0 else 0,
            "total_tokens": total_tokens,
            "total_cost": total_cost,
            "avg_cost_per_episode": total_cost / total_episodes if total_episodes > 0 else 0
        }

    def cleanup_old_episodes(self, days_old: int = 90):
        """
        Remove episodes older than specified days.

        Args:
            days_old: Age threshold in days
        """
        cutoff_date = datetime.now() - timedelta(days=days_old)
        removed_count = 0

        for episode_file in self.base_dir.glob("*.json"):
            with open(episode_file, 'r') as f:
                episode = json.load(f)

            episode_date = datetime.fromisoformat(episode["timestamp"])

            if episode_date < cutoff_date:
                # Remove from keyword index
                for keyword, episode_list in self.keyword_index.items():
                    if episode["id"] in episode_list:
                        episode_list.remove(episode["id"])

                # Delete file
                episode_file.unlink()
                removed_count += 1

        # Save updated index
        self._save_index()

        print(f"Removed {removed_count} episodes older than {days_old} days")

    def export_episodes(self, output_path: str, criteria: Optional[Dict] = None):
        """
        Export episodes to JSON file.

        Args:
            output_path: Path to output file
            criteria: Optional filtering criteria
        """
        episodes = []

        for episode_file in self.base_dir.glob("*.json"):
            with open(episode_file, 'r') as f:
                episode = json.load(f)

            # Apply filters if provided
            if criteria:
                if "min_importance" in criteria:
                    if episode["importance"] < criteria["min_importance"]:
                        continue

                if "provider" in criteria:
                    if episode["execution"]["provider"] != criteria["provider"]:
                        continue

            episodes.append(episode)

        # Write to output
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        with open(output_path, 'w') as f:
            json.dump(episodes, f, indent=2)

        print(f"Exported {len(episodes)} episodes to {output_path}")
