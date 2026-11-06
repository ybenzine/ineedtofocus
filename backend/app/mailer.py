"""Sending email: the `EmailSender` interface, an Amazon SES API v2 adapter and an SMTP one
(password reset, #350, AC1.9).

Deployed environments send through SES over HTTPS (DigitalOcean blocks outbound SMTP); the
local stack sends SMTP to a Mailpit container. `configure_email` returns no sender when a
variable the chosen provider needs is missing, and the app then reports password reset as
unavailable.

SES requests are signed with AWS Signature Version 4, written out here (about 40 lines of
`hmac` and `hashlib`) instead of pulling in boto3: no import-time cost in a 256 MiB container,
no large dependency tree to keep patched, and the signature is checked against AWS's published
test vector (tests/unit/test_mailer.py).

Privacy: an address, a link or a token never appears in an error. `EmailError` carries only
a short code (an exception class name, an HTTP status, or the error type SES names), because
SES's own error text can contain the recipient's address.
"""

import asyncio
import hashlib
import hmac
import html
import json
import logging
import re
import smtplib
from dataclasses import dataclass
from datetime import UTC, datetime
from email.message import EmailMessage
from email.utils import parseaddr
from typing import Protocol

import httpx

from app.config import Settings

SEND_TIMEOUT_SECONDS = 10.0
_SAFE_CODE = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}")
_REGION = re.compile(r"[a-z]{2}(-[a-z]+)+-\d")


class EmailError(Exception):
    """A send failed. `code` is safe to log: it never holds an address or message text."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Message:
    to: str
    subject: str
    text: str
    html: str


class EmailSender(Protocol):
    async def send(self, message: Message) -> None:
        """Send one email, or raise `EmailError`. Takes at most about `SEND_TIMEOUT_SECONDS`."""
        ...


# --- AWS Signature Version 4 ------------------------------------------------------------


def _hmac(key: bytes, data: str) -> bytes:
    return hmac.new(key, data.encode(), hashlib.sha256).digest()


def sign_v4(
    *,
    method: str,
    host: str,
    path: str,
    headers: dict[str, str],
    body: bytes,
    region: str,
    service: str,
    access_key: str,
    secret_key: str,
    now: datetime,
) -> dict[str, str]:
    """Headers (`x-amz-date`, `authorization`) that sign this request, which has no query.

    `headers` are the ones to sign besides `host` and `x-amz-date`; the caller sends them too.
    """
    stamp = now.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")
    day = stamp[:8]
    signed = {
        "host": host,
        "x-amz-date": stamp,
        **{k.lower(): v.strip() for k, v in headers.items()},
    }
    names = sorted(signed)
    canonical = "\n".join(
        [
            method,
            path,
            "",
            "".join(f"{n}:{signed[n]}\n" for n in names),
            ";".join(names),
            hashlib.sha256(body).hexdigest(),
        ]
    )
    scope = f"{day}/{region}/{service}/aws4_request"
    to_sign = "\n".join(
        ["AWS4-HMAC-SHA256", stamp, scope, hashlib.sha256(canonical.encode()).hexdigest()]
    )
    key = _hmac(
        _hmac(_hmac(_hmac(f"AWS4{secret_key}".encode(), day), region), service), "aws4_request"
    )
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    authorization = (
        f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, "
        f"SignedHeaders={';'.join(names)}, Signature={signature}"
    )
    return {"x-amz-date": stamp, "authorization": authorization}


# --- Amazon SES API v2 --------------------------------------------------------------------


def ses_request_body(from_address: str, message: Message) -> dict[str, object]:
    """The `SendEmail` body: simple content, no configuration set, and tracking switched off
    on this message whatever the account's settings say (AC 6)."""

    def part(data: str) -> dict[str, str]:
        return {"Data": data, "Charset": "UTF-8"}

    return {
        "FromEmailAddress": from_address,
        "Destination": {"ToAddresses": [message.to]},
        "Content": {
            "Simple": {
                "Subject": part(message.subject),
                "Body": {"Text": part(message.text), "Html": part(message.html)},
            }
        },
        "ConfigurationOverrides": {
            "Tracking": {"OpenTrackingEnabled": "DISABLED", "ClickTrackingEnabled": "DISABLED"}
        },
    }


