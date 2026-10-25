"""The on-call sessions' tool permissions (#232): scripts/oncall-claude.sh.

On a fresh runner the workspace isn't trusted, so Claude Code ignores every allow rule in
.claude/settings.json, and a `dontAsk` session that relied on them was refused every tool
it needed (oncall run 40240380314). Each session now gets its own allow list on the
command line.

Two layers:

- Always: the wrapper, run with a fake `claude`, passes each session its own tools, its
  pinned allow list and the deny list, in `dontAsk` mode, and never a rule that would let
  it run any Python, any `gh api` or any `git` command.
- With the on-call workflow's pinned Claude Code on PATH (CI installs it and sets
  ONCALL_CLI_CHECK=required, so it can't skip there): the real CLI, on a fresh untrusted
  checkout with the repo's own .claude/ and an empty HOME, talks to a fake Messages API
  that asks for one tool call per turn. What the CLI allowed and refused is in its result
  JSON (`permission_denials`). No API key, no cost, no network beyond 127.0.0.1.
"""

from __future__ import annotations

import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any, ClassVar

import oncall as o
import pytest
import yaml  # type: ignore[import-untyped]  # no stubs in the locked env

REPO = Path(__file__).resolve().parents[2]
WRAPPER = REPO / "scripts" / "oncall-claude.sh"
PINNED = yaml.safe_load((REPO / ".github" / "workflows" / "oncall.yml").read_text())["env"][
    "CLAUDE_CODE_VERSION"
]
SESSIONS = ("respond", "review", "follow-up")
AGENT = {"respond": "oncall", "review": "oncall-reviewer", "follow-up": "oncall"}
DEFINITION = {"respond": "oncall", "review": "reviewer", "follow-up": "oncall"}
TOOLS = {
    "respond": "Read,Write,Edit,Bash",
    "review": "Read,Write,Bash",
    "follow-up": "Read,Write,Bash",
}
GH_READ = [
    "Bash(gh issue view *)",
    "Bash(gh pr view *)",
    "Bash(gh pr diff *)",
    "Bash(gh pr checks *)",
]
GRAFANA = ["Bash(python3 scripts/oncall_grafana.py *)"]


def allowed(session: str, out: str) -> list[str]:
    """Each session's allow list, pinned: a change shows up here, in review."""
    if session == "review":
        return [*GH_READ, f"Edit(/{out}/review.md)", f"Edit(/{out}/review.json)"]
    if session == "follow-up":
        return [
            *GH_READ,
            *GRAFANA,
            "Bash(gh run view *)",
            "Bash(gh run list *)",
            f"Edit(/{out}/comment.md)",
        ]
    return [
        *GH_READ,
        *GRAFANA,
        "Bash(gh issue list *)",
        "Bash(gh pr list *)",
        "Bash(gh run view *)",
        "Bash(gh run list *)",
        f"Edit(/{out}/decision.json)",
        f"Edit(/{out}/comment.md)",
        f"Edit(/{out}/pr.md)",
        "Bash(git switch -c oncall/*)",
        "Bash(git add *)",
        "Bash(git commit -m *)",
        "Bash(make test-backend-unit)",
        "Bash(make test-scripts)",
        "Bash(make test-frontend)",
        "Bash(make lint-backend)",
        "Bash(make lint-scripts)",
        "Bash(make lint-frontend)",
        "Edit(./backend/**)",
        "Edit(./frontend/**)",
        "Edit(./scripts/**)",
        "Edit(./infra/**)",
        "Edit(./_docs/**)",
    ]


# --- The wrapper's command line (fake claude) -------------------------------------------

FAKE_CLAUDE = r"""#!/usr/bin/env bash
if [[ $# -eq 2 && $1 == -p ]]; then
  echo "error: option '$2 <value>' argument missing" >&2
  exit 1
fi
printf '%s\n' "$@" > "$ARGS_FILE"
echo '{"type": "result", "subtype": "success", "num_turns": 1}'
"""


def options(argv: list[str]) -> dict[str, list[str]]:
    """`claude` arguments by flag: each flag's values run to the next flag."""
    result: dict[str, list[str]] = {}
    current = ""
    for arg in argv:
        if arg.startswith("--"):
            current = arg
            result[current] = []
        elif current:
            result[current].append(arg)
    return result


