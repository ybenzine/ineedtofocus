"""The email layer (#350): SigV4 against AWS's published vector, the SES request, errors that
carry no address, the configuration rules and the message."""

import asyncio
import json
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest

from app.config import Settings
from app.mailer import (
    EmailError,
    Message,
    SesSender,
    SmtpSender,
    configure_email,
    reset_message,
    ses_request_body,
    sign_v4,
)

ADDRESS = "leaky-person@example.com"
SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"


def test_sigv4_matches_the_aws_test_suite_vector() -> None:
    """`get-vanilla` and `post-vanilla` from AWS's Signature Version 4 test suite."""
    now = datetime(2015, 8, 30, 12, 36, 0, tzinfo=UTC)
    common: dict[str, Any] = {
        "host": "example.amazonaws.com",
        "path": "/",
        "headers": {},
        "region": "us-east-1",
        "service": "service",
        "access_key": "AKIDEXAMPLE",
        "secret_key": SECRET,
        "now": now,
    }
    got = sign_v4(method="GET", body=b"", **common)
    assert got["x-amz-date"] == "20150830T123600Z"
    assert got["authorization"] == (
        "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, "
        "SignedHeaders=host;x-amz-date, "
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
    )
    post = sign_v4(method="POST", body=b"", **common)
    assert post["authorization"].endswith(
        "Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b"
    )


def message() -> Message:
    return reset_message(ADDRESS, "https://ineedtofoc.us/reset-password#token=SECRETTOKEN")


def test_every_ses_send_disables_tracking_and_uses_simple_content() -> None:
    """AC 6: Content.Simple, no configuration set, tracking DISABLED both ways."""
    body = ses_request_body("I Need To Focus <no-reply@ineedtofoc.us>", message())
    assert body["ConfigurationOverrides"] == {
        "Tracking": {"OpenTrackingEnabled": "DISABLED", "ClickTrackingEnabled": "DISABLED"}
    }
    assert "ConfigurationSetName" not in body
    assert set(body["Content"]) == {"Simple"}  # type: ignore[call-overload]
    assert body["Destination"] == {"ToAddresses": [ADDRESS]}
    assert body["FromEmailAddress"] == "I Need To Focus <no-reply@ineedtofoc.us>"


def ses(handler: Any) -> SesSender:
    return SesSender(
        region="us-east-1",
        access_key="AKIDEXAMPLE",
        secret_key=SECRET,
        from_address="I Need To Focus <no-reply@ineedtofoc.us>",
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


def test_the_ses_request_is_signed_and_goes_to_the_regions_endpoint() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"MessageId": "x"})

    asyncio.run(ses(handler).send(message()))
    (request,) = seen
    assert str(request.url) == "https://email.us-east-1.amazonaws.com/v2/email/outbound-emails"
    auth = request.headers["authorization"]
    assert auth.startswith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/")
    assert "/us-east-1/ses/aws4_request" in auth
    assert "SignedHeaders=content-type;host;x-amz-date" in auth
    sent = json.loads(request.content)
    assert sent["ConfigurationOverrides"]["Tracking"] == {
        "OpenTrackingEnabled": "DISABLED",
        "ClickTrackingEnabled": "DISABLED",
    }


def test_an_ses_error_keeps_the_error_type_and_drops_its_text() -> None:
    def rejected(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            headers={"x-amzn-ErrorType": "MessageRejected:http://internal.amazon.com/"},
            json={"message": f"Email address is not verified: {ADDRESS}"},
        )

    with pytest.raises(EmailError) as caught:
        asyncio.run(ses(rejected).send(message()))
    assert caught.value.code == "MessageRejected"
    assert ADDRESS not in repr(caught.value) + str(caught.value)

    def odd(_: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text=ADDRESS)

    with pytest.raises(EmailError) as odd_caught:
        asyncio.run(ses(odd).send(message()))
    assert odd_caught.value.code == "http_503"


def test_a_network_error_keeps_only_the_exception_class() -> None:
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"cannot reach for {ADDRESS}", request=request)

    with pytest.raises(EmailError) as caught:
        asyncio.run(ses(down).send(message()))
    assert caught.value.code == "ConnectError"
    assert caught.value.__cause__ is None
    assert ADDRESS not in repr(caught.value)


