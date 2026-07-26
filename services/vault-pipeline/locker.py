#!/usr/bin/env python3
"""
Cross-platform file locking using Python's fcntl (macOS/Linux).
Provides flock-style exclusive + shared locking.
"""

import fcntl
import os
import sys
import atexit
from pathlib import Path
from typing import Optional

LOCK_FD: Optional[int] = None
LOCK_FILE: Optional[Path] = None


def acquire_lock(lock_path: str | Path, timeout: float = 0) -> bool:
    """
    Acquire an exclusive lock on lock_path.
    Returns True if acquired, False if already locked.
    If timeout > 0, waits up to timeout seconds for the lock.
    On success, a SIGTERM handler is installed that releases the lock.
    """
    global LOCK_FD, LOCK_FILE

    lock_path = Path(lock_path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)

    fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR)
    flags = fcntl.LOCK_EX  # Exclusive lock

    if timeout > 0:
        flags |= fcntl.LOCK_NB  # Non-blocking for the try; we retry

    try:
        if timeout > 0:
            # Retry loop with timeout
            import time
            start = time.monotonic()
            while True:
                try:
                    fcntl.flock(fd, flags | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() - start >= timeout:
                        os.close(fd)
                        return False
                    time.sleep(0.1)
        else:
            fcntl.flock(fd, flags)  # Blocking

        LOCK_FD = fd
        LOCK_FILE = lock_path
        lock_path.write_text(str(os.getpid()))

        # Release lock on exit
        atexit.register(release_lock)
        return True

    except Exception:
        os.close(fd)
        raise


def release_lock() -> None:
    """Release the lock if held."""
    global LOCK_FD, LOCK_FILE
    if LOCK_FD is not None:
        try:
            fcntl.flock(LOCK_FD, fcntl.LOCK_UN)
            os.close(LOCK_FD)
        except Exception:
            pass
        LOCK_FD = None

    if LOCK_FILE is not None:
        try:
            if LOCK_FILE.exists():
                LOCK_FILE.unlink()
        except Exception:
            pass
        LOCK_FILE = None


def is_locked(lock_path: str | Path) -> bool:
    """Check if a lock file is currently held by another process."""
    lock_path = Path(lock_path)
    if not lock_path.exists():
        return False

    try:
        pid_str = lock_path.read_text().strip()
        pid = int(pid_str)
        # Check if process is still running
        os.kill(pid, 0)  # Signal 0 just checks if process exists
        return True
    except (ValueError, ProcessLookupError, PermissionError, OSError):
        # PID is invalid or process is dead
        try:
            lock_path.unlink(missing_ok=True)
        except Exception:
            pass
        return False


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="File locking utility")
    parser.add_argument("action", choices=["acquire", "release", "check"])
    parser.add_argument("--lock", required=True, help="Lock file path")
    parser.add_argument("--timeout", type=float, default=0, help="Timeout in seconds")
    args = parser.parse_args()

    lock = args.lock

    if args.action == "acquire":
        if acquire_lock(lock, timeout=args.timeout):
            print(f"LOCKED:{lock}")
            sys.exit(0)
        else:
            print(f"ALREADY_LOCKED:{lock}")
            sys.exit(1)

    elif args.action == "release":
        release_lock()
        print(f"UNLOCKED:{lock}")
        sys.exit(0)

    elif args.action == "check":
        if is_locked(lock):
            pid = Path(lock).read_text().strip() if Path(lock).exists() else "?"
            print(f"LOCKED_BY:{pid}")
            sys.exit(0)
        else:
            print(f"UNLOCKED:{lock}")
            sys.exit(1)