def checkout(root: Path) -> Path:
    """A fresh checkout's worth of what the sessions see: the repo's own .claude/ (its
    settings and agent definitions), the wrapper, and a stub of the Grafana script."""
    root.mkdir(parents=True)
    shutil.copytree(REPO / ".claude" / "agents", root / ".claude" / "agents")
    shutil.copy(REPO / ".claude" / "settings.json", root / ".claude" / "settings.json")
    for name in ("AGENTS.md", "CLAUDE.md"):
        shutil.copy(REPO / name, root / name)
    (root / "scripts").mkdir()
    shutil.copy(WRAPPER, root / "scripts" / "oncall-claude.sh")
    # The review's agent comes from `oncall.py reviewer-agent`; Python resolves the link,
    # so it imports its modules from the repo.
    (root / "scripts" / "oncall.py").symlink_to(REPO / "scripts" / "oncall.py")
    (root / "scripts" / "oncall_grafana.py").write_text(
        'import sys\nprint("grafana ok", *sys.argv[1:])\n'
    )
    return root


def run_wrapper(
    session: str, work: Path, out: Path, env: dict[str, str], turns: int = 5
) -> subprocess.CompletedProcess[str]:
    prompt = work.parent / f"{session}-prompt.md"
    prompt.write_text("Probe the session's permissions.\n")
    return subprocess.run(
        [
            "bash",
            "scripts/oncall-claude.sh",
            session,
            str(turns),
            "1",
            str(prompt),
            str(work.parent / f"{session}-result.json"),
        ],
        cwd=work,
        env={**env, "ONCALL_OUT": str(out)},
        capture_output=True,
        text=True,
        timeout=300,
    )


@pytest.mark.parametrize("session", SESSIONS)
def test_each_session_gets_its_own_allow_list_on_the_command_line(
    tmp_path: Path, session: str
) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "claude").write_text(FAKE_CLAUDE)
    (bin_dir / "python3").write_text(f'#!/usr/bin/env bash\nexec "{sys.executable}" "$@"\n')
    for name in ("claude", "python3"):
        (bin_dir / name).chmod(0o755)
    work = checkout(tmp_path.resolve() / "work")
    out = tmp_path.resolve() / "oncall"
    args_file = tmp_path / "args"
    env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "HOME": str(tmp_path), "ARGS_FILE": str(args_file)}
    done = run_wrapper(session, work, out, env)
    assert done.returncode == 0, done.stdout + done.stderr
    argv = args_file.read_text().splitlines()
    assert argv[0] == "-p"
    opts = options(argv)
    assert opts["--agent"] == [AGENT[session]]
    if session == "review":
        # The reviewer's own definition, plus Write for its two files (#232).
        (agents,) = opts["--agents"]
        assert json.loads(agents) == o.ci_reviewer_agent()
    else:
        assert "--agents" not in opts
    assert opts["--tools"] == [TOOLS[session]]
    assert opts["--permission-mode"] == ["dontAsk"]
    assert opts["--add-dir"] == [str(out)]
    # The permissions are the wrapper's, not the project settings' (which a fresh runner
    # ignores anyway), and nothing turns the checks off.
    assert opts["--allowedTools"] == allowed(session, str(out))
    joined = " ".join(argv)
    for never in (
        "--dangerously-skip-permissions",
        "bypassPermissions",
        "--settings",
        "--setting-sources",
        "--permission-prompt-tool",
    ):
        assert never not in joined
    for rule in opts["--allowedTools"]:
        # Every rule is scoped: no bare tool, and no rule that runs any Python, any
        # `gh api`, any git command or any make target.
        assert re.fullmatch(r"(Bash|Edit)\(.+\)", rule), rule
        assert rule not in ("Bash(python3 *)", "Bash(gh *)", "Bash(git *)", "Bash(make *)")
        assert not rule.startswith(("Bash(gh api", "Bash(gh workflow", "Bash(git push")), rule
    denied = opts["--disallowedTools"]
    for rule in (
        "Bash(gh workflow *)",
        "Bash(git push *)",
        "Bash(gh api *)",
        "Bash(scripts/reviewer-review.sh *)",
        "Edit(./.github/**)",
        "Edit(./.claude/**)",
    ):
        assert rule in denied
    if session == "respond":
        for rule in (
            "Bash(git commit * -*F*)",
            "Bash(git commit * --*)",
            "Bash(git add *--pathspec*)",
        ):
            assert rule in denied
    assert "::notice title=Session permissions::" in done.stdout


