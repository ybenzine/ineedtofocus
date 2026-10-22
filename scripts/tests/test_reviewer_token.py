"""scripts/reviewer_token.py: config, key handling, JWT, token exchange, and that nothing
secret reaches stderr. No network: GitHub is replaced by a fake opener, and the RSA key is
generated per test run (never committed)."""

from __future__ import annotations

import io
import json
import os
import urllib.error
import urllib.request
from email.message import Message
from pathlib import Path
from typing import Any

import jwt
import pytest
import reviewer_token as rt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

NOW = 1_800_000_000
FAKE_TOKEN = "ghs_fakeinstallationtoken0123456789"


@pytest.fixture(scope="module")
def private_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture
def key_file(tmp_path: Path, private_key: rsa.RSAPrivateKey) -> Path:
    path = tmp_path / "reviewer-app.pem"
    path.write_bytes(
        private_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    )
    path.chmod(0o600)
    return path


class FakeResponse(io.BytesIO):
    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class FakeGitHub:
    """Stands in for urllib.request.urlopen and records the request."""

    def __init__(self, status: int = 201, payload: Any = None) -> None:
        self.status = status
        self.payload = {"token": FAKE_TOKEN, "expires_at": "x"} if payload is None else payload
        self.requests: list[urllib.request.Request] = []

    def __call__(self, request: urllib.request.Request, timeout: float) -> FakeResponse:
        self.requests.append(request)
        body = json.dumps(self.payload).encode()
        if self.status >= 400:
            raise urllib.error.HTTPError(
                request.full_url, self.status, "Unauthorized", Message(), io.BytesIO(body)
            )
        return FakeResponse(body)


def sent_jwt(github: FakeGitHub) -> str:
    header = github.requests[0].get_header("Authorization")
    assert header is not None
    return header.removeprefix("Bearer ")


def _env(key_file: Path) -> dict[str, str]:
    return {"REVIEWER_APP_KEY_PATH": str(key_file)}


# --- config -----------------------------------------------------------------------------


def test_config_defaults_match_env_example() -> None:
    config = rt.load_config({})
    assert config.app_id == "5420413"
    assert config.installation_id == "173980330"
    assert config.key_path == Path("~/.config/ineedtofocus/reviewer-app.pem").expanduser()

    env_example = (Path(__file__).resolve().parents[2] / ".env.example").read_text()
    assert "REVIEWER_APP_ID=5420413" in env_example
    assert "REVIEWER_INSTALLATION_ID=173980330" in env_example
    assert "REVIEWER_APP_KEY_PATH=~/.config/ineedtofocus/reviewer-app.pem" in env_example


def test_config_reads_env() -> None:
    config = rt.load_config(
        {
            "REVIEWER_APP_ID": "1",
            "REVIEWER_INSTALLATION_ID": "2",
            "REVIEWER_APP_KEY_PATH": "/k.pem",
        }
    )
    assert (config.app_id, config.installation_id, config.key_path) == ("1", "2", Path("/k.pem"))


@pytest.mark.parametrize("name", ["REVIEWER_APP_ID", "REVIEWER_INSTALLATION_ID"])
def test_config_rejects_non_numeric_ids(name: str) -> None:
    with pytest.raises(rt.TokenError) as info:
        rt.load_config({name: "abc"})
    assert info.value.exit_code == rt.EXIT_CONFIG


# --- key --------------------------------------------------------------------------------


def test_missing_key_is_key_unavailable(tmp_path: Path) -> None:
    with pytest.raises(rt.TokenError) as info:
        rt.read_key(tmp_path / "nope.pem", io.StringIO())
    assert info.value.exit_code == rt.EXIT_KEY_UNAVAILABLE
    assert "REVIEWER_APP_KEY_PATH" in str(info.value)


def test_directory_is_key_unavailable(tmp_path: Path) -> None:
    with pytest.raises(rt.TokenError) as info:
        rt.read_key(tmp_path, io.StringIO())
    assert info.value.exit_code == rt.EXIT_KEY_UNAVAILABLE


@pytest.mark.skipif(hasattr(os, "geteuid") and os.geteuid() == 0, reason="root reads anything")
def test_unreadable_key_is_key_unavailable(key_file: Path) -> None:
    key_file.chmod(0o000)
    try:
        with pytest.raises(rt.TokenError) as info:
            rt.read_key(key_file, io.StringIO())
    finally:
        key_file.chmod(0o600)
    assert info.value.exit_code == rt.EXIT_KEY_UNAVAILABLE


def test_warns_when_key_is_readable_by_others(key_file: Path) -> None:
    warn = io.StringIO()
    rt.read_key(key_file, warn)
    assert warn.getvalue() == ""

    key_file.chmod(0o644)
    rt.read_key(key_file, warn)
    assert "chmod 600" in warn.getvalue()
    assert "PRIVATE KEY" not in warn.getvalue()


# --- JWT --------------------------------------------------------------------------------


