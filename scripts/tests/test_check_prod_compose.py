"""scripts/check_prod_compose.py: a config shaped like the real rendered one passes, and
each deploy rule (#27) catches the mistake it exists for. No Docker: `make test-infra`
runs the checker on the real rendered configs."""

from __future__ import annotations

import copy
import json
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from check_prod_compose import MEMORY_BUDGET_MIB, caddy_routes, check

SCRIPT = Path(__file__).resolve().parents[1] / "check_prod_compose.py"
TAG = "0123456789abcdef0123456789abcdef01234567"
PG = "postgres:17-alpine@sha256:" + "a" * 64
OTEL = "otel/opentelemetry-collector-contrib:0.162.0@sha256:" + "b" * 64
CADDY = "caddy:2.11.4-alpine@sha256:" + "c" * 64
MiB = 1024 * 1024
Config = dict[str, Any]


def env_config(env: str, app: int, db: int, otel: int, oom: int, cpu: int) -> Config:
    """The parts of `docker compose config --format json` the checker reads."""
    ip = {"prod": "172.16.10.2", "dev": "172.16.20.2"}[env]

    def limits(mem: int) -> Config:
        return {
            "mem_limit": str(mem * MiB),
            "oom_score_adj": oom,
            "cpu_shares": cpu,
            "restart": "unless-stopped",
        }

    return {
        "name": f"focus-{env}",
        "services": {
            "app": {
                **limits(app),
                "image": f"ghcr.io/ybenzine/ineedtofocus:{TAG}",
                "environment": {
                    "COOKIE_SECURE": "1",
                    "MIGRATE_ON_START": "0",
                    "FORWARDED_ALLOW_IPS": ip,
                },
                "networks": {"default": None, "edge": {"aliases": [f"focus-{env}-app"]}},
            },
            "db": {
                **limits(db),
                "image": PG,
                "networks": {"default": None},
                "volumes": [
                    {"type": "volume", "source": "db-data", "target": "/var/lib/postgresql/data"}
                ],
            },
            "otel-collector": {**limits(otel), "image": OTEL, "networks": {"default": None}},
        },
        "networks": {
            "default": {"name": f"focus-{env}_default"},
            "edge": {"name": f"focus-edge_{env}", "external": True},
        },
    }


def pool(octet: str) -> Config:
    return {"subnet": f"172.16.{octet}.0/24", "ip_range": f"172.16.{octet}.128/25"}


def edge_config() -> Config:
    return {
        "name": "focus-edge",
        "services": {
            "caddy": {
                "image": CADDY,
                "mem_limit": str(96 * MiB),
                "restart": "unless-stopped",
                "ports": [{"target": 80, "published": "80"}, {"target": 443, "published": "443"}],
                "networks": {
                    "prod": {"ipv4_address": "172.16.10.2"},
                    "dev": {"ipv4_address": "172.16.20.2"},
                },
            }
        },
        "networks": {
            "prod": {"name": "focus-edge_prod", "ipam": {"config": [pool("10")]}},
            "dev": {"name": "focus-edge_dev", "ipam": {"config": [pool("20")]}},
        },
    }


def caddy_config() -> Config:
    def route(host: str, dial: str) -> Config:
        return {
            "match": [{"host": [host]}],
            "handle": [
                {
                    "handler": "subroute",
                    "routes": [
                        {"handle": [{"handler": "reverse_proxy", "upstreams": [{"dial": dial}]}]}
                    ],
                }
            ],
        }

    return {
        "apps": {
            "http": {
                "servers": {
                    "srv0": {
                        "listen": [":443"],
                        "routes": [
                            route("dev.ineedtofoc.us", "focus-dev-app:8000"),
                            route("ineedtofoc.us", "focus-prod-app:8000"),
                        ],
                    }
                }
            }
        }
    }


def good() -> dict[str, Config]:
    return {
        "edge": edge_config(),
        "prod": env_config("prod", app=320, db=256, otel=96, oom=0, cpu=1024),
        "dev": env_config("dev", app=256, db=128, otel=96, oom=500, cpu=256),
        "caddy": caddy_config(),
    }


def run(configs: dict[str, Config], tag: str | None = TAG) -> list[str]:
    return check(configs["edge"], configs["prod"], configs["dev"], configs["caddy"], tag)


def test_config_shaped_like_the_real_one_passes() -> None:
    assert run(good()) == []


def test_caddy_routes_reads_nested_upstreams() -> None:
    assert caddy_routes(caddy_config()) == {
        "dev.ineedtofoc.us": ["focus-dev-app:8000"],
        "ineedtofoc.us": ["focus-prod-app:8000"],
    }


def app(c: dict[str, Config], env: str) -> Config:
    service: Config = c[env]["services"]["app"]
    return service


def set_env(env: str, key: str, value: str) -> Callable[[dict[str, Config]], None]:
    def mutate(c: dict[str, Config]) -> None:
        app(c, env)["environment"][key] = value

    return mutate


def drop_limit(c: dict[str, Config]) -> None:
    del c["prod"]["services"]["otel-collector"]["mem_limit"]


def no_restart(c: dict[str, Config]) -> None:
    del c["dev"]["services"]["db"]["restart"]


def over_budget(c: dict[str, Config]) -> None:
    app(c, "prod")["mem_limit"] = str(MEMORY_BUDGET_MIB * MiB)


def dev_bigger(c: dict[str, Config]) -> None:
    c["dev"]["services"]["db"]["mem_limit"] = str(300 * MiB)


def dev_same_oom(c: dict[str, Config]) -> None:
    app(c, "dev")["oom_score_adj"] = 0


def dev_more_cpu(c: dict[str, Config]) -> None:
    app(c, "dev")["cpu_shares"] = 2048