def test_the_wrapper_refuses_an_unknown_session_and_a_wrong_directory(tmp_path: Path) -> None:
    prompt = tmp_path / "p.md"
    prompt.write_text("x\n")
    for args, cwd in (
        (["oncall", "5", "1", str(prompt), str(tmp_path / "r.json")], REPO),
        (["respond", "5", "1", str(prompt), str(tmp_path / "r.json"), "Bash(make *)"], REPO),
        (["respond", "5", "1", str(prompt), str(tmp_path / "r.json")], tmp_path),
    ):
        done = subprocess.run(
            ["bash", str(WRAPPER), *args], cwd=cwd, capture_output=True, text=True
        )
        assert done.returncode == 2, (args, done.stderr)


def test_the_reviewer_people_run_stays_read_only() -> None:
    """Only the headless review gets Write, through --agents (#232); the definition in
    .claude/agents/ keeps no Write or Edit tool."""
    text = (REPO / ".claude" / "agents" / "reviewer.md").read_text()
    (tools,) = re.findall(r"^tools: (.*)$", text, re.MULTILINE)
    names = {t.strip() for t in tools.split(",")}
    assert not names & {"Write", "Edit", "NotebookEdit", "MultiEdit"}, names
    agent = o.ci_reviewer_agent()[o.CI_REVIEWER]
    assert agent["tools"] == [*tools.replace(" ", "").split(","), "Write"]
    assert agent["prompt"] == text.split("\n---\n", 1)[1].strip()
    assert agent["model"] == "opus" and agent["description"].startswith("Reviewer agent")
    assert o.main(["reviewer-agent"]) == 0


def test_ci_installs_the_on_call_workflows_pinned_cli() -> None:
    ci = yaml.safe_load((REPO / ".github" / "workflows" / "ci.yml").read_text())
    assert ci["env"]["CLAUDE_CODE_VERSION"] == PINNED
    steps = ci["jobs"]["backend-unit"]["steps"]
    install = [s for s in steps if "@anthropic-ai/claude-code@" in str(s.get("run", ""))]
    assert install and install[0]["run"].endswith(
        '"@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION"'
    )
    (tests,) = [s for s in steps if "make test-scripts" in str(s.get("run", ""))]
    assert tests["env"]["ONCALL_CLI_CHECK"] == "required"
    assert steps.index(install[0]) < steps.index(tests)


# --- The pinned CLI, against a fake Messages API ---------------------------------------


class FakeAPI(http.server.BaseHTTPRequestHandler):
    """Answers the Messages API: one scripted tool call per turn, then "done". Records
    every tool result it gets back."""

    calls: ClassVar[list[dict[str, Any]]] = []
    results: ClassVar[dict[str, dict[str, Any]]] = {}

    def log_message(self, *_: Any) -> None:
        pass

    def do_GET(self) -> None:
        self.send_response(404)
        self.end_headers()

    def _json(self, data: dict[str, Any]) -> None:
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        request = json.loads(self.rfile.read(int(self.headers["content-length"])) or b"{}")
        if "count_tokens" in self.path:
            self._json({"input_tokens": 10})
            return
        done = 0
        for message in request.get("messages", []):
            content = message.get("content")
            for block in content if isinstance(content, list) else []:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    FakeAPI.results[block["tool_use_id"]] = block
                    done += 1
        tools = {t.get("name") for t in request.get("tools", [])}
        if "Bash" in tools and done < len(FakeAPI.calls):
            call = FakeAPI.calls[done]
            block = {
                "type": "tool_use",
                "id": f"toolu_{done:03d}",
                "name": call["tool"],
                "input": call["input"],
            }
            stop = "tool_use"
        else:
            block, stop = {"type": "text", "text": "done"}, "end_turn"
        message = {
            "id": "msg_oc232",
            "type": "message",
            "role": "assistant",
            "model": request.get("model"),
            "content": [block],
            "stop_reason": stop,
            "stop_sequence": None,
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }
        if not request.get("stream"):
            self._json(message)
            return
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()

        def event(name: str, data: dict[str, Any]) -> None:
            self.wfile.write(
                f"event: {name}\ndata: {json.dumps({'type': name, **data})}\n\n".encode()
            )

        event("message_start", {"message": {**message, "content": [], "stop_reason": None}})
        if block["type"] == "tool_use":
            event("content_block_start", {"index": 0, "content_block": {**block, "input": {}}})
            delta = {"type": "input_json_delta", "partial_json": json.dumps(block["input"])}
        else:
            event(
                "content_block_start", {"index": 0, "content_block": {"type": "text", "text": ""}}
            )
            delta = {"type": "text_delta", "text": block["text"]}
        event("content_block_delta", {"index": 0, "delta": delta})
        event("content_block_stop", {"index": 0})
        event(
            "message_delta",
            {"delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": 1}},
        )
        event("message_stop", {})
        self.wfile.flush()


