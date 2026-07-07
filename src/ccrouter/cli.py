"""ccrouter CLI: launch Claude Code through the router and manage the proxy."""

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import __version__, config, router
from .server import pid_path

SRC_DIR = Path(__file__).resolve().parents[1]

USAGE = """\
ccrouter %s — per-prompt model router for Claude Code

usage: ccrouter <command> [args]

  code [claude args...]   start proxy if needed, launch claude through it
  start                   start the proxy in the background
  stop                    stop the proxy
  status                  show proxy status and recent decisions
  test "<prompt>"         dry-run: show how a prompt would be routed (offline)
  tail                    follow the decision log live
  doctor                  run environment/health checks
""" % __version__


# --------------------------------------------------------------------------
# proxy lifecycle
# --------------------------------------------------------------------------

def health(port: int, timeout: float = 0.5) -> "dict | None":
    try:
        with urllib.request.urlopen(
            "http://127.0.0.1:%d/__ccrouter/health" % port, timeout=timeout
        ) as resp:
            return json.loads(resp.read())
    except (urllib.error.URLError, OSError, ValueError):
        return None


def _read_pid() -> "int | None":
    try:
        return int(pid_path().read_text().strip())
    except (OSError, ValueError):
        return None


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        return sock.connect_ex(("127.0.0.1", port)) != 0


def server_log_path() -> Path:
    return config.state_dir() / "server.log"


def ensure_running(cfg: dict) -> dict:
    """Return health info, spawning the proxy first if needed."""
    port = cfg["port"]
    info = health(port)
    if info:
        return info

    pid = _read_pid()
    if pid and not _pid_alive(pid):
        try:
            pid_path().unlink()
        except OSError:
            pass
    if not _port_free(port):
        _die(
            "port %d is in use but does not answer the ccrouter health check.\n"
            "  Something else is listening there — change \"port\" in %s"
            % (port, config.user_config_path())
        )

    config.state_dir().mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    existing = env.get("PYTHONPATH")
    env["PYTHONPATH"] = str(SRC_DIR) + (os.pathsep + existing if existing else "")
    with open(server_log_path(), "ab") as log:
        subprocess.Popen(
            [sys.executable, "-m", "ccrouter.server"],
            stdout=log,
            stderr=log,
            stdin=subprocess.DEVNULL,
            env=env,
            # Never inherit the caller's cwd: `python -m` puts cwd on
            # sys.path, and an untrusted directory could shadow stdlib
            # modules inside the credential-carrying proxy process.
            cwd=str(config.state_dir()),
            start_new_session=True,
        )
    for _ in range(30):
        time.sleep(0.1)
        info = health(port)
        if info:
            return info
    _die(
        "proxy did not become healthy within 3s. Last server log lines:\n%s"
        % _tail_file(server_log_path(), 10)
    )


def cmd_start(cfg: dict) -> int:
    info = ensure_running(cfg)
    print("proxy running (pid %s) on 127.0.0.1:%d  models=%s"
          % (info.get("pid"), cfg["port"], _models_str(cfg)))
    return 0


def _is_ccrouter_process(pid: int) -> bool:
    try:
        out = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            capture_output=True, text=True, timeout=5,
        ).stdout
        return "ccrouter.server" in out
    except Exception:
        return False


def cmd_stop(cfg: dict) -> int:
    info = health(cfg["port"])
    pid = info.get("pid") if info else _read_pid()
    if not pid or not _pid_alive(pid):
        print("proxy not running")
        return 0
    if not info and not _is_ccrouter_process(pid):
        # Stale pidfile whose pid was recycled by an unrelated process —
        # never signal it.
        try:
            pid_path().unlink()
        except OSError:
            pass
        print("proxy not running (removed stale pidfile)")
        return 0
    os.kill(pid, signal.SIGTERM)
    for _ in range(30):
        if not _pid_alive(pid):
            print("proxy stopped")
            return 0
        time.sleep(0.1)
    os.kill(pid, signal.SIGKILL)
    print("proxy killed")
    return 0


def cmd_status(cfg: dict) -> int:
    info = health(cfg["port"])
    if info:
        print("proxy: running (pid %s) on 127.0.0.1:%d" % (info.get("pid"), cfg["port"]))
        print("routing: %r -> %s" % (cfg["sentinel"], _models_str(cfg)))
        if info.get("user_config_error"):
            print("WARNING broken user config ignored: %s" % info["user_config_error"])
    else:
        print("proxy: not running (start with: ccrouter start)")
    print("state dir: %s" % config.state_dir())
    log = config.state_dir() / "decisions.jsonl"
    if log.exists():
        print("recent decisions:")
        for line in _tail_file(log, 3).splitlines():
            rendered = _render_decision(line)
            if rendered:
                print("  " + rendered)
    return 0


# --------------------------------------------------------------------------
# code (the wrapper)
# --------------------------------------------------------------------------

def cmd_code(cfg: dict, args: list) -> int:
    if shutil.which("claude") is None:
        _die("`claude` not found on PATH")
    ensure_running(cfg)
    env = os.environ.copy()
    env["ANTHROPIC_BASE_URL"] = "http://127.0.0.1:%d" % cfg["port"]
    argv = ["claude"]
    has_model = any(a == "--model" or a.startswith("--model=") for a in args)
    if not has_model:
        argv += ["--model", cfg["sentinel"]]
    argv += args
    sys.stderr.write(
        "[ccrouter] routing %r -> %s via 127.0.0.1:%d\n"
        % (cfg["sentinel"], _models_str(cfg), cfg["port"])
    )
    sys.stderr.flush()
    os.execvpe("claude", argv, env)  # replaces this process; does not return


