"""A local simulation of .github/workflows/oncall.yml (#35), driven by the YAML itself.

Runs each job's `run:` steps as GitHub would (`bash --noprofile --norc -eo pipefail`), in
the workflow's job order. The workflow file supplies the `needs`, the job and step `if:`
conditions, and the `env:` and `outputs:` expressions. A test only picks the scenario:
what the fake `gh`, `claude` and `uv` answer, and what the sessions leave behind.

- `actions/checkout`: a fresh clone of a throwaway origin repo, with the real `scripts/`
  and `infra/` linked in. git is real, so a fix branch really is bundled, fetched, checked
  and pushed (to that origin).
- `upload-artifact` / `download-artifact`: copies between the jobs' directories.
- `gh`: answers from the scenario's files, logs every call (with the token it was given)
  and keeps every posted comment.
- `claude`: answers the flag probe like the pinned CLI, saves the prompt and runs the
  scenario's script for that session.
- `uv run … reviewer_token.py`: prints a fake App token if the key file exists, else
  exits 3 like the real script.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml  # type: ignore[import-untyped]  # no stubs in the locked env

REPO = Path(__file__).resolve().parents[2]
WORKFLOW = REPO / ".github" / "workflows" / "oncall.yml"
WORKFLOW_TOKEN = "ghs_workflow_token_of_this_run"

FAKE_GH = r"""#!/usr/bin/env bash
# Fake gh: canned answers from $SIM, a log line per call with the token it was given.
printf 'gh %s [token=%s]\n' "$*" "${GH_TOKEN:-}" >> "$SIM/gh.log"
jq_expr=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  [[ ${args[i]} == --jq ]] && jq_expr=${args[i + 1]}
done
answer() { if [[ -n $jq_expr ]]; then jq -r "$jq_expr" "$1"; else cat "$1"; fi; }
case "$1 $2" in
  "issue list") answer "$SIM/issues.json" ;;
  "pr list") answer "$SIM/prs.json" ;;
  "run list")
    if [[ $* == *oncall.yml* ]]; then answer "$SIM/runs.json"
    elif [[ -f $SIM/dispatched ]]; then answer "$SIM/rollback-after.json"
    else answer "$SIM/rollback-before.json"; fi ;;
  "issue create") echo "https://github.com/ybenzine/ineedtofocus/issues/$(cat "$SIM/new-issue")" ;;
  "issue comment")
    n=$(ls "$SIM/comments" | wc -l | tr -d ' ')
    for ((i = 0; i < ${#args[@]}; i++)); do
      [[ ${args[i]} == --body-file ]] && cp "${args[i + 1]}" "$SIM/comments/$((n + 1))-$3.md"
    done ;;
  "issue lock" | "issue edit" | "issue close" | "label create" | "pr merge" | "pr checks") ;;
  "workflow run") touch "$SIM/dispatched" ;;
  "run watch") exit "$(cat "$SIM/watch-exit" 2> /dev/null || echo 0)" ;;
  "pr view") answer "$SIM/pr.json" ;;
  "pr create") echo "https://github.com/ybenzine/ineedtofocus/pull/$(cat "$SIM/new-pr")" ;;
  "pr review") ;;
  "auth setup-git") ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
