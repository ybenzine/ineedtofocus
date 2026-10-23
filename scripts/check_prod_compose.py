#!/usr/bin/env python3
"""Check the rendered production Compose and Caddy configs against the deploy rules (#27).

    python3 scripts/check_prod_compose.py --edge edge.json --prod prod.json --dev dev.json \\
        --caddy caddy.json [--tag <image tag>]

Inputs are `docker compose ... config --format json` for infra/compose.edge.yml and for
infra/compose.prod.yml rendered as prod and as dev (infra/compose.sh), and `caddy adapt`
output for infra/caddy/Caddyfile. `make test-infra` (infra/tests/check_config.sh) produces
them. Exits non-zero, listing every broken rule:

  - every container has a memory limit and a restart policy;
  - the limits of Caddy + prod + dev, plus one one-shot migration container (the largest
    app limit), fit MEMORY_BUDGET_MIB, so the 2 GiB Droplet never overcommits;
  - dev never outranks prod: per service, dev's memory limit and CPU weight are at most
    prod's, and dev's OOM score is higher (the kernel kills dev first);
  - only Caddy publishes ports (80 and 443);
  - the app runs with COOKIE_SECURE=1 and MIGRATE_ON_START=0, and trusts proxy headers only
    from Caddy's fixed address on its own edge network (never `*`);
  - each environment has its own edge network, Postgres keeps its data in a named volume,
    and only the app joins the edge network;
  - Caddy routes ineedtofoc.us to the prod app and dev.ineedtofoc.us to the dev app;
  - with --tag, the app image is ghcr.io/ybenzine/ineedtofocus:<tag>.

Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

IMAGE_REPO = "ghcr.io/ybenzine/ineedtofocus"
# A Basic 2 GiB Droplet leaves about 1.9 GiB to Linux. Keep about 350 MiB for the kernel,
# dockerd, containerd, sshd and unattended-upgrades; containers get the rest.
MEMORY_BUDGET_MIB = 1600
EXPECTED_PROJECTS = {"edge": "focus-edge", "prod": "focus-prod", "dev": "focus-dev"}
HOSTS = {"prod": "ineedtofoc.us", "dev": "dev.ineedtofoc.us"}
PG_DATA = "/var/lib/postgresql/data"

Config = dict[str, Any]


def mib(service: Config) -> float:
    """The service's mem_limit in MiB (Compose renders it as a byte count); 0 if unset."""
    raw = service.get("mem_limit")
    return int(raw) / (1024 * 1024) if raw else 0.0


def services(config: Config) -> dict[str, Config]:
    result: dict[str, Config] = config.get("services") or {}
    return result


def all_services(configs: dict[str, Config]) -> Iterator[tuple[str, str, Config]]:
    for env, config in configs.items():
        for name, service in services(config).items():
            yield env, name, service


def edge_network_of(env_config: Config) -> str | None:
    """Real name of the external network the app joins as `edge`."""
    network = (env_config.get("networks") or {}).get("edge") or {}
    name = network.get("name")
    return name if network.get("external") and isinstance(name, str) else None


def caddy_addresses(edge: Config) -> dict[str, str]:
    """Caddy's fixed IPv4 address on each edge network, keyed by the network's real name."""
    caddy = services(edge).get("caddy") or {}
    networks = edge.get("networks") or {}
    result: dict[str, str] = {}
    for key, attachment in (caddy.get("networks") or {}).items():
        address = (attachment or {}).get("ipv4_address")
        real_name = (networks.get(key) or {}).get("name", key)
        if address:
            result[real_name] = address
    return result


def caddy_routes(caddy: Config) -> dict[str, list[str]]:
    """Host name -> upstream dial addresses, from `caddy adapt` JSON."""
    routes: dict[str, list[str]] = {}

    def upstreams(node: Any) -> Iterator[str]:
        if isinstance(node, dict):
            for item in node.get("upstreams") or []:
                if isinstance(item, dict) and "dial" in item:
                    yield item["dial"]
            for value in node.values():
                yield from upstreams(value)
        elif isinstance(node, list):
            for value in node:
                yield from upstreams(value)

    servers = ((caddy.get("apps") or {}).get("http") or {}).get("servers") or {}
    for server in servers.values():
        for route in server.get("routes") or []:
            dials = list(upstreams(route.get("handle")))
            for match in route.get("match") or []:
                for host in match.get("host") or []:
                    routes.setdefault(host, []).extend(dials)
    return routes