def db_port(c: dict[str, Config]) -> None:
    c["prod"]["services"]["db"]["ports"] = [{"target": 5432, "published": "5432"}]


def caddy_extra_port(c: dict[str, Config]) -> None:
    c["edge"]["services"]["caddy"]["ports"].append({"target": 2019, "published": "2019"})


def wrong_image(c: dict[str, Config]) -> None:
    app(c, "prod")["image"] = "ghcr.io/ybenzine/ineedtofocus:latest"


def shared_edge(c: dict[str, Config]) -> None:
    c["dev"]["networks"]["edge"]["name"] = "focus-edge_prod"
    app(c, "dev")["environment"]["FORWARDED_ALLOW_IPS"] = "172.16.10.2"


def db_on_edge(c: dict[str, Config]) -> None:
    c["prod"]["services"]["db"]["networks"]["edge"] = None


def bind_mounted_data(c: dict[str, Config]) -> None:
    c["prod"]["services"]["db"]["volumes"][0]["type"] = "bind"


def swapped_routes(c: dict[str, Config]) -> None:
    c["caddy"] = json.loads(
        json.dumps(caddy_config())
        .replace("focus-prod-app", "X")
        .replace("focus-dev-app", "focus-prod-app")
    )


def edge_pool(c: dict[str, Config], net: str) -> Config:
    config: Config = c["edge"]["networks"][net]["ipam"]["config"][0]
    return config


def no_ip_range(c: dict[str, Config]) -> None:
    del edge_pool(c, "prod")["ip_range"]


def caddy_in_ip_range(c: dict[str, Config]) -> None:
    edge_pool(c, "dev")["ip_range"] = "172.16.20.0/25"


def caddy_outside_subnet(c: dict[str, Config]) -> None:
    edge_pool(c, "prod")["subnet"] = "172.16.11.0/24"
    edge_pool(c, "prod")["ip_range"] = "172.16.11.128/25"


def wrong_project(c: dict[str, Config]) -> None:
    c["dev"]["name"] = "focus-prod"


def set_image(env: str, name: str, image: str | None) -> Callable[[dict[str, Config]], None]:
    def mutate(c: dict[str, Config]) -> None:
        service = c[env]["services"][name]
        if image is None:
            del service["image"]
        else:
            service["image"] = image

    return mutate


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (drop_limit, "prod/otel-collector: no mem_limit"),
        (no_restart, "dev/db: restart policy"),
        (over_budget, "budget for the 2 GiB Droplet"),
        (dev_bigger, "dev/db: mem_limit"),
        (dev_same_oom, "dev/app: oom_score_adj"),
        (dev_more_cpu, "dev/app: cpu_shares"),
        (db_port, "prod/db: publishes ports"),
        (caddy_extra_port, "edge/caddy: publishes"),
        (set_env("prod", "COOKIE_SECURE", "0"), "prod/app: COOKIE_SECURE"),
        (set_env("dev", "MIGRATE_ON_START", "1"), "dev/app: MIGRATE_ON_START"),
        (set_env("prod", "FORWARDED_ALLOW_IPS", "*"), "must never be '*'"),
        (set_env("dev", "FORWARDED_ALLOW_IPS", "172.16.20.0/24"), "Caddy's address is 172.16.20.2"),
        (wrong_image, "expected ghcr.io/ybenzine/ineedtofocus:"),
        (shared_edge, "shares edge network"),
        (db_on_edge, "prod/db: only the app may join the edge network"),
        (bind_mounted_data, "prod/db: /var/lib/postgresql/data must be a named volume"),
        (swapped_routes, "caddy: ineedtofoc.us goes to"),
        (wrong_project, "dev: project name"),
        (no_ip_range, "edge/caddy: fixed address 172.16.10.2 on network prod: the subnet needs"),
        (caddy_in_ip_range, "edge/caddy: fixed address 172.16.20.2 on network dev is inside"),
        (caddy_outside_subnet, "is outside every subnet"),
        (
            set_image("prod", "db", "postgres:17-alpine"),
            "prod/db: image 'postgres:17-alpine' isn't pinned",
        ),
        (
            set_image(
                "dev", "otel-collector", "otel/opentelemetry-collector-contrib@sha256:" + "b" * 64
            ),
            "dev/otel-collector: image",
        ),
        (
            set_image("edge", "caddy", "caddy:2.11.4-alpine"),
            "edge/caddy: image 'caddy:2.11.4-alpine' isn't pinned",
        ),
        (set_image("prod", "db", PG.upper()), "prod/db: image"),
        (set_image("prod", "db", PG[:-1]), "prod/db: image"),
        (set_image("prod", "db", PG + " "), "prod/db: image"),
        (set_image("dev", "db", None), "dev/db: image None isn't pinned"),
    ],
)
def test_each_rule_catches_its_mistake(
    mutate: Callable[[dict[str, Config]], None], message: str
) -> None:
    configs = copy.deepcopy(good())
    mutate(configs)
    errors = run(configs)
    assert any(message in error for error in errors), errors


def test_tag_is_only_checked_when_given() -> None:
    configs = good()
    wrong_image(configs)
    assert run(configs, tag=None) == []


def test_cli_exit_codes(tmp_path: Path) -> None:
    configs = good()
    for name, config in configs.items():
        (tmp_path / f"{name}.json").write_text(json.dumps(config))
    args = [sys.executable, str(SCRIPT)] + [
        a for name in configs for a in (f"--{name}", str(tmp_path / f"{name}.json"))
    ]
    assert subprocess.run([*args, "--tag", TAG], capture_output=True).returncode == 0
    failed = subprocess.run([*args, "--tag", "other"], capture_output=True, text=True)
    assert failed.returncode == 1
    assert "FAIL  prod/app: image" in failed.stderr