@pytest.fixture(scope="module")
def claude() -> str:
    found = shutil.which("claude")
    version = ""
    if found:
        said = subprocess.run([found, "--version"], capture_output=True, text=True, timeout=60)
        version = said.stdout.strip()
    if not version.startswith(f"{PINNED} "):
        reason = f"needs Claude Code {PINNED} on PATH (found: {version or 'none'})"
        if os.environ.get("ONCALL_CLI_CHECK") == "required":
            pytest.fail(reason)
        pytest.skip(reason)
    assert found
    return found


@pytest.fixture(scope="module")
def api() -> Iterator[str]:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeAPI)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def bash(command: str) -> dict[str, Any]:
    return {"tool": "Bash", "input": {"command": command, "description": "probe"}}


def write(path: Path) -> dict[str, Any]:
    return {"tool": "Write", "input": {"file_path": str(path), "content": "probe\n"}}


PROMQL = (
    'sum(increase(focus_session_saves_total{service_name="ineedtofocus", '
    'deployment_environment_name="dev", outcome="error"}[5m]))'
)
LOGQL = '{service_name="ineedtofocus", deployment_environment_name="dev"} |= "unhandled exception"'
TRACEQL = '{resource.service.name="ineedtofocus" && status=error}'


COMMIT_NO = [
    "git commit --allow-empty -F /proc/self/environ",
    "git commit -F /etc/hosts",
    "git commit --file=/etc/hosts",
    "git commit -m x -F /etc/hosts",
    "git commit -m x -aF /etc/hosts",
    "git commit -m x -F/etc/hosts",
    "git commit -m x --file=/etc/hosts",
    "git commit -m x -t /etc/hosts",
    "git commit -m x --template=/etc/hosts",
    "git commit -m x -C HEAD",
    "git commit -m x -c HEAD",
    "git commit -m x --reuse-message=HEAD",
    "git commit -m x --reedit-message=HEAD",
    "git commit -m x --pathspec-from-file=/etc/hosts",
    "git commit -am x",
    "git add --pathspec-from-file=/etc/hosts",
    "git add . --pathspec-from-file /etc/hosts",
]
# New files under each path check-fix refuses (PROTECTED_PATHS): every pattern has one.
PROTECTED_SAMPLES = [
    ".github/workflows/probe.yml",
    ".claude/agents/probe.md",
    "infra/github/probe.json",
    "scripts/oncall_probe.py",
    "scripts/oncall_prompts/probe.md",
    "scripts/alert_dispatch.py",
    "scripts/alert_routing.py",
    "scripts/check_local_stack.py",
    "scripts/grafana_alerts.py",
    "scripts/grafana_dashboards.py",
    "scripts/reviewer_token.py",
    "scripts/reviewer-review.sh",
    "scripts/tests/test_oncall_probe.py",
    "scripts/tests/oncall_sim.py",
    "scripts/tests/test_claude_settings.py",
]