class SesSender:
    def __init__(
        self,
        *,
        region: str,
        access_key: str,
        secret_key: str,
        from_address: str,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._region = region
        self._access_key = access_key
        self._secret_key = secret_key
        self._from = from_address
        self._host = f"email.{region}.amazonaws.com"
        self._client = client or httpx.AsyncClient(timeout=SEND_TIMEOUT_SECONDS)
        # httpx logs every request URL at INFO; nothing private is in ours, but it is noise.
        logging.getLogger("httpx").setLevel(logging.WARNING)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def send(self, message: Message) -> None:
        path = "/v2/email/outbound-emails"
        body = json.dumps(ses_request_body(self._from, message)).encode()
        content = {"content-type": "application/json"}
        signed = sign_v4(
            method="POST",
            host=self._host,
            path=path,
            headers=content,
            body=body,
            region=self._region,
            service="ses",
            access_key=self._access_key,
            secret_key=self._secret_key,
            now=datetime.now(UTC),
        )
        try:
            response = await self._client.post(
                f"https://{self._host}{path}",
                content=body,
                headers={**content, **signed},
                timeout=SEND_TIMEOUT_SECONDS,
            )
        except Exception as exc:  # network, TLS, timeout: the class name only
            raise EmailError(type(exc).__name__) from None
        if response.status_code >= 300:
            raise EmailError(_ses_error_code(response))


def _ses_error_code(response: httpx.Response) -> str:
    """The error type SES names (`MessageRejected`, ...) or `http_<status>`; never its text."""
    kind: str = response.headers.get("x-amzn-errortype", "").split(":")[0]
    if _SAFE_CODE.fullmatch(kind):
        return kind
    return f"http_{response.status_code}"


# --- SMTP (the local Mailpit) -------------------------------------------------------------


class SmtpSender:
    def __init__(self, *, host: str, port: int, from_address: str) -> None:
        self._host = host
        self._port = port
        self._from = from_address

    def _send(self, message: Message) -> None:
        mail = EmailMessage()
        mail["From"] = self._from
        mail["To"] = message.to
        mail["Subject"] = message.subject
        mail.set_content(message.text)
        mail.add_alternative(message.html, subtype="html")
        with smtplib.SMTP(self._host, self._port, timeout=SEND_TIMEOUT_SECONDS) as smtp:
            smtp.send_message(mail)

    async def send(self, message: Message) -> None:
        try:
            await asyncio.to_thread(self._send, message)
        except Exception as exc:
            raise EmailError(type(exc).__name__) from None


# --- Configuration ------------------------------------------------------------------------


@dataclass(frozen=True)
class EmailConfig:
    """The result of reading the settings: a sender and the base URL, or the name of the
    first variable that is missing or malformed (never its value)."""

    sender: EmailSender | None
    base_url: str
    problem: str | None


def _split_key(raw: str) -> tuple[str, str] | None:
    access, sep, secret = raw.partition(":")
    return (access, secret) if sep and access and secret else None


def configure_email(settings: Settings) -> EmailConfig:
    provider = settings.email_provider.strip().lower()
    if provider not in ("ses", "smtp"):
        return EmailConfig(None, "", "EMAIL_PROVIDER")
    base_url = settings.app_base_url.strip().rstrip("/")
    if not re.fullmatch(r"https?://[^\s/]+", base_url):
        return EmailConfig(None, "", "APP_BASE_URL")
    from_address = settings.email_from.strip()
    if "@" not in parseaddr(from_address)[1]:
        return EmailConfig(None, "", "EMAIL_FROM")
    sender: EmailSender
    if provider == "ses":
        keys = _split_key(settings.email_api_key.get_secret_value().strip())
        if keys is None:
            return EmailConfig(None, "", "EMAIL_API_KEY")
        region = settings.email_aws_region.strip()
        if not _REGION.fullmatch(region):
            return EmailConfig(None, "", "EMAIL_AWS_REGION")
        sender = SesSender(
            region=region, access_key=keys[0], secret_key=keys[1], from_address=from_address
        )
    else:
        host = settings.email_smtp_host.strip()
        if not host:
            return EmailConfig(None, "", "EMAIL_SMTP_HOST")
        port = settings.email_smtp_port.strip()
        if not port.isdigit() or not 0 < int(port) < 65536:
            return EmailConfig(None, "", "EMAIL_SMTP_PORT")
        sender = SmtpSender(host=host, port=int(port), from_address=from_address)
    return EmailConfig(sender, base_url, None)


# --- The reset email (AC 4) -----------------------------------------------------------------

RESET_SUBJECT = "Reset your I Need To Focus password"


def reset_message(to: str, link: str) -> Message:
    """Plain text plus simple HTML: the link, the expiry and the ignore line. No images and
    no tracking (AC 4)."""
    text = (
        "Someone asked to reset your I Need To Focus password. "
        "To choose a new one, open this link:\n\n"
        f"{link}\n\n"
        "This link expires in 60 minutes.\n\n"
        "If you didn't ask for this, ignore this email; your password hasn't changed.\n"
    )
    safe = html.escape(link, quote=True)
    page = (
        "<!doctype html><html><body>"
        "<p>Someone asked to reset your I Need To Focus password. "
        "To choose a new one, open this link:</p>"
        f'<p><a href="{safe}">{safe}</a></p>'
        "<p>This link expires in 60 minutes.</p>"
        "<p>If you didn't ask for this, ignore this email; your password hasn't changed.</p>"
        "</body></html>"
    )
    return Message(to=to, subject=RESET_SUBJECT, text=text, html=page)
