#!/usr/bin/env python3
"""Supervise a loopback demo and authenticated gateway in an existing notebook pod.

This survives kernel disconnects, not replacement or restart of the notebook pod.
It never changes Kubernetes resources or stops the existing notebook server.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

from workshop import APP_ROOT, DeployError, validate_endpoint


def private_write(path: Path, content: str) -> None:
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(content)
    os.replace(temporary, path)


def nginx_path(path: Path) -> str:
    value = str(path)
    if "\n" in value or "\r" in value:
        raise DeployError("Paths must not contain line breaks")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def make_config(prefix: Path) -> str:
    gateway = (APP_ROOT / "deploy/gateway.conf").read_text()
    gateway = gateway.replace("@@NOTEBOOK_UPSTREAM@@", "127.0.0.1:8080")
    gateway = gateway.replace("listen 8080;", "listen 8090;")
    return ("worker_processes 1;\n"
            f"pid {nginx_path(prefix / 'nginx.pid')};\n"
            f"error_log {nginx_path(prefix / 'nginx-error.log')} warn;\n"
            "events { worker_connections 1024; }\nhttp {\n"
            "    access_log off;\n"
            f"    client_body_temp_path {nginx_path(prefix / 'client-body')};\n"
            f"    proxy_temp_path {nginx_path(prefix / 'proxy-temp')};\n"
            "    proxy_buffering off;\n" + gateway + "\n}\n")


def lock_file(prefix: Path):
    descriptor = os.open(prefix / "supervisor.lock", os.O_RDWR | os.O_CREAT, 0o600)
    stream = os.fdopen(descriptor, "r+")
    try:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        stream.close()
        return None
    return stream


def status(prefix: Path) -> dict:
    if not prefix.is_dir():
        return {"running": False, "state": "not_started"}
    lock = lock_file(prefix)
    running = lock is None
    if lock is not None:
        lock.close()
    try:
        result = json.loads((prefix / "status.json").read_text())
    except (FileNotFoundError, ValueError):
        result = {"state": "starting" if running else "not_started"}
    result["running"] = running
    return result


def process_is_supervisor(pid: int, prefix: Path) -> bool:
    try:
        command = (Path("/proc") / str(pid) / "cmdline").read_bytes().split(b"\0")
        return (str(Path(__file__).resolve()).encode() in command and b"_supervise" in command
                and str(prefix).encode() in command)
    except OSError:
        return False


def child_commands(app_dir: Path, nginx: Path, prefix: Path) -> dict[str, list[str]]:
    return {
        "app": [sys.executable, str(app_dir / "server.py"), "--host", "127.0.0.1", "--port", "8081"],
        "gateway": [str(nginx), "-p", str(prefix) + "/", "-c", str(prefix / "nginx.conf"), "-g", "daemon off;"]}


def supervise(prefix: Path, app_dir: Path, nginx: Path) -> int:
    lock = lock_file(prefix)
    if lock is None:
        raise DeployError("A supervisor already owns this session prefix")
    stopping = False
    def stop_signal(signum, frame):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM, stop_signal)
    signal.signal(signal.SIGINT, stop_signal)
    children = {}
    logs = {}
    restarts = {name: 0 for name in ("app", "gateway")}
    next_start = {name: 0.0 for name in restarts}
    commands = child_commands(app_dir, nginx, prefix)
    snapshot = {"supervisorPid": os.getpid(), "startedAt": time.time(), "state": "running", "children": {}}
    try:
        for name in commands:
            logs[name] = os.fdopen(os.open(prefix / f"{name}.log", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600), "a")
        while not stopping:
            now = time.monotonic()
            for name, command in commands.items():
                child = children.get(name)
                if child is not None and child.poll() is not None:
                    snapshot["children"][name]["lastExit"] = child.returncode
                    children[name] = None
                    restarts[name] += 1
                    next_start[name] = now + min(30, 2 ** min(restarts[name], 5))
                    child = None
                if child is None and now >= next_start[name]:
                    child = subprocess.Popen(command, cwd=app_dir, stdin=subprocess.DEVNULL,
                                             stdout=logs[name], stderr=subprocess.STDOUT,
                                             start_new_session=True, close_fds=True)
                    children[name] = child
                snapshot["children"].setdefault(name, {})
                snapshot["children"][name].update({"pid": child.pid if child else None,
                    "running": child is not None and child.poll() is None, "restarts": restarts[name]})
            snapshot["updatedAt"] = time.time()
            private_write(prefix / "status.json", json.dumps(snapshot, indent=2) + "\n")
            time.sleep(0.5)
    finally:
        for child in children.values():
            if child is not None and child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        deadline = time.monotonic() + 5
        for child in children.values():
            if child is not None:
                try:
                    child.wait(timeout=max(0.1, deadline - time.monotonic()))
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
        for stream in logs.values():
            stream.close()
        snapshot.update({"state": "stopped", "updatedAt": time.time()})
        for row in snapshot["children"].values():
            row["running"] = False
        private_write(prefix / "status.json", json.dumps(snapshot, indent=2) + "\n")
        lock.close()
    return 0


def start(prefix: Path, app_dir: Path, nginx: Path, endpoint: str, model: str) -> None:
    validate_endpoint(endpoint)
    if not (app_dir / "server.py").is_file() or not nginx.is_file() or not os.access(nginx, os.X_OK):
        raise DeployError("Provide an existing app directory and executable Nginx binary/wrapper")
    prefix.mkdir(parents=True, exist_ok=True, mode=0o700)
    if status(prefix)["running"]:
        raise DeployError("Session already running; stop it before changing configuration")
    for name in ("client-body", "proxy-temp"):
        (prefix / name).mkdir(exist_ok=True, mode=0o700)
    private_write(prefix / "nginx.conf", make_config(prefix))
    checked = subprocess.run([str(nginx), "-t", "-p", str(prefix) + "/", "-c", str(prefix / "nginx.conf")],
                             text=True, capture_output=True)
    if checked.returncode:
        raise DeployError("Nginx configuration validation failed: " + checked.stderr.strip())
    environment = dict(os.environ, GPU_DECISIONS_URL=endpoint, GPU_MODEL_ID=model,
                       GPU_MODEL_LABEL="Akamai GPU · Clef FP8", PYTHONDONTWRITEBYTECODE="1", PYTHONUNBUFFERED="1")
    command = [sys.executable, str(Path(__file__).resolve()), "_supervise", "--prefix", str(prefix),
               "--app-dir", str(app_dir), "--nginx", str(nginx)]
    with os.fdopen(os.open(prefix / "supervisor.log", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600), "a") as log:
        child = subprocess.Popen(command, cwd=app_dir, stdin=subprocess.DEVNULL, stdout=log,
                                 stderr=subprocess.STDOUT, env=environment, start_new_session=True, close_fds=True)
    for _ in range(30):
        if child.poll() is not None:
            raise DeployError("Supervisor exited during startup; inspect its private log")
        state = status(prefix)
        if (state["running"] and state.get("supervisorPid") == child.pid
                and len(state.get("children", {})) == 2
                and all(row["running"] for row in state["children"].values())):
            print(json.dumps(state, indent=2))
            return
        time.sleep(0.1)
    raise DeployError("Supervisor startup was not confirmed; inspect status and logs before retrying")


def stop(prefix: Path) -> None:
    state = status(prefix)
    if not state["running"]:
        print("Session is already stopped.")
        return
    pid = state.get("supervisorPid")
    if not isinstance(pid, int) or not process_is_supervisor(pid, prefix):
        raise DeployError("Cannot verify supervisor identity; refusing to signal an unrelated process")
    os.kill(pid, signal.SIGTERM)
    for _ in range(80):
        if not status(prefix)["running"]:
            print("Session stopped; the existing notebook server is unchanged.")
            return
        time.sleep(0.1)
    raise DeployError("Supervisor has not exited; inspect its private log")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("start", "stop", "status", "_supervise"):
        command = commands.add_parser(name)
        command.add_argument("--prefix", required=True, type=Path, help="Private runtime directory")
        if name in {"start", "_supervise"}:
            command.add_argument("--app-dir", type=Path, default=APP_ROOT)
            command.add_argument("--nginx", required=True, type=Path, help="Nginx executable or wrapper that forwards its arguments")
        if name == "start":
            command.add_argument("--gpu-endpoint", default=os.environ.get("GPU_DECISIONS_URL", ""))
            command.add_argument("--gpu-model", default="Cloudflare/clef-flash")
    args = parser.parse_args(argv)
    try:
        prefix = args.prefix.resolve()
        if args.command == "status":
            print(json.dumps(status(prefix), indent=2))
        elif args.command == "stop":
            stop(prefix)
        elif args.command == "start":
            start(prefix, args.app_dir.resolve(), args.nginx.resolve(), args.gpu_endpoint, args.gpu_model)
        else:
            return supervise(prefix, args.app_dir.resolve(), args.nginx.resolve())
    except (DeployError, OSError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