exit 0
"""

FAKE_CLAUDE = r"""#!/usr/bin/env bash
# Fake claude: the flag probe answers like the pinned CLI; a session saves its prompt and
# runs the scenario's script for that agent, with the session's environment.
if [[ $# -eq 2 && $1 == -p ]]; then
  echo "error: option '$2 <value>' argument missing" >&2
  exit 1
fi
agent=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  [[ ${args[i]} == --agent ]] && agent=${args[i + 1]}
done
n=$(ls "$SIM/sessions" | wc -l | tr -d ' ')
session="$SIM/sessions/$((n + 1))-$agent"
mkdir -p "$session"
cat > "$session/prompt.md"
printf '%s\n' "$@" > "$session/args"
printf 'GH_TOKEN=%s\nANTHROPIC_API_KEY=%s\n' \
  "${GH_TOKEN:-}" "${ANTHROPIC_API_KEY:-}" > "$session/env"
printf 'REVIEWER_APP_KEY=%s\nONCALL_APP_KEY=%s\n' \
  "${REVIEWER_APP_KEY:-}" "${ONCALL_APP_KEY:-}" >> "$session/env"
env > "$session/full-env"
script="$SIM/session-$agent-$((n + 1)).sh"
[[ -f $script ]] || script="$SIM/session-$agent.sh"
[[ -f $script ]] && bash "$script"
echo '{"num_turns": 3, "total_cost_usd": 0.42, "subtype": "success"}'
exit "$(cat "$SIM/claude-exit-$agent" 2> /dev/null || echo 0)"
"""

FAKE_UV = r"""#!/usr/bin/env bash
# Fake uv: only `uv run … reviewer_token.py`, which prints a token if the key file exists.
if [[ $* == *reviewer_token.py* ]]; then
  if [[ -s ${REVIEWER_APP_KEY_PATH:-/nonexistent} ]]; then
    echo "ghs_app_${REVIEWER_APP_ID:-reviewer}"
  else
    echo "reviewer_token: reviewer App key not found at $REVIEWER_APP_KEY_PATH" >&2
    exit 3
  fi
else
  echo "unexpected uv call: $*" >&2
  exit 1
fi
"""


def _lookup(path: str, ctx: dict[str, Any]) -> Any:
    value: Any = ctx
    for part in path.split("."):
        if not isinstance(value, dict) or part not in value:
            return ""
        value = value[part]
    return value


REF = re.compile(r"\b(?:needs|steps|github|secrets|env|runner)(?:\.[A-Za-z0-9_-]+)+")


def evaluate(expr: str, ctx: dict[str, Any], status: dict[str, bool]) -> Any:
    """A GitHub expression (the subset this workflow uses) as Python."""
    strings: list[str] = []

    def keep(m: re.Match[str]) -> str:
        strings.append(m.group(1))
        return f"__s{len(strings) - 1}__"

    py = re.sub(r"'([^']*)'", keep, expr)
    py = REF.sub(lambda m: f"__v({m.group(0)!r})", py)
    py = py.replace("&&", " and ").replace("||", " or ")
    py = re.sub(r"!(?!=)", " not ", py)
    py = re.sub(r"__s(\d+)__", lambda m: repr(strings[int(m.group(1))]), py)
    funcs = {
        "__v": lambda p: _lookup(p, ctx),
        "always": lambda: True,
        "cancelled": lambda: False,
        "success": lambda: status["success"],
        "failure": lambda: status["failure"],
    }
    return eval(py, funcs)  # the workflow's own expressions, in a test


def substitute(text: Any, ctx: dict[str, Any]) -> str:
    """`${{ … }}` parts of a string, evaluated; the rest as is."""
    status = {"success": True, "failure": False}

    def one(m: re.Match[str]) -> str:
        value = evaluate(m.group(1), ctx, status)
        if isinstance(value, bool):
            return str(value).lower()
        return "" if value is None else str(value)

    return re.sub(r"\$\{\{(.*?)\}\}", one, str(text), flags=re.DOTALL)


def condition(expr: Any, ctx: dict[str, Any], status: dict[str, bool]) -> bool:
    if expr is None:
        return status["success"]
    inner = str(expr).strip()
    m = re.fullmatch(r"\$\{\{(.*)\}\}", inner, re.DOTALL)
    if m:
        inner = m.group(1)
    if not re.search(r"\b(always|cancelled|success|failure)\(\)", inner):
        inner = f"success() && ({inner})"
    return bool(evaluate(inner, ctx, status))


class Simulation:
    def __init__(self, tmp: Path, event: dict[str, Any], secrets: dict[str, str]) -> None:
        self.tmp = tmp
        self.workflow: dict[Any, Any] = yaml.safe_load(WORKFLOW.read_text())
        self.secrets = {"GITHUB_TOKEN": WORKFLOW_TOKEN, **secrets}
        self.sim = tmp / "sim"
        for name in ("sessions", "comments", "artifacts"):
            (self.sim / name).mkdir(parents=True)
        (self.sim / "gh.log").touch()
        self.event = tmp / "event.json"
        self.event.write_text(json.dumps(event))
        self.extra_env: dict[str, str] = {}
        self.workflow_env: dict[str, str] = {}
        self.jobs: dict[str, dict[str, Any]] = {}
        self.bin = tmp / "bin"
        self.bin.mkdir()
        jq = shutil.which("jq")
        assert jq, "the simulation needs jq"
        for name, text in (
            ("gh", FAKE_GH),
            ("claude", FAKE_CLAUDE),
            ("uv", FAKE_UV),
            ("npm", "#!/usr/bin/env bash\n"),
            ("sleep", "#!/usr/bin/env bash\n"),
            ("python3", f'#!/usr/bin/env bash\nexec "{sys.executable}" "$@"\n'),
        ):
            (self.bin / name).write_text(text)
            (self.bin / name).chmod(0o755)
        self.path = f"{self.bin}:{Path(jq).parent}:/usr/bin:/bin"
        self.origin = tmp / "origin.git"
        self._make_origin()
        for name, value in (("new-issue", "500"), ("new-pr", "600")):
            self.write(name, value)
        for name in (
            "issues.json",
            "prs.json",
            "runs.json",
            "rollback-before.json",
            "rollback-after.json",
        ):
            self.write(name, "[]")
        self.write("pr.json", "{}")

    def _git(self, cwd: Path, *args: str) -> None:
        env = {
            "PATH": self.path,
            "HOME": str(self.tmp),
            "GIT_CONFIG_GLOBAL": str(self.tmp / "gitconfig"),
        }
        subprocess.run(["git", *args], cwd=cwd, env=env, check=True, capture_output=True)

    def _make_origin(self) -> None:
        (self.tmp / "gitconfig").write_text(
            "[user]\n\tname = sim\n\temail = sim@example.invalid\n[init]\n\tdefaultBranch = main\n"
        )
        seed = self.tmp / "seed"
        seed.mkdir()
        (seed / "README.md").write_text("seed\n")
        self._git(seed, "init", "-q")
        self._git(seed, "add", "README.md")
        self._git(seed, "commit", "-q", "-m", "seed")
        self._git(self.tmp, "clone", "-q", "--bare", str(seed), str(self.origin))

    def write(self, name: str, content: Any) -> None:
        text = content if isinstance(content, str) else json.dumps(content)
        (self.sim / name).write_text(text)

    def session(self, agent: str, script: str, nth: int | None = None) -> None:
        """What a Claude session does: a bash script run in its job's checkout."""
        self.write(f"session-{agent}{'' if nth is None else f'-{nth}'}.sh", script)

    # --- running --------------------------------------------------------------------

    def run(self) -> dict[str, dict[str, Any]]:
        for name, job in self.workflow["jobs"].items():
            self.jobs[name] = self._job(name, job)
        return self.jobs

    def _context(self, job_dir: Path, steps: dict[str, Any]) -> dict[str, Any]:
        return {
            "github": {
                "repository": "ybenzine/ineedtofocus",
                "token": WORKFLOW_TOKEN,
                "server_url": "https://github.com",
                "run_id": "999",
            },
            "secrets": self.secrets,
            "needs": {
                n: {"result": j["result"], "outputs": j["outputs"]} for n, j in self.jobs.items()
            },
            "steps": steps,
            "runner": {"temp": str(job_dir / "runner")},
            "env": {**self.workflow.get("env", {}), **self.workflow_env},
        }

    def _job(self, name: str, job: dict[str, Any]) -> dict[str, Any]:
        needs = job.get("needs") or []
        needs = [needs] if isinstance(needs, str) else needs
        results = [self.jobs[n]["result"] for n in needs]
        status = {
            "success": all(r == "success" for r in results),
            "failure": any(r == "failure" for r in results),
        }
        job_dir = self.tmp / "jobs" / name
        steps: dict[str, Any] = {}
        ctx = self._context(job_dir, steps)
        if not condition(job.get("if"), ctx, status):
            return {"result": "skipped", "outputs": {}}
        (job_dir / "runner").mkdir(parents=True)
        (job_dir / "oncall").mkdir()
        work = job_dir / "work"
        env_base = {
            **{k: str(v) for k, v in self.workflow.get("env", {}).items()},
            **self.workflow_env,
            "ONCALL_OUT": str(job_dir / "oncall"),
            "PATH": self.path,
            "HOME": str(job_dir),
            "GIT_CONFIG_GLOBAL": str(self.tmp / "gitconfig"),
            "SIM": str(self.sim),
            "RUNNER_TEMP": str(job_dir / "runner"),
            "GITHUB_EVENT_PATH": str(self.event),
            "GITHUB_RUN_ID": "999",
            "GITHUB_STEP_SUMMARY": str(job_dir / "summary.md"),
            "GITHUB_ENV": str(job_dir / "github-env"),
            **self.extra_env,
        }
        (job_dir / "github-env").touch()
        for k, v in (job.get("env") or {}).items():
            env_base[k] = substitute(v, ctx)
        failed = False
        for i, step in enumerate(job["steps"]):
            step_status = {"success": not failed, "failure": failed}
            if not condition(step.get("if"), ctx, step_status):
                if "id" in step:
                    steps[step["id"]] = {"outputs": {}, "outcome": "skipped"}
                continue
            ok, outputs = self._step(step, i, job_dir, work, env_base, ctx)
            if "id" in step:
                steps[step["id"]] = {"outputs": outputs, "outcome": "success" if ok else "failure"}
            if not ok and not step.get("continue-on-error"):
                failed = True
        outputs = {k: substitute(v, ctx) for k, v in (job.get("outputs") or {}).items()}
        return {"result": "failure" if failed else "success", "outputs": outputs, "dir": job_dir}

    def _step(
        self,
        step: dict[str, Any],
        index: int,
        job_dir: Path,
        work: Path,
        env_base: dict[str, str],
        ctx: dict[str, Any],
    ) -> tuple[bool, dict[str, str]]:
        uses = str(step.get("uses", ""))
        with_ = {k: substitute(v, ctx) for k, v in (step.get("with") or {}).items()}
        if uses.startswith("actions/checkout@"):
            self._git(job_dir, "clone", "-q", str(self.origin), str(work))
            for linked in ("scripts", "infra"):
                (work / linked).symlink_to(REPO / linked)
            (work / ".git" / "info" / "exclude").write_text("scripts\ninfra\n")
            return True, {}
        if uses.startswith(("actions/setup-node@", "astral-sh/setup-uv@")):
            return True, {}
        oncall = str(job_dir / "oncall")
        if uses.startswith("actions/upload-artifact@"):
            target = self.sim / "artifacts" / with_["name"]
            target.mkdir(parents=True, exist_ok=True)
            for line in with_["path"].split("\n"):
                source = Path(line.strip().replace("/tmp/oncall", oncall)) if line.strip() else None
                if source and source.is_dir():
                    shutil.copytree(source, target, dirs_exist_ok=True)
                elif source and source.is_file():
                    shutil.copy(source, target)
            return True, {}
        if uses.startswith("actions/download-artifact@"):
            source = self.sim / "artifacts" / with_["name"]
            if not source.is_dir():
                return False, {}
            shutil.copytree(source, with_["path"], dirs_exist_ok=True)
            return True, {}
        assert not uses, f"unsimulated action {uses}"
        env = dict(env_base)
        for line in (job_dir / "github-env").read_text().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                env[k] = v
        for k, v in (step.get("env") or {}).items():
            env[k] = substitute(v, ctx)
        output = job_dir / f"output-{index}"
        output.touch()
        env["GITHUB_OUTPUT"] = str(output)
        script = job_dir / f"step-{index}.sh"
        script.write_text(step["run"])
        result = subprocess.run(
            ["bash", "--noprofile", "--norc", "-eo", "pipefail", str(script)],
            cwd=work if work.exists() else job_dir,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        (job_dir / f"step-{index}.log").write_text(result.stdout + result.stderr)
        values = dict(line.split("=", 1) for line in output.read_text().splitlines() if "=" in line)
        return result.returncode == 0, values

    # --- reading the results ------------------------------------------------------

    def gh_calls(self) -> list[str]:
        return (self.sim / "gh.log").read_text().splitlines()

    def comments(self) -> list[tuple[str, str]]:
        """(issue number, body) of every comment posted, in order."""
        found = sorted(self.sim.glob("comments/*.md"), key=lambda p: int(p.name.split("-")[0]))
        return [(p.stem.split("-", 1)[1], p.read_text()) for p in found]

    def sessions(self) -> list[Path]:
        return sorted(self.sim.glob("sessions/*"), key=lambda p: int(p.name.split("-")[0]))

    def log(self, job: str) -> str:
        return "".join(p.read_text() for p in sorted((self.tmp / "jobs" / job).glob("step-*.log")))


def env_of(session: Path) -> dict[str, str]:
    return dict(line.split("=", 1) for line in (session / "env").read_text().splitlines())


__all__ = ["REPO", "WORKFLOW", "WORKFLOW_TOKEN", "Simulation", "env_of", "evaluate", "substitute"]
