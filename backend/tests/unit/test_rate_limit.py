"""Failed-sign-in limiter (pure logic) and password helpers."""

import asyncio

from app.rate_limit import FailureLimiter, client_key
from app.security import hash_password, token_hash, verify_password


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def make(clock: Clock) -> FailureLimiter:
    return FailureLimiter(3, 5, 60.0, clock)


def test_blocks_after_max_attempts_then_recovers_when_window_passes() -> None:
    clock = Clock()
    lim = make(clock)
    for _ in range(3):
        assert lim.try_acquire("1.1.1.1", "a@x.io") is None
    wait = lim.try_acquire("1.1.1.1", "a@x.io")
    assert wait is not None and 1 <= wait <= 61
    clock.now += 61
    assert lim.try_acquire("1.1.1.1", "a@x.io") is None


def test_other_email_from_same_client_is_not_blocked_until_client_limit() -> None:
    lim = make(Clock())
    for _ in range(3):
        assert lim.try_acquire("c", "a@x.io") is None
    assert lim.try_acquire("c", "b@x.io") is None  # 4th for the client
    assert lim.try_acquire("c", "b@x.io") is None  # 5th
    assert lim.try_acquire("c", "zzz@x.io") is not None  # client limit of 5 reached


def test_other_clients_are_unaffected_and_success_refunds() -> None:
    lim = make(Clock())
    for _ in range(3):
        lim.try_acquire("c1", "a@x.io")
    assert lim.try_acquire("c2", "a@x.io") is None
    assert lim.try_acquire("c1", "a@x.io") is not None  # blocked: nothing counted
    lim2 = make(Clock())
    for _ in range(2):
        lim2.try_acquire("c1", "a@x.io")
    assert lim2.try_acquire("c1", "a@x.io") is None
    lim2.succeeded("c1", "a@x.io")
    for _ in range(3):
        assert lim2.try_acquire("c1", "a@x.io") is None


def test_ac1_5_password_is_hashed_with_argon2_and_verifies() -> None:
    h = asyncio.run(hash_password("correct horse"))
    assert h.startswith("$argon2id$") and "correct horse" not in h
    assert asyncio.run(verify_password("correct horse", h)) is True
    assert asyncio.run(verify_password("wrong horse", h)) is False
    assert asyncio.run(verify_password("anything", None)) is False


def test_token_hash_is_sha256_hex() -> None:
    assert len(token_hash("abc")) == 64
    assert token_hash("abc") == token_hash("abc")


def test_ipv6_clients_are_grouped_by_64_prefix() -> None:
    a = client_key("2001:db8:1:2:aaaa:bbbb:cccc:dddd")
    assert a == client_key("2001:db8:1:2::1") == "2001:db8:1:2::/64"
    assert client_key("2001:db8:1:3::1") != a
    assert client_key("203.0.113.7") == "203.0.113.7"
    assert client_key("::ffff:203.0.113.7") == "203.0.113.7"
    assert client_key(None) == "unknown"
    lim = make(Clock())
    for i in range(5):  # rotating addresses in one /64 still hit the client limit
        assert lim.try_acquire(client_key(f"2001:db8::{i:x}"), f"u{i}@x.io") is None
    assert lim.try_acquire(client_key("2001:db8::ff"), "z@x.io") is not None