# --------------------------------------------------------------------------
# test / tail / doctor
# --------------------------------------------------------------------------

def cmd_test(cfg: dict, args: list) -> int:
    if not args:
        _die('usage: ccrouter test "<prompt>"')
    prompt = " ".join(args)
    body = {
        "model": cfg["sentinel"],
        "messages": [{"role": "user", "content": prompt}],
    }
    raw_len = len(json.dumps(body))
    decision = router.decide("/v1/messages", {}, body, raw_len, cfg)
    print("prompt : %s" % (prompt if len(prompt) <= 100 else prompt[:97] + "..."))
    print("tier   : %s" % decision.tier.upper())
    print("model  : %s" % decision.model)
    print("score  : %+d" % decision.score)
    print("rule   : %s" % decision.rule)
    print("signals: %s" % (", ".join(decision.signals) or "-"))
    return 0


def _render_decision(line: str) -> "str | None":
    try:
        entry = json.loads(line)
    except ValueError:
        return None
    ts = entry.get("ts", "")[-8:]
    agent = " agent" if entry.get("agent") else ""
    prompt = (" | " + entry["prompt"]) if entry.get("prompt") else ""
    return "%s  %-4s %-22s %+d  %s%s  [%s]%s" % (
        ts,
        (entry.get("tier") or "?").upper(),
        entry.get("model", "?"),
        entry.get("score", 0),
        entry.get("rule", "?"),
        agent,
        ", ".join(entry.get("signals", [])[:4]),
        prompt,
    )


def cmd_tail(cfg: dict, args: list) -> int:
    log = config.state_dir() / "decisions.jsonl"
    config.state_dir().mkdir(parents=True, exist_ok=True)
    log.touch(exist_ok=True)
    print("following %s (Ctrl-C to quit)" % log)
    with open(log, "r", encoding="utf-8") as f:
        for line in _tail_file(log, 10).splitlines():
            rendered = _render_decision(line)
            if rendered:
                print(rendered)
        f.seek(0, os.SEEK_END)
        try:
            while True:
                line = f.readline()
                if line:
                    rendered = _render_decision(line)
                    if rendered:
                        print(rendered)
                else:
                    time.sleep(0.25)
        except KeyboardInterrupt:
            print()
            return 0


def cmd_doctor(cfg: dict) -> int:
    failures = 0

    def check(name: str, ok: bool, hint: str = "") -> None:
        nonlocal failures
        mark = "\033[32m✓\033[0m" if ok else "\033[31m✗\033[0m"
        print("%s %s" % (mark, name))
        if not ok:
            failures += 1
            if hint:
                print("    -> %s" % hint)

    check("python %d.%d" % sys.version_info[:2], sys.version_info >= (3, 8),
          "needs python 3.8+")
    check("claude on PATH", shutil.which("claude") is not None,
          "install Claude Code first")
    check("config loads", not cfg.get("_user_config_error"),
          str(cfg.get("_user_config_error")))
    if cfg.get("_user_config_loaded"):
        print("    user config: %s" % cfg["_user_config_loaded"])

    info = health(cfg["port"])
    if info:
        check("proxy healthy on port %d (pid %s)" % (cfg["port"], info.get("pid")), True)
    else:
        free = _port_free(cfg["port"])
        check("proxy not running; port %d %s" % (cfg["port"], "free" if free else "IN USE"),
              free, "another process owns the port — change \"port\" in config")

    import http.client as hc
    try:
        conn = hc.HTTPSConnection(cfg["upstream_host"], timeout=5)
        conn.request("HEAD", "/")
        conn.getresponse().read()
        conn.close()
        check("upstream %s reachable (TLS ok)" % cfg["upstream_host"], True)
    except Exception as exc:
        check("upstream %s reachable" % cfg["upstream_host"], False, str(exc))

    print("routing: %r -> %s" % (cfg["sentinel"], _models_str(cfg)))
    if cfg["models"]["high"] == "claude-opus-4-6":
        print("note: if HIGH-tier requests 404 on your plan, the proxy retries at MID\n"
              "      and you can set models.high to \"claude-opus-4-8\" in %s"
              % config.user_config_path())
    return 1 if failures else 0


# --------------------------------------------------------------------------

def _models_str(cfg: dict) -> str:
    models = cfg["models"]
    return "%s | %s | %s" % (models["low"], models["mid"], models["high"])


def _tail_file(path: Path, n: int) -> str:
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        return "\n".join(lines[-n:])
    except OSError:
        return ""


def _die(message: str) -> None:
    sys.stderr.write("ccrouter: %s\n" % message)
    sys.exit(1)


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(USAGE)
        return 0
    command, args = argv[0], argv[1:]
    cfg = config.load_config()
    if command == "code":
        return cmd_code(cfg, args)
    if command == "start":
        return cmd_start(cfg)
    if command == "stop":
        return cmd_stop(cfg)
    if command == "status":
        return cmd_status(cfg)
    if command == "test":
        return cmd_test(cfg, args)
    if command == "tail":
        return cmd_tail(cfg, args)
    if command == "doctor":
        return cmd_doctor(cfg)
    _die("unknown command %r\n\n%s" % (command, USAGE))