def test_jwt_is_rs256_signed_with_github_claims(
    key_file: Path, private_key: rsa.RSAPrivateKey
) -> None:
    token = rt.make_jwt("5420413", key_file.read_bytes(), NOW)

    assert jwt.get_unverified_header(token)["alg"] == "RS256"
    claims = jwt.decode(
        token,
        private_key.public_key(),
        algorithms=["RS256"],
        options={"verify_exp": False, "verify_iat": False},
    )
    assert claims == {"iss": "5420413", "iat": NOW - 60, "exp": NOW + 540}
    # GitHub rejects a JWT that lives longer than 10 minutes.
    assert claims["exp"] - claims["iat"] <= 600


def test_bad_key_error_does_not_echo_the_key() -> None:
    # Assembled at runtime so the repo's detect-private-key hook doesn't see a PEM header.
    label = "RSA " + "PRIVATE KEY"
    bogus = (
        f"-----BEGIN {label}-----\nc2VjcmV0LWtleS1tYXRlcmlhbA==\n-----END {label}-----\n".encode()
    )
    with pytest.raises(rt.TokenError) as info:
        rt.make_jwt("1", bogus, NOW)
    assert info.value.exit_code == rt.EXIT_ERROR
    assert "c2VjcmV0" not in str(info.value)
    assert "PRIVATE KEY" not in str(info.value)


# --- token exchange -----------------------------------------------------------------------


def test_requests_a_token_scoped_to_this_repo_for_reviews() -> None:
    github = FakeGitHub()
    token = rt.request_installation_token("the.jwt", "173980330", opener=github)

    assert token == FAKE_TOKEN
    (request,) = github.requests
    assert request.get_method() == "POST"
    assert request.full_url == "https://api.github.com/app/installations/173980330/access_tokens"
    assert request.get_header("Authorization") == "Bearer the.jwt"
    assert isinstance(request.data, bytes)
    assert json.loads(request.data) == {
        "repositories": ["ineedtofocus"],
        "permissions": {"pull_requests": "write", "contents": "read"},
    }


def test_http_error_reports_github_message_not_the_jwt() -> None:
    github = FakeGitHub(status=401, payload={"message": "A JSON web token could not be decoded"})
    with pytest.raises(rt.TokenError) as info:
        rt.request_installation_token("secret.jwt.value", "1", opener=github)
    assert info.value.exit_code == rt.EXIT_ERROR
    assert "HTTP 401" in str(info.value)
    assert "could not be decoded" in str(info.value)
    assert "secret.jwt.value" not in str(info.value)


def test_network_error_is_reported() -> None:
    def offline(request: urllib.request.Request, timeout: float) -> FakeResponse:
        raise urllib.error.URLError("no route to host")

    with pytest.raises(rt.TokenError, match="cannot reach GitHub"):
        rt.request_installation_token("j", "1", opener=offline)


def test_response_without_token_is_an_error() -> None:
    with pytest.raises(rt.TokenError, match="no installation token"):
        rt.request_installation_token("j", "1", opener=FakeGitHub(payload={"nope": 1}))


# --- main: only the token on stdout, nothing secret on stderr ------------------------------


def test_main_prints_only_the_token(key_file: Path) -> None:
    out, err = io.StringIO(), io.StringIO()
    github = FakeGitHub()

    code = rt.main([], env=_env(key_file), stdout=out, stderr=err, now=lambda: NOW, opener=github)

    assert code == 0
    assert out.getvalue() == FAKE_TOKEN + "\n"
    assert err.getvalue() == ""
    assert sent_jwt(github) not in out.getvalue()


def test_main_missing_key_exits_3_and_prints_no_token(tmp_path: Path) -> None:
    out, err = io.StringIO(), io.StringIO()
    github = FakeGitHub()

    code = rt.main(
        [],
        env={"REVIEWER_APP_KEY_PATH": str(tmp_path / "missing.pem")},
        stdout=out,
        stderr=err,
        opener=github,
    )

    assert code == rt.EXIT_KEY_UNAVAILABLE
    assert out.getvalue() == ""
    assert "missing.pem" in err.getvalue()
    assert github.requests == []


def test_main_github_error_prints_nothing_secret(key_file: Path) -> None:
    out, err = io.StringIO(), io.StringIO()
    github = FakeGitHub(status=401, payload={"message": "Bad credentials"})

    code = rt.main([], env=_env(key_file), stdout=out, stderr=err, now=lambda: NOW, opener=github)

    assert code == rt.EXIT_ERROR
    assert out.getvalue() == ""
    assert sent_jwt(github) not in err.getvalue()
    assert "PRIVATE KEY" not in err.getvalue()
    assert "Bad credentials" in err.getvalue()


class FakeTerminal(io.StringIO):
    def isatty(self) -> bool:
        return True


def test_main_refuses_to_print_the_token_to_a_terminal(key_file: Path) -> None:
    out, err = FakeTerminal(), io.StringIO()
    github = FakeGitHub()

    code = rt.main([], env=_env(key_file), stdout=out, stderr=err, opener=github)

    assert code == rt.EXIT_CONFIG
    assert out.getvalue() == ""
    assert "terminal" in err.getvalue()
    assert github.requests == []
