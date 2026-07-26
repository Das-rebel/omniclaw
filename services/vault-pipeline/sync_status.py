#!/usr/bin/env python3
"""
Vault Sync v2 — Structured Status Tracking
Reads and writes the sync-status.json file.
This is the single source of truth for pipeline health.
"""

import json
import sys
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional

# ─── Schema ─────────────────────────────────────────────────────────────────

SCHEMA_VERSION = "2.0"
PIPELINE_VERSION = "2.0.0"

STATUS_FILE = Path(__file__).parent / "sync-status.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_status() -> dict:
    """Read the current status file. Returns empty dict if missing or invalid."""
    if not STATUS_FILE.exists():
        return {}
    try:
        return json.loads(STATUS_FILE.read_text())
    except Exception:
        return {}


def write_status(status: dict) -> None:
    """Write the status file atomically (write-then-rename)."""
    status["schema_version"] = SCHEMA_VERSION
    status["pipeline_version"] = PIPELINE_VERSION
    status["_written_at"] = _now()

    tmp = STATUS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(status, indent=2, ensure_ascii=False))
    tmp.rename(STATUS_FILE)


def init_status() -> dict:
    """Initialize a fresh status dict for a new run."""
    status = read_status()
    status["last_run"] = _now()
    status["running"] = True
    status.setdefault("errors", [])
    write_status(status)
    return status


def mark_success(
    stage: str,
    details: Optional[dict] = None,
    warnings: Optional[list] = None,
) -> dict:
    """
    Mark a stage as succeeded.
    If stage already has an error, does not overwrite.
    """
    status = read_status()
    status.setdefault("stages", {})
    status["stages"][stage] = {"status": "ok"}
    if details:
        status["stages"][stage].update(details)
    if warnings is not None:
        status["warnings"] = warnings
    if "running" in status:
        del status["running"]
    status["last_success"] = _now()
    write_status(status)
    return status


def mark_error(
    stage: str,
    error_code: str,
    error_detail: str,
    action_required: str = "",
) -> dict:
    """
    Mark a stage as failed with structured error info.
    """
    status = read_status()
    status.setdefault("stages", {})
    status["stages"][stage] = {
        "status": "error",
        "error_code": error_code,
        "error_detail": error_detail,
    }
    if action_required:
        status["stages"][stage]["action_required"] = action_required

    # Append to errors array (deduplicated by error_code)
    errors = status.setdefault("errors", [])
    if not any(e.get("error_code") == error_code for e in errors):
        errors.append({
            "stage": stage,
            "error_code": error_code,
            "error_detail": error_detail,
            "action_required": action_required,
            "timestamp": _now(),
        })

    if "running" in status:
        del status["running"]
    write_status(status)
    return status


def mark_skipped(stage: str, reason: str) -> dict:
    """Mark a stage as skipped (not an error)."""
    status = read_status()
    status.setdefault("stages", {})
    status["stages"][stage] = {"status": "skipped", "reason": reason}
    write_status(status)
    return status


def mark_enrich_warning(msg: str) -> dict:
    """Add an enrichment-specific warning without failing the stage."""
    status = read_status()
    warnings = status.setdefault("warnings", [])
    if msg not in warnings:
        warnings.append(msg)
    write_status(status)
    return status


def set_duration(seconds: float) -> dict:
    """Record how long the full pipeline took."""
    status = read_status()
    status["duration_sec"] = round(seconds, 1)
    write_status(status)
    return status


def main():
    """CLI for reading/writing status from shell scripts."""
    cmd = sys.argv[1] if len(sys.argv) > 1 else "read"

    if cmd == "read":
        s = read_status()
        print(json.dumps(s, indent=2))

    elif cmd == "init":
        init_status()
        print("Status initialized")

    elif cmd == "success":
        stage = sys.argv[2] if len(sys.argv) > 2 else "unknown"
        details = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None
        warnings = json.loads(sys.argv[4]) if len(sys.argv) > 4 else None
        mark_success(stage, details, warnings)
        print(f"Stage '{stage}' marked success")

    elif cmd == "error":
        stage = sys.argv[2] if len(sys.argv) > 2 else "unknown"
        error_code = sys.argv[3] if len(sys.argv) > 3 else "UNKNOWN"
        error_detail = sys.argv[4] if len(sys.argv) > 4 else ""
        action_required = sys.argv[5] if len(sys.argv) > 5 else ""
        mark_error(stage, error_code, error_detail, action_required)
        print(f"Stage '{stage}' marked error: {error_code}")

    elif cmd == "skipped":
        stage = sys.argv[2] if len(sys.argv) > 2 else "unknown"
        reason = sys.argv[3] if len(sys.argv) > 3 else ""
        mark_skipped(stage, reason)
        print(f"Stage '{stage}' skipped: {reason}")

    elif cmd == "duration":
        secs = float(sys.argv[2]) if len(sys.argv) > 2 else 0
        set_duration(secs)
        print(f"Duration set: {secs}s")

    elif cmd == "enrich-warning":
        msg = sys.argv[2] if len(sys.argv) > 2 else ""
        mark_enrich_warning(msg)
        print(f"Enrich warning: {msg}")

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
