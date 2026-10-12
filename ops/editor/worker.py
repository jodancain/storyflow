"""Single-process durable Claude Code editor queue. Python stdlib, no app DB."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from sandbox import scoped

MODEL = "ezr/claude-opus-5-5"
DEFAULT_PROFILE = "9router-native"
PROFILES = {
    "9router-native": {"base": "https://router.yundongyl.cn", "model": MODEL,
                       "acceptedReportedModels": (MODEL, "claude-opus-5-5")},
    "ezr-direct": {"base": "https://ezr.sh", "model": "claude-opus-5-5",
                   "acceptedReportedModels": ("claude-opus-5-5",)},
}
VERSION = "2.1.258"
SHA = re.compile(r"^[a-f0-9]{64}$")
IN_FLIGHT = {"submitting", "running"}
TOOLS = ["mcp__editor__" + n for n in ("read_file", "read_image", "write_file", "list_files", "run")]

def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()

def sha_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1024 * 1024), b""): h.update(b)
    return h.hexdigest()

def save(path, data):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=".atomic-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(canonical(data) + b"\n"); f.flush(); os.fsync(f.fileno())
        os.replace(temp, path)
        d = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(d)
        finally: os.close(d)
    finally:
        if os.path.exists(temp): os.unlink(temp)

def read(path):
    return json.loads(Path(path).read_text())

@contextmanager
def lock(path, blocking=True):
    Path(path).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        yield
    finally:
        os.close(fd)

def redact(text, secrets=()):
    for secret in secrets:
        if secret: text = text.replace(secret, "[REDACTED]")
    text = re.sub(r"(?i)(bearer\s+|(?:api[_-]?key|authorization|token|secret)\s*[\"']?\s*[:=]\s*[\"']?)[^\s\"',}]+", r"\1[REDACTED]", text)
    return re.sub(r"(?:sk-[A-Za-z0-9_-]{12,}|fal_sk_[A-Za-z0-9_:-]{12,})", "[REDACTED]", text)

def normalize(job):
    required = {"schema", "idempotencyKey", "prompt", "inputs", "outputs"}
    optional = {"maxTurns", "timeoutSeconds", "maxBudgetUsd"}
    if not isinstance(job, dict) or not required <= job.keys() or job.keys() - required - optional:
        raise ValueError("invalid job fields")
    if job["schema"] != 1 or not isinstance(job["idempotencyKey"], str) or not 1 <= len(job["idempotencyKey"]) <= 200:
        raise ValueError("invalid schema/key")
    if not isinstance(job["prompt"], str) or not 1 <= len(job["prompt"].encode()) <= 128 * 1024:
        raise ValueError("invalid prompt")
    if not isinstance(job["inputs"], list) or len(job["inputs"]) > 500 or not isinstance(job["outputs"], list) or not 1 <= len(job["outputs"]) <= 100:
        raise ValueError("invalid file lists")
    for kind in ("inputs", "outputs"):
        seen = set()
        for item in job[kind]:
            allowed = {"path", "sha256"} if kind == "inputs" else {"path", "sha256", "minBytes", "media"}
            if not isinstance(item, dict) or "path" not in item or item.keys() - allowed: raise ValueError("invalid file entry")
            # Validate lexical form without relying on the host's root contents.
            p = item["path"]
            if not isinstance(p, str) or not p or p.startswith("/") or "\x00" in p or any(x in ("", ".", "..") for x in p.split("/")):
                raise ValueError("unsafe file path")
            if p in seen: raise ValueError("duplicate file path")
            seen.add(p)
            if kind == "inputs" or "sha256" in item:
                if not isinstance(item.get("sha256"), str) or not SHA.fullmatch(item["sha256"]): raise ValueError("invalid sha256")
            if kind == "outputs":
                if type(item.get("minBytes", 1)) is not int or item.get("minBytes", 1) < 1: raise ValueError("invalid minBytes")
                if "media" in item:
                    m = item["media"]
                    if not isinstance(m, dict) or m.keys() - {"kind", "durationSeconds", "toleranceSeconds", "sampleRate", "channels", "width", "height", "frames", "fps", "audioRequired"}:
                        raise ValueError("invalid media specification")
                    if m.get("kind") not in ("audio", "video"): raise ValueError("invalid media kind")
                    for k,v in m.items():
                        if k == "audioRequired":
                            if type(v) is not bool: raise ValueError("invalid audioRequired")
                            continue
                        if k == "kind": continue
                        if type(v) not in (int, float) or not 0 < v <= 100000000: raise ValueError("invalid media constraint")
    n = dict(job)
    n.setdefault("maxTurns", 30); n.setdefault("timeoutSeconds", 3600)
    if type(n["maxTurns"]) is not int or not 1 <= n["maxTurns"] <= 80: raise ValueError("invalid maxTurns")
    if type(n["timeoutSeconds"]) is not int or not 30 <= n["timeoutSeconds"] <= 7200: raise ValueError("invalid timeout")
    if "maxBudgetUsd" in n and (type(n["maxBudgetUsd"]) not in (int,float) or not 0 < n["maxBudgetUsd"] <= 1000): raise ValueError("invalid budget")
    return n

def descendants(parent):
    """Read process IDs/parents only, never process environment or command arguments."""
    if not sys.platform.startswith("linux"): return set()
    parents = {}
    for p in Path("/proc").iterdir():
        if not p.name.isdecimal(): continue
        try:
            tail = (p / "stat").read_text().rsplit(")", 1)[1].split()
            parents[int(p.name)] = int(tail[1])
        except (OSError, ValueError, IndexError): continue
    owned = {parent}; changed = True
    while changed:
        children = {pid for pid, ppid in parents.items() if ppid in owned}
        changed = not children <= owned; owned.update(children)
    return owned - {parent}


def enable_subreaper():
    if sys.platform.startswith("linux"):
        import ctypes
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
            raise RuntimeError("child cleanup boundary unavailable")


def cleanup_descendants(baseline):
    if not sys.platform.startswith("linux"): return
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        remaining = descendants(os.getpid()) - baseline
        if not remaining: return
        for pid in remaining:
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass
        for pid in remaining:
            try: os.waitpid(pid, os.WNOHANG)
            except (ChildProcessError, ProcessLookupError): pass
        time.sleep(.02)
    raise RuntimeError("editor descendants did not terminate")

class Worker:
    def __init__(self, state, work, sessions, inputs, env=None):
        self.state, self.work, self.sessions, self.inputs = map(lambda p: Path(p).resolve(), (state, work, sessions, inputs))
        self.env = dict(os.environ if env is None else env)
        self.recovered = set()
        for p in (self.state, self.work, self.sessions): p.mkdir(parents=True, exist_ok=True, mode=0o700)

    def directory(self, job_id):
        if not SHA.fullmatch(job_id): raise ValueError("invalid job id")
        return self.state / "jobs" / job_id

    def load(self, job_id):
        d = self.directory(job_id); spec = read(d / "job.json")
        if hashlib.sha256(canonical(spec)).hexdigest() != job_id: raise ValueError("job snapshot changed")
        return d, spec, read(d / "state.json")

    def key_index(self, spec):
        return self.state / "keys" / (hashlib.sha256(spec["idempotencyKey"].encode()).hexdigest() + ".json")

    def submit(self, job):
        spec = normalize(job); job_id = hashlib.sha256(canonical(spec)).hexdigest()
        with lock(self.state / "queue.lock"):
            index = self.key_index(spec)
            if index.exists() and read(index)["jobId"] != job_id: raise ValueError("idempotency key conflict")
            # Reserve the key durably BEFORE a runnable job can exist. A crash can
            # leave a reservation, never two queued jobs for one key. Same body heals it.
            if not index.exists(): save(index, {"jobId": job_id})
            d = self.directory(job_id)
            if not (d / "job.json").exists(): save(d / "job.json", spec)
            elif read(d / "job.json") != spec: raise ValueError("job snapshot changed")
            if not (d / "state.json").exists():
                save(d / "state.json", {"jobId": job_id, "status": "queued", "attempts": 0, "sessionId": str(uuid.uuid4()), "createdAt": time.time()})
        return read(d / "state.json")

    def stage(self, job_id, spec):
        base = self.work / job_id
        work, inputs = base / "workspace", base / "inputs"
        work.mkdir(parents=True, exist_ok=True, mode=0o700); inputs.mkdir(parents=True, exist_ok=True, mode=0o700)
        for item in spec["inputs"]:
            source = scoped(self.inputs, item["path"], True)
            if not source.is_file() or sha_file(source) != item["sha256"]: raise ValueError("input hash mismatch")
            dest = scoped(inputs, item["path"])
            if dest.exists():
                if sha_file(dest) != item["sha256"]: raise ValueError("staged input changed")
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, dest)
            if sha_file(dest) != item["sha256"]: raise ValueError("input changed during copy")
            os.chmod(dest, 0o400)
        return work, inputs

    def profile(self):
        name = self.env.get("EDITOR_ROUTE_PROFILE", DEFAULT_PROFILE)
        if name not in PROFILES: raise ValueError("unknown provider profile")
        profile = dict(PROFILES[name], name=name)
        base = self.env.get("ANTHROPIC_BASE_URL", profile["base"]).rstrip("/")
        if base != profile["base"]: raise ValueError("profile API origin/path mismatch")
        if self.env.get("EDITOR_MODEL", profile["model"]) != profile["model"]: raise ValueError("profile model drift")
        return profile

    def credentials(self):
        profile = self.profile()
        path = self.env.get("EDITOR_API_KEY_FILE", "/run/secrets/anthropic_api_key")
        key = Path(path).read_text().strip()
        if not key or len(key) > 4096 or any(c.isspace() for c in key): raise ValueError("invalid secret")
        return profile["base"], key

    def command(self, spec, state, work, inputs, session_dir, base, key):
        profile = self.profile(); model = profile["model"]
        if base != profile["base"]: raise ValueError("profile command base drift")
        mcp = {"mcpServers": {"editor": {"command": "/usr/bin/python3", "args": ["/opt/editor/mcp_server.py"], "env": {"EDITOR_TASK_WORK": str(work), "EDITOR_TASK_INPUT": str(inputs)}}}}
        cmd = ["claude", "--print", "--output-format", "stream-json", "--verbose", "--model", model,
               "--tools", "", "--allowedTools", ",".join(TOOLS), "--permission-mode", "dontAsk",
               "--strict-mcp-config", "--mcp-config", json.dumps(mcp), "--setting-sources", "", "--disable-slash-commands",
               "--max-turns", str(spec["maxTurns"]), "--settings", '{"autoUpdatesChannel":"stable","disableAllHooks":true}']
        if "maxBudgetUsd" in spec: cmd += ["--max-budget-usd", str(spec["maxBudgetUsd"])]
        cmd += ["--resume" if state.get("resume") else "--session-id", state["sessionId"]]
        # Whitelist environment; never inherit other providers, OAuth, proxy, or app config.
        env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": str(session_dir), "CLAUDE_CONFIG_DIR": str(session_dir),
               "ANTHROPIC_API_KEY": key, "ANTHROPIC_BASE_URL": base, "ANTHROPIC_MODEL": model,
               "ANTHROPIC_DEFAULT_OPUS_MODEL": model, "ANTHROPIC_DEFAULT_SONNET_MODEL": model, "ANTHROPIC_DEFAULT_HAIKU_MODEL": model,
               "DISABLE_AUTOUPDATER": "1", "DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1",
               "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY": "1",
               "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS": "1",
               "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK": "1", "CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK": "1",
               "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL": "1", "ENABLE_TOOL_SEARCH": "false",
               "CLAUDE_CODE_MAX_RETRIES": "0", "ANTHROPIC_MAX_RETRIES": "0", "API_MAX_RETRIES": "0",
               "OMP_NUM_THREADS": "2", "OPENBLAS_NUM_THREADS": "2"}
        return cmd, env

    def capture(self, cmd, env, prompt, work, log_path, timeout, on_event):
        enable_subreaper(); baseline = descendants(os.getpid())
        fd = os.open(log_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        # Prompt uses a file descriptor, not argv or console output.
        with os.fdopen(fd, "w") as log, tempfile.TemporaryFile() as inp:
            inp.write(prompt.encode()); inp.seek(0)
            proc = subprocess.Popen(cmd, cwd=work, env=env, stdin=inp, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
            sel = selectors.DefaultSelector(); sel.register(proc.stdout, selectors.EVENT_READ)
            pending = b""; total = 0; deadline = time.monotonic() + timeout
            try:
                while sel.get_map():
                    if time.monotonic() > deadline: raise TimeoutError("cli_timeout")
                    for key, _ in sel.select(timeout=0.2):
                        chunk = os.read(key.fileobj.fileno(), 65536)
                        if not chunk:
                            sel.unregister(key.fileobj); break
                        total += len(chunk); pending += chunk
                        if total > 100 * 1024 * 1024 or len(pending) > 16 * 1024 * 1024: raise ValueError("stream_limit")
                        while b"\n" in pending:
                            line, pending = pending.split(b"\n", 1)
                            cleaned = redact(line.decode("utf-8", "replace"), (env["ANTHROPIC_API_KEY"],))
                            log.write(cleaned + "\n"); log.flush()
                            try: event = json.loads(cleaned)
                            except ValueError: continue
                            if isinstance(event, dict): on_event(event)
                if pending:
                    cleaned = redact(pending.decode("utf-8", "replace"), (env["ANTHROPIC_API_KEY"],))
                    log.write(cleaned + "\n")
                    try: event = json.loads(cleaned)
                    except ValueError: event = None
                    if isinstance(event, dict): on_event(event)
                code = proc.wait(timeout=max(1, deadline-time.monotonic()))
                log.flush(); os.fsync(log.fileno())
                return code
            finally:
                try: os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                proc.wait()
                cleanup_descendants(baseline)
                proc.stdout.close(); sel.close()

    def outputs(self, spec, work, before=None):
        manifest = []
        for item in spec["outputs"]:
            p = scoped(work, item["path"], True)
            if not p.is_file() or p.stat().st_size < item.get("minBytes", 1): raise ValueError("missing/empty output")
            sha = sha_file(p)
            if item.get("sha256", sha) != sha: raise ValueError("output hash mismatch")
            entry = {"path": item["path"], "sha256": sha, "bytes": p.stat().st_size}
            if "media" in item:
                # Validation is also sandboxed: an output playlist cannot make FFprobe
                # read a secret or fetch a network URL under the supervisor's credentials.
                from sandbox import Sandbox
                box = Sandbox(work, work.parent / "inputs")
                result = box.execute("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", str(p)])
                if result["exitCode"] != 0 or result.get("truncated"): raise ValueError("media probe failed")
                data = json.loads(result["output"]); m = item["media"]
                streams = data.get("streams", []); candidates = [s for s in streams if s.get("codec_type") == m["kind"]]
                if not candidates: raise ValueError("missing media stream")
                stream = candidates[0]
                duration = float(stream.get("duration", data.get("format", {}).get("duration", -1)))
                if "durationSeconds" in m and abs(duration - m["durationSeconds"]) > m.get("toleranceSeconds", .04): raise ValueError("duration mismatch")
                for key, field in (("width","width"),("height","height"),("sampleRate","sample_rate"),("channels","channels"),("frames","nb_read_frames")):
                    if key in m and int(stream.get(field, -1)) != m[key]: raise ValueError("media property mismatch")
                if "fps" in m:
                    num, den = stream.get("avg_frame_rate", "0/1").split("/")
                    if not float(den) or abs(float(num)/float(den)-m["fps"]) > 0.00001: raise ValueError("fps mismatch")
                if m.get("audioRequired") and not any(s.get("codec_type") == "audio" for s in streams): raise ValueError("audio missing")
                decoded = box.execute("ffmpeg", ["-v", "error", "-xerror", "-i", str(p), "-f", "null", "-"])
                if decoded["exitCode"] != 0: raise ValueError("full decode failed")
                entry["media"] = {"durationSeconds": duration, "fullDecodePassed": True}
            manifest.append(entry)
        return manifest

    def recover(self):
        """Call only while holding worker.lock; never re-submit an interrupted CLI."""
        for d in sorted((self.state / "jobs").glob("*")):
            if not (d / "state.json").exists(): continue
            _, spec, state = self.load(d.name)
            if state["status"] in IN_FLIGHT or state["status"] == "completed":
                if state["status"] == "completed" and d.name in self.recovered: continue
                receipt = d / "attempts" / f'{state["attempts"]:03d}' / "outputs.json"
                try:
                    records = read(receipt)
                    current = self.outputs(spec, self.work / d.name / "workspace")
                    if records != current: raise ValueError("output drift")
                    state["status"] = "completed"
                except Exception:
                    state["status"] = "artifact_invalid" if state["status"] == "completed" else "needs_reconcile"
                    state["reason"] = "artifact_integrity_or_interrupted_submission"
                save(d / "state.json", state)
                self.recovered.add(d.name)

    def preflight(self):
        version = subprocess.run(["claude", "--version"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20, check=True).stdout.decode()
        if VERSION not in version: raise ValueError("CLI version mismatch")
        # Tests and container smoke are local-only. No model requests here.
        from sandbox_smoke import check
        check()

    def run_one(self, job_id):
        d, spec, state = self.load(job_id)
        if state["status"] not in ("queued", "waiting_configuration"): return state
        index = self.key_index(spec)
        if not index.exists() or read(index).get("jobId") != job_id:
            state.update(status="needs_reconcile", reason="missing_or_conflicting_idempotency_reservation")
            save(d / "state.json", state); return state
        orphan_attempts = [int(p.name) for p in (d / "attempts").glob("*") if p.is_dir() and p.name.isdecimal() and int(p.name) > state["attempts"]]
        if orphan_attempts:
            state.update(status="needs_reconcile", reason="orphan_attempt_requires_reconciliation", attempts=max(orphan_attempts))
            save(d / "state.json", state); return state

        try:
            base, key = self.credentials(); profile = self.profile(); self.preflight()
        except Exception:
            state.update(status="waiting_configuration", reason="credential_version_or_sandbox_unavailable")
            save(d / "state.json", state); return state
        try:
            work, inputs = self.stage(job_id, spec)
            before = {i["path"]: sha_file(scoped(work,i["path"],True)) for i in spec["outputs"] if scoped(work,i["path"]).is_file()}
        except Exception:
            state.update(status="invalid_input", reason="input_snapshot_or_workspace_invalid")
            save(d / "state.json", state); return state
        session = self.sessions / job_id; session.mkdir(exist_ok=True, mode=0o700)
        cmd, env = self.command(spec, state, work, inputs, session, base, key)
        attempt = state["attempts"] + 1; attempt_dir = d / "attempts" / f"{attempt:03d}"
        intent = {"attempt": attempt, "jobId": job_id, "sessionId": state["sessionId"], "requestedModel": profile["model"], "cliVersion": VERSION, "apiBase": base,
                  "providerProfile": profile["name"], "messagesEndpoint": base + "/v1/messages",
                  "submittedAt": time.time(), "resume": state.get("resume"), "outputHashesBefore": before}
        # State moves out of queued BEFORE spawning. Any crash after this is ambiguous.
        state.update(status="submitting", attempts=attempt)
        save(d / "state.json", state)
        attempt_dir.mkdir(parents=True, exist_ok=False, mode=0o700)
        save(attempt_dir / "intent.json", intent)
        result = None; observed = set(); reported = set(); after_result = False; replay_count = 0
        # Resuming a CLI session may replay old messages. Keep their raw logs, but
        # never let a previous synthetic reply/tool result prove this attempt ran.
        def identities(event):
            ids = {"event:" + hashlib.sha256(canonical(event)).hexdigest()}
            if isinstance(event.get("uuid"), str): ids.add("uuid:" + event["uuid"])
            message = event.get("message")
            if isinstance(message, dict) and isinstance(message.get("id"), str): ids.add("message:" + message["id"])
            return ids
        prior_event_ids = set()
        for old in sorted((d / "attempts").glob("*/stream.ndjson")):
            if old.parent == attempt_dir: continue
            with old.open() as history:
                for line in history:
                    try: previous = json.loads(line)
                    except ValueError: continue
                    if isinstance(previous, dict): prior_event_ids.update(identities(previous))
        tool_uses = {}; tool_results = set(); successful_tools = set(); successful_runs = set(); successful_scripts = set()
        def evidence():
            return {"providerProfile": profile["name"], "apiBase": base, "requestedModel": profile["model"],
                    "reportedModels": sorted(reported), "observedModels": sorted(observed), "modelReported": bool(observed),
                    "modelIdentityEvidence": "gateway_report_only_not_independent_upstream_identity", "ignoredReplayEventCount": replay_count,
                    "toolUseCount": len(tool_uses),
                    "toolResultCount": len(tool_results), "successfulToolCount": len(successful_tools),
                    "successfulRunCount": len(successful_runs), "successfulScriptRunCount": len(successful_scripts)}
        def event(e):
            nonlocal result, after_result, replay_count
            if e.get("isReplay") is True or e.get("is_replay") is True or identities(e) & prior_event_ids:
                replay_count += 1; save(attempt_dir / "tool-evidence.json", evidence()); return
            if result is not None: after_result = True
            if e.get("type") == "result":
                result = e
                save(attempt_dir / "cli-result.json", e)
            actual = e.get("message", {}).get("model") if isinstance(e.get("message"), dict) else None
            if isinstance(actual, str):
                reported.add(actual)
                if actual not in ("<synthetic>", "synthetic"): observed.add(actual)
            content = e.get("message", {}).get("content", []) if isinstance(e.get("message"), dict) else []
            for block in content if isinstance(content, list) else []:
                if not isinstance(block, dict): continue
                if block.get("type") == "tool_use" and isinstance(block.get("id"), str):
                    tool_uses[block["id"]] = {"name": block.get("name"), "input": block.get("input", {})}
                elif block.get("type") == "tool_result" and block.get("tool_use_id") in tool_uses:
                    tid=block["tool_use_id"]; tool_results.add(tid)
                    if block.get("is_error"): continue
                    successful_tools.add(tid)
                    use=tool_uses[tid]
                    if use["name"] != "mcp__editor__run": continue
                    parts=block.get("content", [])
                    texts=[parts] if isinstance(parts,str) else [p.get("text", "") for p in parts if isinstance(p,dict)] if isinstance(parts,list) else []
                    for text in texts:
                        try: payload=json.loads(text)
                        except (ValueError, TypeError): continue
                        if isinstance(payload,dict) and type(payload.get("exitCode")) is int and payload["exitCode"] == 0 and not payload.get("error"):
                            successful_runs.add(tid)
                            if use["input"].get("program") in ("python","node"): successful_scripts.add(tid)
            save(attempt_dir / "tool-evidence.json", evidence())
        prompt = ("You are the StoryFlow private offline editor. Use only the supplied editor MCP tools. "
                  "Inputs are immutable; work only in this task workspace. Never call a model/provider, network service, install packages, or claim outputs exist without checking files. "
                  "Write and run Python/Node programs or FFmpeg as needed. Python is 3.11; wave/audioop, subprocess and the standard library are available. "
                  "Do not truncate spoken words or silently change approved speech. Report gaps instead. "
                  "Return every declared output file. Tools run offline in Landlock/seccomp; no credential or session access.\n" +
                  json.dumps({"inputDirectory": str(inputs), "workDirectory": str(work), "outputs": spec["outputs"]}, ensure_ascii=False) + "\n" +
                  (state["resume"]["prompt"] if state.get("resume") else spec["prompt"]))
        try:
            state["status"] = "running"; save(d / "state.json", state)
            code = self.capture(cmd, env, prompt, work, attempt_dir / "stream.ndjson", spec["timeoutSeconds"], event)
            if code != 0 or not result or result.get("is_error") or result.get("subtype") != "success" or after_result:
                state.update(status="needs_reconcile", reason="CLI_did_not_finish_with_single_success")
            elif not observed or any(m not in profile["acceptedReportedModels"] for m in observed):
                state.update(status="needs_reconcile", reason="missing_or_unexpected_response_model")
            elif not successful_runs:
                state.update(status="failed_validation", reason="no_successful_actual_editor_execution")
            else:
                try:
                    for item in spec["inputs"]:
                        if sha_file(scoped(inputs, item["path"], True)) != item["sha256"]: raise ValueError("staged input modified")
                    manifest = self.outputs(spec, work, before)
                    save(attempt_dir / "outputs.json", manifest)
                    state.update(status="completed", reason=None, outputs=manifest)
                except Exception:
                    state.update(status="failed_validation", reason="required_output_missing_changed_or_invalid")
        except Exception:
            state.update(status="needs_reconcile", reason="interrupted_or_unknown_model_submission")
        state["observedModels"] = sorted(observed); state["reportedModels"] = sorted(reported); state["executionEvidence"] = evidence(); state["finishedAt"] = time.time()
        if state["status"] == "completed": self.recovered.add(job_id)
        save(d / "state.json", state)
        return state

    def tick(self):
        with lock(self.state / "worker.lock", False):
            self.recover()
            # Waiting configuration does not consume an attempt; check one job per tick.
            candidates = []
            for d in (self.state / "jobs").glob("*"):
                if (d / "state.json").exists():
                    s = read(d / "state.json")
                    if s["status"] in ("queued", "waiting_configuration"): candidates.append(s)
            if candidates: return self.run_one(min(candidates, key=lambda s:s["createdAt"])["jobId"])
        return None

    def resume(self, job_id, session_id, prompt, authorization_ref):
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt.encode()) > 128*1024 or not authorization_ref.strip():
            raise ValueError("explicit resume prompt and authorization reference required")
        with lock(self.state / "worker.lock", False):
            self.recover()
            d, _, state = self.load(job_id)
            if state["status"] not in ("needs_reconcile", "failed_validation", "artifact_invalid") or session_id != state["sessionId"]:
                raise ValueError("resume state/session mismatch")
            # No replacement session or silent clean retry. CLI itself must find this session.
            state.update(status="queued", resume={"sessionId": session_id, "prompt": prompt, "authorizationRef": authorization_ref, "authorizedAt": time.time()})
            save(d / "state.json", state)
            return state

def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    submit = sub.add_parser("submit"); submit.add_argument("file")
    status = sub.add_parser("status"); status.add_argument("job_id")
    sub.add_parser("once"); sub.add_parser("serve")
    resume = sub.add_parser("resume"); resume.add_argument("job_id"); resume.add_argument("--session-id", required=True); resume.add_argument("--prompt-file", required=True); resume.add_argument("--authorization-ref", required=True)
    args = parser.parse_args()
    w = Worker(os.environ.get("EDITOR_STATE_DIR", "/state"), os.environ.get("EDITOR_WORK_DIR", "/work"), os.environ.get("EDITOR_SESSION_DIR", "/sessions"), os.environ.get("EDITOR_INPUT_DIR", "/input"))
    try:
        if args.command == "submit": result = w.submit(read(args.file))
        elif args.command == "status": result = w.load(args.job_id)[2]
        elif args.command == "resume": result = w.resume(args.job_id, args.session_id, Path(args.prompt_file).read_text(), args.authorization_ref)
        elif args.command == "once": result = w.tick()
        else:
            while True:
                try: w.tick()
                except BlockingIOError: pass
                except Exception: print('{"worker":"state_error_requires_operator"}', flush=True)
                time.sleep(5)
        if result: print(json.dumps({k:result.get(k) for k in ("jobId","status","attempts","sessionId","reason")}, ensure_ascii=False))
    except Exception:
        print('{"error":"editor_operation_rejected; inspect private state"}', file=sys.stderr); return 1
    return 0

if __name__ == "__main__": raise SystemExit(main())