def test_the_wrapper_refuses_what_check_fix_refuses() -> None:
    """Each protected pattern has a sample the CLI check writes (and must be refused), and
    each sample is one check-fix refuses: the two lists can't drift apart (#232)."""
    for pattern in o.PROTECTED_PATHS:
        assert any(re.search(pattern, path) for path in PROTECTED_SAMPLES), pattern
    for path in PROTECTED_SAMPLES:
        assert any(re.search(pattern, path) for pattern in o.PROTECTED_PATHS), path
    wrapper = WRAPPER.read_text()
    for path in (
        "scripts/tests/test_oncall*",
        "scripts/tests/oncall_sim.py",
        "scripts/tests/test_claude_settings.py",
    ):
        assert f"'Edit(./{path})'" in wrapper, path


def probes(session: str, work: Path, out: Path) -> list[tuple[dict[str, Any], bool]]:
    """(tool call, allowed?) for a session. The commands its prompt and runbook name, then
    what it mustn't do, including what the project settings would allow if they applied."""
    common_no = [
        bash("gh workflow run rollback.yml -f env=dev"),
        bash("gh api repos/ybenzine/ineedtofocus/issues/1"),
        bash("git push origin HEAD:main"),
        bash("python3 -c 'print(1)'"),  # .claude/settings.json allows `python3 *`
        bash("python3 scripts/oncall_grafana.py wait session-save-errors dev normal"),
        bash("python3 scripts/oncall_grafana.py $(echo journey) dev"),
        bash("gh pr merge 12 --squash"),
        bash("gh issue comment 7 --body-file x.md"),
        bash("scripts/reviewer-review.sh 12 approve x.md"),
        bash("curl -s https://example.com"),
        bash("env"),
        # Secret variables never expand into an allowed command (plain $HOME does).
        bash("python3 scripts/oncall_grafana.py journey $ANTHROPIC_API_KEY"),
        bash('gh issue view "$GRAFANA_READONLY_TOKEN"'),
        bash("gh pr view ${GH_TOKEN}"),
        bash("cat /etc/hosts"),
        {"tool": "Read", "input": {"file_path": "/etc/hosts"}},
        write(out / "prompt.md"),
        write(work / ".github" / "workflows" / "probe.yml"),
        write(work / ".claude" / "settings.json"),
        write(work / "probe.md"),
    ]
    common_yes = [
        {
            "tool": "Read",
            "input": {"file_path": str(work / ".claude" / "agents" / f"{DEFINITION[session]}.md")},
        },
        bash("ls scripts"),
        bash("grep -rn oncall .claude/agents"),
        bash("git log --oneline -1"),
        bash("git status --short"),
        bash("git diff --stat"),
        bash("git show --stat HEAD"),
        bash("gh pr view 12 --json files"),
        bash("gh issue view 7 --comments"),
    ]
    if session == "review":
        yes = [
            *common_yes,
            bash("gh pr diff 12"),
            bash("gh pr checks 12"),
            write(out / "review.md"),
            write(out / "review.json"),
        ]
        no = [
            *common_no,
            bash("make test-scripts"),
            bash("gh pr checkout 12"),
            bash("python3 scripts/oncall_grafana.py journey dev"),
            write(out / "comment.md"),
            write(work / "backend" / "probe.py"),
        ]
    elif session == "follow-up":
        yes = [
            *common_yes,
            bash("python3 scripts/oncall_grafana.py journey dev"),
            bash("python3 scripts/oncall_grafana.py alerts dev"),
            bash("gh run view 9"),
            write(out / "comment.md"),
        ]
        no = [
            *common_no,
            bash("make test-scripts"),
            bash("git switch -c oncall/7-probe"),
            write(out / "decision.json"),
            write(work / "backend" / "probe.py"),
        ]
    else:
        yes = [
            *common_yes,
            bash("python3 scripts/oncall_grafana.py journey dev"),
            # The runbook's queries, quotes, braces and pipes included.
            bash(f"python3 scripts/oncall_grafana.py prom '{PROMQL}' --minutes 60"),
            bash(f"python3 scripts/oncall_grafana.py logs '{LOGQL}'"),
            bash(f"python3 scripts/oncall_grafana.py traces '{TRACEQL}'"),
            bash("python3 scripts/oncall_grafana.py trace 4bf92f3577b34da6a3ce929d0e0e4736"),
            bash("gh run list --workflow ci.yml --branch main --event push --limit 5"),
            bash("gh run list --workflow deploy-prod.yml --limit 5"),
            bash("gh pr list --state merged --limit 10"),
            write(out / "decision.json"),
            write(out / "comment.md"),
            write(out / "pr.md"),
            bash("git switch -c oncall/7-probe"),
            write(work / "backend" / "tests" / "unit" / "test_probe.py"),
            {
                "tool": "Edit",
                "input": {
                    "file_path": str(work / "backend" / "tests" / "unit" / "test_probe.py"),
                    "old_string": "probe",
                    "new_string": "probe, edited",
                },
            },
            bash("git add backend/tests/unit/test_probe.py"),
            bash("git commit -m 'fix: probe (Refs #7)'"),
            bash('git commit -m "test: re-try a null-goal save, CI-safe (Refs #7)"'),
            bash("make test-backend-unit"),
        ]
        no = [
            *common_no,
            bash("make test-scripts SHELL=/bin/sh"),
            bash("git checkout -b probe"),
            # A commit's message comes from -m only: nothing reads a file into it.
            *(bash(c) for c in COMMIT_NO),
            # What check-fix refuses, refused before the session writes it.
            *(write(work / path) for path in PROTECTED_SAMPLES),
        ]
    return [(c, True) for c in yes] + [(c, False) for c in no]


