#!/usr/bin/env python3
"""Realistic key-journey traffic, to fire the user-impact alerts on demand (#33).

    python3 scripts/traffic.py                                  # the local stack, 10 minutes
    python3 scripts/traffic.py --base-url https://dev.ineedtofoc.us --minutes 12
    python3 scripts/traffic.py --rate 30 --minutes 8            # requests per minute

It signs up its own throwaway account (`traffic-<random>@example.com`, a random password
it never prints), then, until the time is up, sends a mix like the app's:

  - single saves of a finished session (`POST /api/sessions`), as when a session ends online;
  - offline sync batches of 2 to 5 sessions (`POST /api/sessions/sync`); some repeat a
    session already saved (`existing`), and now and then one holds an invalid session
    (`rejected`), as a stale device would send;
  - history loads (`GET /api/history`): day, week, month, all time and custom ranges, in a
    few time zones.

The sessions are countdown, Pomodoro and unlimited sessions of 1 to 90 minutes that
ended in the last few days, with tags and no goal (the account is a test account, but
no field resembles customer data anyway).

On its own it makes no alert fire: almost every save succeeds. With the operator's fault
injection on (`FAULT_SAVE_ERROR_PERCENT`, _docs/observability.md, Alert trigger), that
share of save requests fails with a 500, and after about 5 minutes the session-save
alert fires. It prints one line a minute (requests and sessions by result) and a total.

Default base URL: this checkout's local stack (APP_PORT, from the environment or .env).
It refuses to run against production (https://ineedtofoc.us): prod's alerts page the
on-call agent, and prod's data is real users'. The default rate, 20 requests a minute,
is low enough for dev's small Droplet and still clears the alert's minimum count
(10 sessions in 5 minutes) many times over. Stdlib only.
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import Counter
from datetime import UTC, date, datetime, timedelta
from typing import Any

from check_local_stack import setting

PROD_HOSTS = {"ineedtofoc.us", "www.ineedtofoc.us"}
TAGS = ("work", "study", "read", "meditation", "exercise", "nap")
TIME_ZONES = ("UTC", "Europe/Paris", "America/New_York", "Asia/Tokyo", "Africa/Algiers")
VIEWS = ("day", "week", "month", "all", "custom")
# Shares of each action (they add up to 1).
SINGLE_SAVE, SYNC_BATCH = 0.45, 0.15  # the rest are history loads
MAX_RATE = 120  # requests a minute; more is a load test, not realistic traffic


class Refused(Exception):
    """The target is one this script must never send traffic to."""


def check_target(base_url: str) -> str:
    """The base URL without a trailing slash; refuses prod and anything not http(s)."""
    parts = urllib.parse.urlsplit(base_url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise Refused(f"not an http(s) URL: {base_url!r}")
    # The host name is enough: Caddy routes by host (infra/caddy/Caddyfile), so the Droplet's
    # IP address or any other name never reaches prod. If Caddy ever serves prod for another
    # host (or a bare IP), refuse that here too.
    if parts.hostname.lower().rstrip(".") in PROD_HOSTS:
        raise Refused(
            "refusing to send test traffic to production: its alerts page the on-call agent "
            "and its data is real users'. Use dev (https://dev.ineedtofoc.us) or the local stack."
        )
    return base_url.rstrip("/")


def make_session(rng: random.Random, now: datetime, *, valid: bool = True) -> dict[str, Any]:
    """A finished session, shaped like the frontend's SessionRecord (backend SessionIn)."""
    mode = rng.choice(("countdown", "pomodoro", "unlimited"))
    blocks = 0
    if mode == "countdown":
        minutes = rng.choice((15, 25, 30, 45, 60))
        config: dict[str, Any] = {"mode": "countdown", "minutes": minutes}
        completed = rng.random() < 0.8
        focus = minutes * 60 if completed else rng.randint(60, minutes * 60)
    elif mode == "pomodoro":
        config = {
            "mode": "pomodoro",
            "focus_minutes": 25,
            "break_minutes": 5,
            "blocks": 4,
            "long_break_enabled": False,
            "long_break_minutes": 15,
        }
        blocks = rng.randint(1, 4)
        completed = blocks == 4
        focus = blocks * 25 * 60
    else:
        config = {"mode": "unlimited", "reminder_minutes": rng.choice((None, 30, 60))}
        completed = True
        focus = rng.randint(60, 90 * 60)
    paused = rng.choice((0, 0, 0, 30, 120))
    ended = now - timedelta(minutes=rng.randint(1, 3 * 24 * 60))
    started = ended - timedelta(seconds=focus + paused + rng.randint(0, 60))
    return {
        "id": str(uuid.uuid4()),
        "mode": mode,
        "tag": rng.choice(TAGS),
        "goal": None,
        "started_at": started.isoformat().replace("+00:00", "Z"),
        "ended_at": ended.isoformat().replace("+00:00", "Z"),
        # An invalid session: under the 1-minute minimum, which the server rejects.
        "focus_seconds": focus if valid else 30,
        "paused_seconds": paused,
        "status": "completed" if completed else "ended_early",
        "mode_config": config,
        "blocks_completed": blocks,
    }


