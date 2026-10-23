"""In-memory sliding-window limiter for failed sign-ins.

State is per process (one app container today); a restart clears it. Keys are hashed so
emails are never held as plain keys. Good enough to slow online guessing (#8).
"""

import hashlib
import time
from collections import deque
from collections.abc import Callable


class FailureLimiter:
    def __init__(
        self,
        max_failures: int,
        max_failures_per_client: int,
        window_seconds: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._limits = (max_failures, max_failures_per_client)
        self._window = window_seconds
        self._clock = clock
        self._failures: dict[str, deque[float]] = {}

    @staticmethod
    def _keys(client: str, email: str) -> tuple[str, str]:
        pair = hashlib.sha256(f"{client}\0{email}".encode()).hexdigest()
        return f"p:{pair}", f"c:{client}"

    def _recent(self, key: str) -> deque[float]:
        q = self._failures.setdefault(key, deque())
        cutoff = self._clock() - self._window
        while q and q[0] <= cutoff:
            q.popleft()
        if not q:
            self._failures.pop(key, None)
        return q

    def retry_after(self, client: str, email: str) -> int | None:
        """Seconds until another attempt is allowed, or None if one is allowed now."""
        waits = []
        for key, limit in zip(self._keys(client, email), self._limits, strict=True):
            q = self._recent(key)
            if len(q) >= limit:
                waits.append(q[0] + self._window - self._clock())
        return max(1, int(max(waits)) + 1) if waits else None

    def record_failure(self, client: str, email: str) -> None:
        now = self._clock()
        for key in self._keys(client, email):
            self._failures.setdefault(key, deque()).append(now)

    def reset(self, client: str, email: str) -> None:
        """A successful sign-in clears the pair's count (the per-client count keeps ageing)."""
        self._failures.pop(self._keys(client, email)[0], None)