@pytest.mark.parametrize("session", SESSIONS)
def test_the_pinned_cli_allows_each_session_exactly_its_tools(
    tmp_path: Path, claude: str, api: str, session: str
) -> None:
    root = tmp_path.resolve()
    work = checkout(root / "work")
    out = root / "oncall"
    home = root / "home"  # empty: the workspace was never trusted, like a fresh runner
    home.mkdir()
    (home / ".gitconfig").write_text("[user]\n\tname = probe\n\temail = probe@example.invalid\n")
    bin_dir = root / "bin"
    bin_dir.mkdir()
    for name, text in (
        ("gh", '#!/usr/bin/env bash\necho "gh ok $*"\n'),
        ("make", '#!/usr/bin/env bash\necho "make ok $*"\n'),
        ("python3", f'#!/usr/bin/env bash\nexec "{sys.executable}" "$@"\n'),
    ):
        (bin_dir / name).write_text(text)
        (bin_dir / name).chmod(0o755)
    git = shutil.which("git")
    assert git
    path = [str(bin_dir), str(Path(claude).parent), str(Path(git).parent), "/usr/bin", "/bin"]
    node = shutil.which("node")
    if node:
        path.append(str(Path(node).parent))
    env = {
        "PATH": ":".join(path),
        "HOME": str(home),
        "ANTHROPIC_BASE_URL": api,
        "ANTHROPIC_API_KEY": "sk-ant-oc232-fake",
        "GRAFANA_READONLY_TOKEN": "glsa_oc232_fake",
        "GH_TOKEN": "ghs_oc232fake",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "DISABLE_AUTOUPDATER": "1",
        "GIT_CONFIG_NOSYSTEM": "1",
    }
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=work, env=env, check=True)
    subprocess.run(["git", "add", "."], cwd=work, env=env, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "seed"], cwd=work, env=env, check=True)
    table = probes(session, work, out)
    FakeAPI.calls = [call for call, _ in table]
    FakeAPI.results = {}
    done = run_wrapper(session, work, out, env, turns=len(table) + 5)
    result = json.loads((root / f"{session}-result.json").read_text())
    assert result.get("subtype") == "success", (result, done.stderr)
    # The project's allow rules don't apply: the session's permissions are the wrapper's.
    assert "this workspace has not been trusted" in done.stderr
    denied = {d["tool_use_id"] for d in result["permission_denials"]}
    wrong = []
    for i, (call, ok) in enumerate(table):
        tool_id = f"toolu_{i:03d}"
        assert tool_id in FakeAPI.results, f"the CLI never ran {call}"
        if ok == (tool_id in denied):
            wrong.append(("refused" if ok else "allowed", call["tool"], call["input"]))
    assert not wrong, wrong
    for call, ok in table:
        if ok and call["tool"] == "Write":
            assert Path(call["input"]["file_path"]).is_file(), call
