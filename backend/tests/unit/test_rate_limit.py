"""Failed-sign-in limiter (pure logic) and password helpers."""

import asyncio

from app.rate_limit import FailureLimiter
from app.security import hash_password, token_hash, verify_password


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def make(clock: Clock) -> FailureLimiter:
    return FailureLimiter(3, 5, 60.0, clock)


def test_blocks_after_max_failures_then_recovers_when_window_passes() -> None:
    clock = Clock()
    lim = make(clock)
    for _ in range(3):
        assert lim.retry_after("1.1.1.1", "a@x.io") is None
        lim.record_failure("1.1.1.1", "a@x.io")
    wait = lim.retry_after("1.1.1.1", "a@x.io")
    assert wait is not None and 1 <= wait <= 61
    clock.now += 61
    assert lim.retry_after("1.1.1.1", "a@x.io") is None


def test_other_email_from_same_client_is_not_blocked_until_client_limit() -> None:
    lim = make(Clock())
    for _ in range(3):
        lim.record_failure("c", "a@x.io")
    assert lim.retry_after("c", "b@x.io") is None
    for _ in range(2):
        lim.record_failure("c", "b@x.io")
    assert lim.retry_after("c", "zzz@x.io") is not None  # 5 failures from this client


def test_other_clients_are_unaffected_and_success_resets_pair() -> None:
    lim = make(Clock())
    for _ in range(3):
        lim.record_failure("c1", "a@x.io")
    assert lim.retry_after("c2", "a@x.io") is None
    lim.reset("c1", "a@x.io")
    assert lim.retry_after("c1", "a@x.io") is None


def test_ac1_5_password_is_hashed_with_argon2_and_verifies() -> None:
    h = asyncio.run(hash_password("correct horse"))
    assert h.startswith("$argon2id$") and "correct horse" not in h
    assert asyncio.run(verify_password("correct horse", h)) is True
    assert asyncio.run(verify_password("wrong horse", h)) is False
    assert asyncio.run(verify_password("anything", None)) is False


def test_token_hash_is_sha256_hex() -> None:
    assert len(token_hash("abc")) == 64
    assert token_hash("abc") == token_hash("abc")
