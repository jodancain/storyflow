#!/usr/bin/env python3
"""Isolated Docker acceptance. Synthetic inputs only; never opens production env.

Run on a Linux Docker host with prebuilt candidate images. Creates only a unique
storyflow-qa-* namespace, uses loopback HTTP, and cleans only its labelled objects.
No model credentials, provider submissions, DNS changes, or deployment.
"""
import argparse
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import re
import statistics
import subprocess
import time
import urllib.error
import urllib.request


def digest(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise AssertionError(message)


class Acceptance:
    def __init__(self, args):
        self.args = args
        self.name = args.name
        require(re.fullmatch(r"storyflow-qa-[a-z0-9-]{4,48}", self.name), "Dedicated QA namespace required")
        require(args.port != args.restore_port and all(1024 < p < 65536 for p in [args.port, args.restore_port]), "Two unprivileged ports required")
        require(args.soak_seconds >= 600, "Production soak must run at least 600 seconds")
        self.root = Path(args.evidence).resolve()
        self.root.mkdir(parents=True, exist_ok=False)
        self.label = f"storyflow.qa.run={self.name}"
        self.containers = []
        self.volumes = []
        self.report = {"schema": 1, "namespace": self.name, "startedAt": time.time(), "status": "running",
                       "providerCalls": 0, "inputs": "synthetic", "stages": [], "cleanup": []}

    def save(self):
        target = self.root / "acceptance.json"
        target.write_text(json.dumps(self.report, ensure_ascii=False, indent=2) + "\n")
        target.chmod(0o600)

    def stage(self, name, **evidence):
        result = {"stage": name, "time": time.time(), **evidence}
        self.report["stages"].append(result)
        self.save()
        print(json.dumps(result, ensure_ascii=False), flush=True)

    def docker(self, *args, timeout=120, check=True):
        result = subprocess.run(["sudo", "-n", "docker", *args], text=True, capture_output=True, timeout=timeout)
        if check and result.returncode:
            raise RuntimeError(f"Docker {args[0]} failed: {result.stderr[-2000:]}")
        return result

    def production_snapshot(self):
        # Narrow read-only fields: never Config.Env, mounts, secrets, or logs.
        rows = []
        fmt = '{{json .Id}} {{json .State.StartedAt}} {{json .RestartCount}} {{json .State.Status}}'
        for name in self.args.protected_container:
            result = self.docker("container", "inspect", "--format", fmt, name, check=False)
            require(result.returncode == 0, f"Explicit protected container is missing or unreadable: {name}")
            rows.append({"name": name, "state": result.stdout.strip(), "found": result.returncode == 0})
        return rows

    def volume(self, suffix):
        name = f"{self.name}-{suffix}"
        require(self.docker("volume", "inspect", name, check=False).returncode != 0, "QA volume already exists")
        self.docker("volume", "create", "--label", self.label, name)
        self.volumes.append(name)
        return name

    def create_container(self, name, options, image, command=()):
        require(name.startswith(self.name + "-"), "Container outside QA namespace")
        require(self.docker("container", "inspect", name, check=False).returncode != 0, "QA container already exists")
        self.docker("create", "--name", name, "--label", self.label, *options, image, *command)
        self.containers.append(name)
        return name

    def remove_container(self, name):
        owner = self.docker("container", "inspect", "--format", '{{index .Config.Labels "storyflow.qa.run"}}', name, check=False)
        if owner.returncode:
            return
        require(owner.stdout.strip() == self.name, "Refuse to remove a container not owned by this QA run")
        self.docker("rm", "-f", name)

    def limited(self):
        return ["--cpus", "1", "--memory", "1g", "--memory-swap", "1g", "--pids-limit", "128",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777"]

    def start_app(self, name, volume, port):
        self.create_container(name, [*self.limited(), "-p", f"127.0.0.1:{port}:18296",
                                    "-v", f"{volume}:/data/storyflow",
                                    "-e", f"PUBLIC_BASE_URL=http://127.0.0.1:{port}"], self.args.app_image)
        self.docker("start", name)
        base = f"http://127.0.0.1:{port}"
        for _ in range(60):
            try:
                status, _, body = self.http(base, "/healthz")
                if status == 200 and json.loads(body)["ok"]:
                    return base
            except (OSError, ValueError, urllib.error.URLError):
                pass
            time.sleep(1)
        raise AssertionError("Candidate did not become healthy within 60 seconds")

    def http(self, base, path, method="GET", data=None, cookie=None, extra=None):
        require(base.startswith("http://127.0.0.1:"), "QA HTTP must remain loopback")
        headers = {"accept": "application/json"}
        if cookie:
            headers["cookie"] = cookie
        if isinstance(data, dict):
            data = json.dumps(data).encode()
            headers["content-type"] = "application/json"
        headers.update(extra or {})
        request = urllib.request.Request(base + path, data=data, method=method, headers=headers)
        try:
            response = urllib.request.urlopen(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read()

    def json_request(self, base, path, method="GET", data=None, cookie=None, expected=200):
        status, headers, body = self.http(base, path, method, data, cookie)
        require(status == expected, f"{method} {path} returned HTTP {status}; expected {expected}")
        return json.loads(body), headers

    def identity(self, base, cookie, project_id, file_id, file_bytes):
        project, _ = self.json_request(base, f"/api/projects/{project_id}", cookie=cookie)
        status, headers, body = self.http(base, f"/api/files/{file_id}?download=1", cookie=cookie)
        require(status == 200 and body == file_bytes, "Asset changed across container or backup recovery")
        matching = next(item for item in project["files"] if item["id"] == file_id)
        require(matching["sha256"] == digest(body), "Stored file hash mismatch")
        return {"projectId": project["id"], "revision": project["revision"], "name": project["name"],
                "fileId": file_id, "fileSha256": matching["sha256"], "fileBytes": len(body),
                "ontologyHash": digest(json.dumps(project["ontology"], sort_keys=True).encode()),
                "jobs": len(project["jobs"]), "artifacts": len(project["artifacts"])}

    def maintenance(self, name, data_volume, backup_volume, command, root=False):
        options = [*self.limited(), "--network", "none", "-v", f"{data_volume}:/data/storyflow",
                   "-v", f"{backup_volume}:/backup" + (":ro" if any("restore.ts" in arg for arg in command) else "")]
        if root:
            # Only this one-shot initializer touches ownership, and only on the
            # just-created labelled backup volume. App/editor keep ALL dropped.
            options += ["--user", "0:0", "--cap-add", "CHOWN"]
        self.create_container(name, options, self.args.app_image, command)
        result = self.docker("start", "-a", name, timeout=180, check=False)
        status = self.docker("container", "inspect", "--format", '{{.State.ExitCode}}', name).stdout.strip()
        require(result.returncode == 0 and status == "0", f"Maintenance failed: {result.stderr[-1000:]} {result.stdout[-2000:]}")
        self.remove_container(name)
        return result.stdout

    def sample_memory(self, container):
        code = """import glob,json
rows=[]
for path in glob.glob('/proc/[0-9]*/status'):
 try:
  fields=dict(line.split(':',1) for line in open(path) if ':' in line)
  if fields.get('Name','').strip()=='node': rows.append({'pid':int(fields['Pid']),'rssKiB':int(fields.get('VmRSS','0 kB').split()[0])})
 except (OSError,ValueError): pass
print(json.dumps(rows))
"""
        rows = json.loads(self.docker("exec", container, "python3", "-c", code).stdout)
        require(rows, "Node RSS samples unavailable")
        return {"elapsed": round(time.monotonic() - self.soak_start, 3), "nodeRssKiB": sum(row["rssKiB"] for row in rows)}

    def runtime_state(self, container):
        # A narrow query avoids ever reading Config.Env or another container's
        # logs. Capture real Docker state, not assumptions from HTTP responses.
        fmt = '{"id":{{json .Id}},"startedAt":{{json .State.StartedAt}},"running":{{json .State.Running}},"oomKilled":{{json .State.OOMKilled}},"restartCount":{{json .RestartCount}},"health":{{json .State.Health.Status}}}'
        state = json.loads(self.docker("container", "inspect", "--format", fmt, container).stdout)
        require(state["running"] and not state["oomKilled"] and state["restartCount"] == 0,
                "Candidate exited, OOM-killed, or restarted unexpectedly")
        return state

    def isolation_state(self, container):
        fmt = '{"user":{{json .Config.User}},"image":{{json .Image}},"memoryBytes":{{json .HostConfig.Memory}},"nanoCpus":{{json .HostConfig.NanoCpus}},"pidsLimit":{{json .HostConfig.PidsLimit}},"readOnlyRootfs":{{json .HostConfig.ReadonlyRootfs}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}},"portBindings":{{json .HostConfig.PortBindings}}}'
        state = json.loads(self.docker("container", "inspect", "--format", fmt, container).stdout)
        require(state["user"] == "node" and state["memoryBytes"] == 1024 ** 3 and state["nanoCpus"] == 10 ** 9,
                "Candidate user or resource isolation differs from the requested constraints")
        require(state["pidsLimit"] == 128 and state["readOnlyRootfs"] and "ALL" in state["capDrop"], "Candidate sandbox constraints missing")
        require("no-new-privileges:true" in state["securityOpt"], "Candidate privilege restriction missing")
        require(all(binding["HostIp"] == "127.0.0.1" for bindings in state["portBindings"].values() for binding in bindings),
                "Candidate unexpectedly exposes a non-loopback port")
        return state

    def soak(self, base, container, cookie, project_id, file_id, file_bytes):
        project, _ = self.json_request(base, f"/api/projects/{project_id}", cookie=cookie)
        self.soak_start = time.monotonic()
        calls, memories = [], []
        next_request, next_memory, next_progress = self.soak_start + 1.05, 0, 60
        while time.monotonic() - self.soak_start < self.args.soak_seconds:
            time.sleep(max(0, next_request - time.monotonic()))
            started = time.monotonic()
            index = len(calls)
            method, data, extra, expected = "GET", None, None, 200
            if index % 10 == 0:
                path, method = f"/api/projects/{project_id}", "PATCH"
                data = {"baseRevision": project["revision"], "name": f"Synthetic Docker soak {index:04d}"}
            elif index % 3 == 0:
                path, expected = f"/api/files/{file_id}", 206
                extra = {"range": "bytes=0-15"}
            elif index % 3 == 1:
                path = f"/api/projects/{project_id}"
            else:
                path = "/healthz"
            status, headers, body = self.http(base, path, method, data, cookie, extra)
            latency = (time.monotonic() - started) * 1000
            require(status == expected, f"Soak {method} {path} returned {status}")
            if method == "PATCH" or path == f"/api/projects/{project_id}":
                project = json.loads(body)
            if expected == 206:
                require(body == file_bytes[:16], "Range download bytes changed during soak")
                require(headers.get("content-range") == f"bytes 0-15/{len(file_bytes)}", "Incorrect Range header")
            calls.append({"elapsed": round(started - self.soak_start, 3), "method": method,
                          "resource": "project" if "/projects/" in path else "asset" if "/files/" in path else "health",
                          "status": status, "latencyMs": round(latency, 3)})
            next_request = started + 1.05  # strict < 1 request/second, even if one request is slow
            elapsed = time.monotonic() - self.soak_start
            if elapsed >= next_memory:
                memories.append(self.sample_memory(container))
                next_memory += 30
            if elapsed >= next_progress:
                print(json.dumps({"progress": "soak", "elapsedSeconds": round(elapsed), "requests": len(calls), "errors": 0}), flush=True)
                next_progress += 60
        self.report["soakCalls"] = calls
        self.report["memorySamples"] = memories
        latencies = sorted(row["latencyMs"] for row in calls)
        p95 = latencies[math.ceil(len(latencies) * .95) - 1]
        require(p95 < 1000 and max(latencies) < 5000, "Soak exceeded latency acceptance threshold")
        require(max(row["nodeRssKiB"] for row in memories) < 1024 * 1024, "RSS exceeded the 1 GiB cap")
        self.stage("soak", status="passed", elapsedSeconds=round(time.monotonic() - self.soak_start, 3),
                   requests=len(calls), errors=0, writes=sum(row["method"] == "PATCH" for row in calls),
                   p50Ms=statistics.median(latencies), p95Ms=p95, maxMs=max(latencies),
                   rssStartKiB=memories[0]["nodeRssKiB"], rssEndKiB=memories[-1]["nodeRssKiB"],
                   rssMaxKiB=max(row["nodeRssKiB"] for row in memories),
                   limitation="Ten-minute bounded soak is not long-term memory-leak or maximum-load proof")

    def run(self):
        protected_before = self.production_snapshot()
        self.report["protectedBefore"] = protected_before
        self.report["images"] = {"app": self.docker("image", "inspect", "--format", '{{.Id}}', self.args.app_image).stdout.strip(),
                                 "editor": self.docker("image", "inspect", "--format", '{{.Id}}', self.args.editor_image).stdout.strip()}
        main_volume, restored_volume, backup_volume = [self.volume(kind) for kind in ["data", "restored", "backup"]]
        app_name, restored_name = f"{self.name}-app", f"{self.name}-restored"
        base = self.start_app(app_name, main_volume, self.args.port)
        password = "synthetic-qa-only-password-2026"
        _, headers = self.json_request(base, "/api/auth/setup", "POST", {"password": password})
        cookie = headers["set-cookie"].split(";")[0]
        project, _ = self.json_request(base, "/api/projects", "POST", {"name": "Synthetic Docker recovery",
                    "requirements": {"topic": "Synthetic fixture", "audience": "QA", "duration": 4, "fps": 25,
                                     "aspect": "16:9", "doctorMode": "fictional", "style": "fixture", "sound": "none", "brief": "No model generation"}}, cookie, 201)
        # A valid tiny PNG is sufficient to test real upload/parse, hashing and byte serving.
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=")
        boundary = "storyflow-qa-synthetic-boundary"
        form = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"synthetic.png\"\r\nContent-Type: image/png\r\n\r\n".encode()
                + png + f"\r\n--{boundary}--\r\n".encode())
        status, _, body = self.http(base, f"/api/projects/{project['id']}/files", "POST", form, cookie,
                                    {"content-type": f"multipart/form-data; boundary={boundary}"})
        require(status == 201, f"Synthetic asset upload failed: {status}")
        file_id = json.loads(body)[0]["id"]
        before = self.identity(base, cookie, project["id"], file_id, png)
        require(before["jobs"] == 0, "Fixture unexpectedly enqueued a model job")
        self.stage("synthetic-project-upload", status="passed", identity=before)
        self.docker("kill", "--signal", "KILL", app_name)
        killed = json.loads(self.docker("container", "inspect", "--format", '{{json .State}}', app_name).stdout)
        require(killed["ExitCode"] == 137 and not killed["OOMKilled"], "Container was not stopped by deliberate SIGKILL")
        self.remove_container(app_name)
        base = self.start_app(app_name, main_volume, self.args.port)
        recovered = self.identity(base, cookie, project["id"], file_id, png)
        require(before == recovered, "Data or existing session did not survive container replacement")
        self.stage("container-sigkill-recreate", status="passed", exitCode=137, sameSession=True, identity=recovered)
        state_before = self.runtime_state(app_name)
        self.stage("candidate-runtime-isolation", status="passed", evidence=self.isolation_state(app_name), state=state_before)
        doctor = self.docker("exec", app_name, "npm", "--silent", "run", "doctor", "--", "--json", timeout=180)
        doctor_result = json.loads(doctor.stdout)
        require(doctor_result["ok"] and any(check["name"] == "Chromium rendering" and check["ok"] for check in doctor_result["checks"]),
                "Doctor did not verify real Chromium drawing")
        self.stage("runtime-doctor-chromium", status="passed", evidence=doctor_result)
        media = self.docker("exec", app_name, "node", "--import", "tsx", "scripts/qa/container-media.ts", timeout=900)
        self.stage("actual-compose-media", status="passed", evidence=json.loads(media.stdout))
        self.soak(base, app_name, cookie, project["id"], file_id, png)
        state_after = self.runtime_state(app_name)
        require(state_after["id"] == state_before["id"] and state_after["startedAt"] == state_before["startedAt"] and state_after["health"] == "healthy",
                "Candidate identity changed or healthcheck failed during bounded runtime acceptance")
        self.stage("candidate-runtime-continuity", status="passed", before=state_before, after=state_after)
        before_backup = self.identity(base, cookie, project["id"], file_id, png)
        self.docker("stop", "--time", "25", app_name)
        self.maintenance(f"{self.name}-backup-init", main_volume, backup_volume,
                         ["node", "-e", "require('fs').chownSync('/backup',1000,1000)"], root=True)
        backup = self.maintenance(f"{self.name}-backup-job", main_volume, backup_volume,
                                  ["node", "--import", "tsx", "scripts/backup.ts", "--output", "/backup/test.tar"])
        restored = self.maintenance(f"{self.name}-restore-job", restored_volume, backup_volume,
                                    ["node", "--import", "tsx", "scripts/restore.ts", "--input", "/backup/test.tar"])
        self.report["backupResult"] = json.loads(backup)
        self.report["restoreResult"] = json.loads(restored)
        restore_base = self.start_app(restored_name, restored_volume, self.args.restore_port)
        require(self.http(restore_base, f"/api/projects/{project['id']}", cookie=cookie)[0] == 401,
                "A restored backup must not preserve old sessions")
        _, restored_headers = self.json_request(restore_base, "/api/auth/login", "POST", {"password": password})
        restored_cookie = restored_headers["set-cookie"].split(";")[0]
        after_backup = self.identity(restore_base, restored_cookie, project["id"], file_id, png)
        require(before_backup == after_backup, "New-volume restore changed project revision, ontology or asset bytes")
        self.stage("backup-new-volume-restore", status="passed", sessionsCleared=True, identity=after_backup)
        editor_name = f"{self.name}-editor-smoke"
        self.create_container(editor_name, [*self.limited(), "--network", "none", "-e", "ANTHROPIC_API_KEY=synthetic-qa-canary-not-a-real-key"], self.args.editor_image,
                              ["python3", "/opt/editor/sandbox_smoke.py"])
        editor = self.docker("start", "-a", editor_name, timeout=60, check=False)
        exit_code = self.docker("container", "inspect", "--format", '{{.State.ExitCode}}', editor_name).stdout.strip()
        require(editor.returncode == 0 and exit_code == "0", f"Editor sandbox failed: {editor.stdout} {editor.stderr[-2000:]}")
        self.stage("editor-linux-sandbox", status="passed", evidence=json.loads(editor.stdout), network="none", modelCalls=0, environmentCanary="synthetic, not a real credential")
        protected_after = self.production_snapshot()
        self.report["protectedAfter"] = protected_after
        require(protected_before == protected_after, "Protected production containers changed during QA; investigate separately")
        self.stage("production-containers-unchanged", status="passed" if protected_before else "not_applicable",
                   reason="Explicit protected identities compared" if protected_before else "No protected container list supplied; comparison not performed")
        self.report["status"] = "passed"

    def cleanup(self):
        for name in reversed(list(dict.fromkeys(self.containers))):
            try:
                self.remove_container(name)
                self.report["cleanup"].append({"container": name, "removed": True})
            except Exception as error:
                self.report["cleanup"].append({"container": name, "error": str(error)})
        for name in reversed(self.volumes):
            try:
                owner = self.docker("volume", "inspect", "--format", '{{index .Labels "storyflow.qa.run"}}', name).stdout.strip()
                require(owner == self.name, "Refuse to delete a non-QA volume")
                self.docker("volume", "rm", name)
                self.report["cleanup"].append({"volume": name, "removed": True})
            except Exception as error:
                self.report["cleanup"].append({"volume": name, "error": str(error)})
        self.report["finishedAt"] = time.time()
        self.save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ["name", "app-image", "editor-image", "evidence"]:
        parser.add_argument("--" + key, required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--restore-port", type=int, required=True)
    parser.add_argument("--soak-seconds", type=int, default=600)
    parser.add_argument("--protected-container", action="append", default=[], help="Read-only identity/status comparison; never reads environment")
    args = parser.parse_args()
    run = Acceptance(args)
    try:
        run.run()
    except Exception as error:
        run.report["status"] = "failed"
        run.report["error"] = f"{type(error).__name__}: {error}"
        print(json.dumps({"status": "failed", "error": run.report["error"]}), flush=True)
    finally:
        run.cleanup()
    raise SystemExit(0 if run.report["status"] == "passed" and not any("error" in row for row in run.report["cleanup"]) else 1)


if __name__ == "__main__":
    main()
