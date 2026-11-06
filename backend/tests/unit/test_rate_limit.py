"""Failed-sign-in limiter (pure logic) and password helpers."""

import asyncio

from app.rate_limit import SWEEP_EVERY, FailureLimiter, QuotaLimiter, client_key
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


def test_stale_clients_are_forgotten_so_one_off_addresses_cannot_grow_the_table() -> None:
    clock = Clock()
    lim = make(clock)
    for i in range(SWEEP_EVERY - 1):
        lim.try_acquire(f"client-{i}", "")
    assert len(lim._failures) > SWEEP_EVERY
    clock.now += 61  # a whole window later
    lim.try_acquire("fresh", "")  # the SWEEP_EVERY-th call sweeps
    assert {k for k in lim._failures if k.startswith("c:")} == {"c:fresh"}
    assert len(lim._failures) == 2


def test_clear_email_forgets_that_emails_failures_from_every_client() -> None:
    """A completed password reset clears the lockout for the email (#350, AC1.9)."""
    lim = make(Clock())
    for client in ("c1", "c2"):
        for _ in range(3):
            assert lim.try_acquire(client, "a@x.io") is None
        assert lim.try_acquire(client, "a@x.io") is not None
    lim.clear_email("a@x.io")
    assert lim.try_acquire("c1", "a@x.io") is None
    assert lim.try_acquire("c2", "a@x.io") is None


def test_clear_email_leaves_other_emails_and_the_client_count() -> None:
    lim = FailureLimiter(2, 3, 60.0, Clock())
    assert lim.try_acquire("c", "a@x.io") is None
    assert lim.try_acquire("c", "b@x.io") is None
    assert lim.try_acquire("c", "b@x.io") is None  # b is now at its limit of 2
    assert lim.try_acquire("c", "b@x.io") is not None
    lim.clear_email("a@x.io")
    assert lim.try_acquire("c", "b@x.io") is not None  # b untouched, and the client is full
    lim.clear_email("never-seen@x.io")  # no error


def test_clear_email_index_is_swept_with_the_failures() -> None:
    clock = Clock()
    lim = make(clock)
    lim.try_acquire("c", "a@x.io")
    clock.now += 61
    for n in range(SWEEP_EVERY):
        lim.try_acquire("other", f"e{n}@x.io")
        clock.now += 61
    assert all(lim._pairs_by_email.values())
    assert len(lim._pairs_by_email) < SWEEP_EVERY


def test_quota_limiter_counts_all_keys_or_none() -> None:
    clock = Clock()
    lim = QuotaLimiter(60.0, clock)
    quotas = [("email:a", 2), ("client:c", 3)]
    assert lim.try_acquire(quotas) is None
    assert lim.try_acquire(quotas) is None
    wait = lim.try_acquire(quotas)  # the email is full
    assert wait is not None and 1 <= wait <= 61
    # The refused request counted against nothing: the client has used 2 of 3, not 3.
    assert lim.try_acquire([("email:b", 2), ("client:c", 3)]) is None
    assert lim.try_acquire([("email:d", 2), ("client:c", 3)]) is not None
    clock.now += 61
    assert lim.try_acquire(quotas) is None


def test_quota_limiter_sweeps_stale_keys() -> None:
    clock = Clock()
    lim = QuotaLimiter(60.0, clock)
    for n in range(SWEEP_EVERY):
        lim.try_acquire([(f"email:{n}", 3)])
        clock.now += 61
    assert len(lim._hits) < SWEEP_EVERY
