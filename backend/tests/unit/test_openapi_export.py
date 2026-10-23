from app.openapi_export import OPENAPI_PATH, render


def test_committed_openapi_is_current() -> None:
    assert OPENAPI_PATH.read_text() == render(), "run `make openapi` and commit the result"


def test_openapi_lists_the_auth_endpoints() -> None:
    import json

    paths = json.loads(render())["paths"]
    assert set(paths) >= {
        "/api/auth/signup",
        "/api/auth/signin",
        "/api/auth/signout",
        "/api/auth/me",
    }