def test_a_failing_smtp_send_keeps_only_the_exception_class() -> None:
    sender = SmtpSender(host="127.0.0.1", port=1, from_address="a@example.com")
    with pytest.raises(EmailError) as caught:
        asyncio.run(sender.send(message()))
    assert caught.value.code == "ConnectionRefusedError"


def test_the_message_has_the_link_the_expiry_and_no_images_or_tracking() -> None:
    m = message()
    link = "https://ineedtofoc.us/reset-password#token=SECRETTOKEN"
    assert m.subject == "Reset your I Need To Focus password"
    for body in (m.text, m.html):
        assert link in body
        assert "This link expires in 60 minutes" in body
        assert (
            "If you didn't ask for this, ignore this email; your password hasn't changed." in body
        )
    assert "<img" not in m.html and "<script" not in m.html


SES = {
    "email_provider": "ses",
    "email_api_key": "AKIDEXAMPLE:" + SECRET,
    "email_aws_region": "us-east-1",
    "email_from": "I Need To Focus <no-reply@ineedtofoc.us>",
    "app_base_url": "https://ineedtofoc.us/",
}
SMTP = {
    "email_provider": "smtp",
    "email_smtp_host": "mailpit",
    "email_smtp_port": "1025",
    "email_from": "I Need To Focus <no-reply@ineedtofoc.us>",
    "app_base_url": "http://localhost:8000",
}


def test_configured_ses_and_smtp() -> None:
    ses_config = configure_email(Settings.model_validate(SES))
    assert isinstance(ses_config.sender, SesSender)
    assert ses_config.base_url == "https://ineedtofoc.us"
    assert ses_config.problem is None
    assert isinstance(configure_email(Settings.model_validate(SMTP)).sender, SmtpSender)


def test_the_key_splits_at_the_first_colon() -> None:
    config = configure_email(
        Settings.model_validate({**SES, "email_api_key": "AKID:secret:with:colons"})
    )
    assert config.sender is not None


@pytest.mark.parametrize(
    ("overrides", "variable"),
    [
        ({"email_provider": ""}, "EMAIL_PROVIDER"),
        ({"email_provider": "mailgun"}, "EMAIL_PROVIDER"),
        ({"app_base_url": ""}, "APP_BASE_URL"),
        ({"app_base_url": "ineedtofoc.us"}, "APP_BASE_URL"),
        ({"email_from": ""}, "EMAIL_FROM"),
        ({"email_from": "no address"}, "EMAIL_FROM"),
        ({"email_api_key": ""}, "EMAIL_API_KEY"),
        ({"email_api_key": "no-colon"}, "EMAIL_API_KEY"),
        ({"email_api_key": ":secret"}, "EMAIL_API_KEY"),
        ({"email_api_key": "akid:"}, "EMAIL_API_KEY"),
        ({"email_aws_region": ""}, "EMAIL_AWS_REGION"),
        ({"email_aws_region": "evil.example/#"}, "EMAIL_AWS_REGION"),
    ],
)
def test_ses_without_a_required_variable_is_not_configured(
    overrides: dict[str, str], variable: str
) -> None:
    config = configure_email(Settings.model_validate({**SES, **overrides}))
    assert config.sender is None
    assert config.problem == variable


@pytest.mark.parametrize(
    ("overrides", "variable"),
    [
        ({"email_smtp_host": ""}, "EMAIL_SMTP_HOST"),
        ({"email_smtp_port": ""}, "EMAIL_SMTP_PORT"),
        ({"email_smtp_port": "abc"}, "EMAIL_SMTP_PORT"),
        ({"email_smtp_port": "70000"}, "EMAIL_SMTP_PORT"),
    ],
)
def test_smtp_without_a_required_variable_is_not_configured(
    overrides: dict[str, str], variable: str
) -> None:
    config = configure_email(Settings.model_validate({**SMTP, **overrides}))
    assert config.sender is None
    assert config.problem == variable


def test_the_problem_never_holds_a_value() -> None:
    config = configure_email(Settings.model_validate({**SES, "email_api_key": "leaky:"}))
    assert config.problem == "EMAIL_API_KEY"
    assert "leaky" not in repr(config)
