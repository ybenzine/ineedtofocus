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

    def try_acquire(self, client: str, email: str) -> int | None:
        """Count a sign-in attempt, atomically (no await between check and count).

        Returns None when the attempt may proceed (it is now counted), or the seconds to
        wait when over the limit (then nothing is counted). Call `succeeded` on success.
        """
        keys = self._keys(client, email)
        waits = []
        for key, limit in zip(keys, self._limits, strict=True):
            q = self._recent(key)
            if len(q) >= limit:
                waits.append(q[0] + self._window - self._clock())
        if waits:
            return max(1, int(max(waits)) + 1)
        now = self._clock()
        for key in keys:
            self._failures.setdefault(key, deque()).append(now)
        return None

    def succeeded(self, client: str, email: str) -> None:
        """Refund a successful attempt: clear the pair's count and this attempt's client count."""
        pair_key, client_key = self._keys(client, email)
        self._failures.pop(pair_key, None)
        q = self._failures.get(client_key)
        if q:
            q.pop()
            if not q:
                self._failures.pop(client_key, None)
