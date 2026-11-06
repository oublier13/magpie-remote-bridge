#!/usr/bin/env python3
"""Local fake official Codex JSONL RPC process; never performs network operations."""
import hashlib
import json
import os
import signal
import sys
import time

if "--version" in sys.argv:
    print("codex-cli 0.164.0-alpha.11.1")
    sys.exit(0)

home = os.environ["CODEX_HOME"]
path = os.path.realpath(os.path.join(home, "config.toml"))
mode = os.environ.get("MAGPIE_CODEX_FIXTURE_MODE", "")


def load():
    try:
        with open(path, encoding="utf-8") as handle:
            source = handle.read()
    except FileNotFoundError:
        return {}
    if source.lstrip().startswith("{"):
        return json.loads(source)
    config, section = {}, []
    for line in source.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("["):
            section = line[1:-1].split(".")
            continue
        key, value = line.split("=", 1)
        target = config
        for part in section:
            target = target.setdefault(part, {})
        target[key.strip()] = json.loads(value.strip())
    return config


def version(config):
    return "sha256:" + hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()


def emit(value):
    print(json.dumps(value), flush=True)


config = load()
provider = config.get("model_providers", {}).get("magpie_vscode_bridge", {})
auth = provider.get("auth", {})
if auth.get("magpie_unknown_auth_probe") and mode != "ignore-strict":
    sys.stderr.write("unknown configuration field `model_providers.magpie_vscode_bridge.auth.magpie_unknown_auth_probe`\n")
    sys.exit(1)
if auth and mode == "unsupported-auth":
    sys.stderr.write("unknown configuration field `model_providers.magpie_vscode_bridge.auth`\n")
    sys.exit(1)

if mode == "hang":
    while True:
        signal.pause()
if mode == "ignore-term":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    emit({"method": "fixture/ready"})
    while True:
        signal.pause()
if mode == "flood":
    sys.stdout.write("x" * (3 * 1024 * 1024))
    sys.stdout.flush()
    sys.exit(0)

for line in sys.stdin:
    message = json.loads(line)
    if "id" not in message:
        continue
    method, request_id = message["method"], message["id"]
    if method == "initialize":
        if message["params"] != {"clientInfo": {"name": "magpie_remote_bridge", "version": "0.3.0"}, "capabilities": {"experimentalApi": True}}:
            sys.exit(3)
        emit({"id": request_id, "result": {"codexHome": home}})
    elif method == "config/read":
        config = load()
        result = {"config": config, "layers": [{"name": {"type": "user", "file": path, "profile": None},
                  "version": version(config), "config": config}]}
        emit({"id": request_id, "result": result})
    elif method == "config/batchWrite":
        params = message["params"]
        config = load()
        if mode in ("write-error", "write-conflict") or params["expectedVersion"] != version(config):
            emit({"id": request_id, "error": {"code": -32000, "message": "SECRET raw user config and credential must never escape"}})
            continue
        if params["filePath"] != path:
            sys.exit(4)
        # Confirm that recovery intent is already durable when the write arrives.
        state_path = os.path.join(home, ".magpie-remote-bridge.json")
        with open(state_path, encoding="utf-8") as handle:
            state = json.load(handle)
        if state["phase"] != "applied":
            sys.exit(5)
        for edit in params["edits"]:
            if edit["mergeStrategy"] != "replace":
                sys.exit(6)
            parts = edit["keyPath"].split(".")
            target = config
            for part in parts[:-1]:
                target = target.setdefault(part, {})
            if edit["value"] is None:
                target.pop(parts[-1], None)
            else:
                target[parts[-1]] = edit["value"]
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(config, handle)
        emit({"id": request_id, "result": {"status": "ok", "version": version(config), "filePath": path}})
    else:
        sys.exit(7)
