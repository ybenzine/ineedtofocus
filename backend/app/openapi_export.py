"""Write the OpenAPI document to `_docs/api/openapi.json` (`make openapi`).

The frontend generates its TypeScript types from that file; a unit test fails when it is
out of date with the code.
"""

import json
from pathlib import Path
from typing import Any

from app.config import Settings
from app.main import create_app

OPENAPI_PATH = Path(__file__).resolve().parents[2] / "_docs" / "api" / "openapi.json"


def render() -> str:
    # The schema does not depend on the settings; the engine is created lazily.
    schema: dict[str, Any] = create_app(Settings()).openapi()
    return json.dumps(schema, indent=2, sort_keys=True) + "\n"


if __name__ == "__main__":
    OPENAPI_PATH.parent.mkdir(parents=True, exist_ok=True)
    OPENAPI_PATH.write_text(render())
    print(f"wrote {OPENAPI_PATH}")
