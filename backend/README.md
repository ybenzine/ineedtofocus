# Backend

FastAPI app (Python 3.12, managed with [uv](https://docs.astral.sh/uv/)). The application itself lands with #7; this folder is the scaffold from #1.

```sh
uv sync                  # create .venv with dev tools
uv run pytest            # tests (tests/unit, tests/integration)
uv run ruff check .      # lint
uv run ruff format .     # format
uv run mypy              # type-check (strict)
```

From the repo root, `make test` / `make lint` / `make fmt` run these for you.
