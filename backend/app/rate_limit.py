"""In-memory sliding-window limiter for failed sign-ins.

State is per process (one app container today); a restart clears it. Keys are hashed so
emails are never held as plain keys. Good enough to slow online guessing (#8).
"""

import hashlib
import ipaddress
import time
from collections import deque
from collections.abc import Callable


SWEEP_EVERY = 512  # calls to `try_acquire` between sweeps of stale clients


def client_key(host: str | None) -> str:
    """The rate-limit key for a client address: IPv6 clients group by their /64 prefix, so
    rotating addresses inside one prefix does not escape the limit; IPv4 is kept as is."""
    if not host:
        return "unknown"
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return host
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return str(ip.ipv4_mapped)
        return str(ipaddress.ip_network(f"{ip}/64", strict=False))
    return str(ip)


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
        self._calls = 0

    @staticmethod
    def _keys(client: str, email: str) -> tuple[str, str]:
        pair = hashlib.sha256(f"{client}\0{email}".encode()).hexdigest()
        return f"p:{pair}", f"c:{client}"

    def _sweep(self) -> None:
        """Forget clients that haven't been seen for a whole window, so a stream of one-off
        addresses (an open endpoint such as the calendar feed, #381) can't grow the table."""
        cutoff = self._clock() - self._window
        for key in [k for k, q in self._failures.items() if not q or q[-1] <= cutoff]:
            del self._failures[key]

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
        self._calls += 1
        if self._calls % SWEEP_EVERY == 0:
            self._sweep()
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
            # Pop the newest entry. If another attempt from this client started meanwhile, the
            # entry removed may be theirs rather than ours, but entries are only timestamps,
            # so the count is still right (this refund removes exactly one). At worst the
            # surviving timestamp is a little older, which expires sooner.
            q.pop()
            if not q:
                self._failures.pop(client_key, None)
