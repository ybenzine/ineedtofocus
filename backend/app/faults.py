"""Operator-only fault injection: the trigger for the session-save alert (#33).

`FAULT_SAVE_ERROR_PERCENT` (0 to 100, default 0) is the share of session save requests
(`POST /api/sessions` and `POST /api/sessions/sync`) that fail on purpose. Only the
operator can set it: it is an environment variable the app reads once at startup
(`app.config.Settings`), so changing it means editing the environment's server `.env`
and recreating the app container. No endpoint reads or changes it, and it is off unless
set.

A request picked to fail raises `InjectedSaveFault` before anything is written, inside
the handler's `observe` block, so it fails exactly like an unexpected server error: the
client gets a 500 and keeps the session in its offline queue to retry later (nothing is
lost), every session in the request counts as `outcome="error"` in `focus.session.saves`,
and the log line and trace carry the exception type `InjectedSaveFault`, so whoever is on
call can tell an injected fault from a real one (_docs/observability.md, Alerts).
"""

import random
from collections.abc import Callable


class InjectedSaveFault(RuntimeError):
    """A session save failed on purpose (FAULT_SAVE_ERROR_PERCENT)."""


def maybe_fail_save(percent: float, draw: Callable[[], float] | None = None) -> None:
    """Raise `InjectedSaveFault` for `percent`% of calls (0: never, 100: always). `draw`
    returns a number in [0, 1); the default is `random.random`."""
    if percent > 0 and (draw or random.random)() * 100 < percent:
        raise InjectedSaveFault("session save failed on purpose (FAULT_SAVE_ERROR_PERCENT)")