def check(
    edge: Config, prod: Config, dev: Config, caddy: Config, tag: str | None = None
) -> list[str]:
    errors: list[str] = []
    envs = {"prod": prod, "dev": dev}
    configs = {"edge": edge, **envs}

    for env, expected in EXPECTED_PROJECTS.items():
        if configs[env].get("name") != expected:
            errors.append(f"{env}: project name is {configs[env].get('name')!r}, not {expected}")

    total = 0.0
    for env, name, service in all_services(configs):
        if not service.get("mem_limit"):
            errors.append(f"{env}/{name}: no mem_limit")
        if service.get("restart") not in ("unless-stopped", "always"):
            errors.append(f"{env}/{name}: restart policy is {service.get('restart')!r}")
        total += mib(service)
        ports = service.get("ports") or []
        if env != "edge" and ports:
            errors.append(f"{env}/{name}: publishes ports {ports}; only Caddy may")

    migration = max(mib(services(c).get("app") or {}) for c in envs.values())
    if total + migration > MEMORY_BUDGET_MIB:
        errors.append(
            f"memory limits {total:.0f} MiB + one migration container {migration:.0f} MiB"
            f" exceed the {MEMORY_BUDGET_MIB} MiB budget for the 2 GiB Droplet"
        )

    caddy_service = services(edge).get("caddy") or {}
    published = {str(p.get("target")) for p in caddy_service.get("ports") or []}
    if published != {"80", "443"}:
        errors.append(f"edge/caddy: publishes {sorted(published)}, expected 80 and 443")
    for name in services(edge):
        if name != "caddy":
            errors.append(f"edge/{name}: unexpected service in the edge project")

    for name in set(services(prod)) | set(services(dev)):
        p, d = services(prod).get(name), services(dev).get(name)
        if p is None or d is None:
            errors.append(f"{name}: present in only one of prod and dev")
            continue
        if mib(d) > mib(p):
            errors.append(f"dev/{name}: mem_limit {mib(d):.0f} MiB is above prod's {mib(p):.0f}")
        if int(d.get("oom_score_adj") or 0) <= int(p.get("oom_score_adj") or 0):
            errors.append(f"dev/{name}: oom_score_adj must be above prod's (dev is killed first)")
        if int(d.get("cpu_shares") or 1024) > int(p.get("cpu_shares") or 1024):
            errors.append(f"dev/{name}: cpu_shares above prod's")

    addresses = caddy_addresses(edge)
    routes = caddy_routes(caddy)
    networks_seen: dict[str, str] = {}
    for env, config in envs.items():
        app = services(config).get("app")
        if app is None:
            errors.append(f"{env}: no app service")
            continue
        environment = app.get("environment") or {}
        if environment.get("COOKIE_SECURE") != "1":
            errors.append(f"{env}/app: COOKIE_SECURE must be 1")
        if environment.get("MIGRATE_ON_START") != "0":
            errors.append(f"{env}/app: MIGRATE_ON_START must be 0 (deploys migrate separately)")
        if tag is not None and app.get("image") != f"{IMAGE_REPO}:{tag}":
            errors.append(f"{env}/app: image is {app.get('image')!r}, expected {IMAGE_REPO}:{tag}")

        edge_network = edge_network_of(config)
        if edge_network is None:
            errors.append(f"{env}: the `edge` network must be external and named")
        elif edge_network in networks_seen:
            errors.append(
                f"{env}: shares edge network {edge_network} with {networks_seen[edge_network]}"
            )
        else:
            networks_seen[edge_network] = env

        trusted = str(environment.get("FORWARDED_ALLOW_IPS", ""))
        caddy_ip = addresses.get(edge_network or "")
        if "*" in trusted:
            errors.append(f"{env}/app: FORWARDED_ALLOW_IPS must never be '*'")
        elif caddy_ip is None:
            errors.append(f"{env}: Caddy has no fixed address on edge network {edge_network}")
        elif trusted != caddy_ip:
            errors.append(
                f"{env}/app: FORWARDED_ALLOW_IPS is {trusted!r}, Caddy's address is {caddy_ip}"
            )

        aliases = ((app.get("networks") or {}).get("edge") or {}).get("aliases") or []
        expected_dials = {f"{alias}:8000" for alias in aliases}
        dials = routes.get(HOSTS[env], [])
        if not dials or not set(dials) <= expected_dials:
            errors.append(
                f"caddy: {HOSTS[env]} goes to {dials},"
                f" expected the {env} app ({sorted(expected_dials)})"
            )

        for name, service in services(config).items():
            if name != "app" and "edge" in (service.get("networks") or {}):
                errors.append(f"{env}/{name}: only the app may join the edge network")

        db = services(config).get("db") or {}
        volumes = db.get("volumes") or []
        if not any(v.get("type") == "volume" and v.get("target") == PG_DATA for v in volumes):
            errors.append(f"{env}/db: {PG_DATA} must be a named volume")

    return errors


def load(path: Path) -> Config:
    data: Config = json.loads(path.read_text())
    return data


def main() -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    for name in ("edge", "prod", "dev", "caddy"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--tag", default=None, help="Expected app image tag")
    args = parser.parse_args()

    errors = check(load(args.edge), load(args.prod), load(args.dev), load(args.caddy), args.tag)
    for error in errors:
        print(f"FAIL  {error}", file=sys.stderr)
    if errors:
        return 1
    print("OK    production Compose and Caddy configs follow the deploy rules")
    return 0


if __name__ == "__main__":
    sys.exit(main())