def history_query(rng: random.Random, today: date) -> dict[str, str]:
    view = rng.choice(VIEWS)
    params = {"view": view, "tz": rng.choice(TIME_ZONES)}
    if view in ("day", "week", "month"):
        params["date"] = (today - timedelta(days=rng.randint(0, 40))).isoformat()
    elif view == "custom":
        end = today - timedelta(days=rng.randint(0, 10))
        params["start"] = (end - timedelta(days=rng.randint(1, 90))).isoformat()
        params["end"] = end.isoformat()
    return params


class Client:
    """One signed-in browser: a cookie jar and JSON requests."""

    def __init__(self, base_url: str, timeout: float = 15) -> None:
        self.base_url = base_url
        self.timeout = timeout
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
        )

    def request(self, method: str, path: str, body: Any = None) -> int:
        """The response's status code; 0 when there was no response (timeout, refused)."""
        data = None if body is None else json.dumps(body).encode()
        headers = {"Content-Type": "application/json"} if data is not None else {}
        req = urllib.request.Request(
            self.base_url + path, data=data, headers=headers, method=method
        )
        try:
            with self.opener.open(req, timeout=self.timeout) as r:
                r.read()
                return int(r.status)
        except urllib.error.HTTPError as e:
            e.read()
            return int(e.code)
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            return 0

    def sign_up(self) -> None:
        email = f"traffic-{uuid.uuid4().hex[:12]}@example.com"
        status = self.request(
            "POST", "/api/auth/signup", {"email": email, "password": uuid.uuid4().hex}
        )
        if status != 201:
            sys.exit(f"traffic: sign-up failed with HTTP {status} (rate limited? 10 an hour)")
        print(f"traffic: signed up a throwaway account on {self.base_url}")


def result(status: int) -> str:
    if status == 0:
        return "no response"
    if status >= 500:
        return "5xx"
    if status >= 400:
        return "4xx"
    return "ok"


class Traffic:
    def __init__(self, client: Client, rng: random.Random) -> None:
        self.client = client
        self.rng = rng
        self.saved: list[dict[str, Any]] = []  # sessions the server has, for repeats
        self.minute: Counter[str] = Counter()
        self.total: Counter[str] = Counter()

    def count(self, key: str, n: int = 1) -> None:
        self.minute[key] += n
        self.total[key] += n

    def step(self) -> None:
        now = datetime.now(UTC)
        roll = self.rng.random()
        if roll < SINGLE_SAVE:
            session = make_session(self.rng, now)
            status = self.client.request("POST", "/api/sessions", session)
            self.count(f"save {result(status)}")
            self.count("sessions sent")
            if 200 <= status < 300:
                self.saved.append(session)
        elif roll < SINGLE_SAVE + SYNC_BATCH:
            batch = [make_session(self.rng, now) for _ in range(self.rng.randint(2, 5))]
            if self.saved and self.rng.random() < 0.25:
                batch[0] = self.rng.choice(self.saved)  # a retry of one already saved
            invalid = None
            if self.rng.random() < 0.1:
                invalid = batch[-1] = make_session(self.rng, now, valid=False)
            status = self.client.request("POST", "/api/sessions/sync", {"sessions": batch})
            self.count(f"sync {result(status)}")
            self.count("sessions sent", len(batch))
            if status == 200:
                # The server rejected the invalid one: it's not saved, so not a retry candidate.
                self.saved.extend(s for s in batch if s is not invalid)
        else:
            query = urllib.parse.urlencode(history_query(self.rng, now.date()))
            status = self.client.request("GET", f"/api/history?{query}")
            self.count(f"history {result(status)}")
        del self.saved[:-200]

    def report(self, label: str, counts: Counter[str]) -> None:
        parts = ", ".join(f"{k} {v}" for k, v in sorted(counts.items()))
        print(f"traffic: {label}: {parts or 'nothing sent'}", flush=True)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument(
        "--base-url",
        default=f"http://localhost:{setting('APP_PORT', '8000')}",
        help="App to send traffic to (default: this checkout's local stack). Never prod.",
    )
    parser.add_argument("--minutes", type=float, default=10, help="How long (default 10)")
    parser.add_argument(
        "--rate", type=float, default=20, help=f"Requests a minute (default 20, at most {MAX_RATE})"
    )
    parser.add_argument("--seed", type=int, default=None, help="Repeatable sequence")
    args = parser.parse_args(argv)
    if not 0 < args.rate <= MAX_RATE:
        parser.error(f"--rate must be above 0 and at most {MAX_RATE}")
    if args.minutes <= 0:
        parser.error("--minutes must be above 0")
    return args


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        base_url = check_target(args.base_url)
    except Refused as e:
        print(f"traffic: {e}", file=sys.stderr)
        return 2
    client = Client(base_url)
    client.sign_up()
    traffic = Traffic(client, random.Random(args.seed))
    interval = 60 / args.rate
    end = time.monotonic() + args.minutes * 60
    next_report = time.monotonic() + 60
    elapsed = 0
    try:
        while time.monotonic() < end:
            started = time.monotonic()
            traffic.step()
            if time.monotonic() >= next_report:
                elapsed += 1
                traffic.report(f"minute {elapsed}", traffic.minute)
                traffic.minute.clear()
                next_report += 60
            # Jitter, so requests don't arrive in lockstep.
            pause = interval * traffic.rng.uniform(0.5, 1.5) - (time.monotonic() - started)
            time.sleep(max(0.0, min(pause, end - time.monotonic())))
    except KeyboardInterrupt:
        print("traffic: interrupted", file=sys.stderr)
    traffic.report("total", traffic.total)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
