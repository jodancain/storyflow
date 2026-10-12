"""Scoped file tools and offline script/media execution for a single editor task."""
import json
import base64
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import struct
import stat
import secrets
from contextlib import contextmanager

MAX_TEXT = 1024 * 1024

def scoped(root, relative, must_exist=False):
    root = Path(root).resolve()
    if not isinstance(relative, str) or not relative or "\x00" in relative:
        raise ValueError("invalid relative path")
    p = Path(relative)
    if p.is_absolute() or any(x in ("..", ".") for x in p.parts):
        raise ValueError("relative path required")
    candidate = root / p
    # Reject symlinks even if their destination happens to be within this task.
    cur = root
    for part in p.parts:
        cur = cur / part
        if cur.is_symlink():
            raise ValueError("symlink denied")
    resolved = candidate.resolve(strict=must_exist)
    if not resolved.is_relative_to(root):
        raise ValueError("outside task")
    if resolved.exists() and resolved.is_file() and resolved.stat().st_nlink != 1:
        raise ValueError("hardlink denied")
    return candidate

@contextmanager
def parent_fd(root, relative, create=False):
    """Walk with dirfds. Concurrent symlink swaps never redirect a file operation."""
    if not isinstance(relative, str) or not relative or "\x00" in relative or relative.startswith("/"):
        raise ValueError("invalid relative path")
    parts = relative.split("/")
    if any(part in ("", ".", "..") for part in parts): raise ValueError("invalid relative path")
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        for part in parts[:-1]:
            if create:
                try: os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError: pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd); fd = child
        yield fd, parts[-1]
    except OSError as exc:
        raise ValueError("unsafe or missing scoped path") from exc
    finally: os.close(fd)


def read_scoped(root, relative, limit):
    with parent_fd(root, relative) as (directory, name):
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size > limit:
                raise ValueError("regular bounded non-linked file required")
            with os.fdopen(fd, "rb", closefd=False) as file: data = file.read(limit + 1)
            if len(data) > limit: raise ValueError("file grew beyond limit")
            return data
        finally: os.close(fd)

class Sandbox:
    def __init__(self, work, inputs, executable="/usr/local/bin/editor-sandbox-exec"):
        self.work, self.inputs = Path(work).resolve(), Path(inputs).resolve()
        self.executable = executable

    def path(self, area, path, exists=False):
        if area not in ("work", "input"):
            raise ValueError("area must be work or input")
        return scoped(self.work if area == "work" else self.inputs, path, exists)

    def area_root(self, area):
        if area not in ("work", "input"): raise ValueError("invalid area")
        return self.work if area == "work" else self.inputs

    def read(self, area, path):
        return read_scoped(self.area_root(area), path, MAX_TEXT).decode("utf-8")

    def write(self, path, text):
        if not isinstance(text, str) or len(text.encode()) > MAX_TEXT:
            raise ValueError("text exceeds 1 MiB")
        data = text.encode()
        with parent_fd(self.work, path, create=True) as (directory, name):
            try:
                old = os.stat(name, dir_fd=directory, follow_symlinks=False)
                if not stat.S_ISREG(old.st_mode) or old.st_nlink != 1: raise ValueError("linked/non-file target denied")
            except FileNotFoundError: pass
            temp = ".editor-" + secrets.token_hex(12)
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
            try:
                with os.fdopen(fd, "wb") as file:
                    file.write(data); file.flush(); os.fsync(file.fileno())
                # rename replaces the directory entry, never follows a swapped target link.
                os.rename(temp, name, src_dir_fd=directory, dst_dir_fd=directory)
                os.fsync(directory)
            finally:
                try: os.unlink(temp, dir_fd=directory)
                except FileNotFoundError: pass
        return {"path": path, "bytes": len(data)}

    def image(self, area, path):
        data = read_scoped(self.area_root(area), path, 8 * 1024 * 1024)
        if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24 and data[12:16] == b"IHDR":
            width, height = struct.unpack(">II", data[16:24]); mime = "image/png"
        elif data.startswith(b"\xff\xd8"):
            width = height = 0; offset = 2; mime = "image/jpeg"
            while offset + 4 <= len(data):
                if data[offset] != 255: raise ValueError("invalid JPEG")
                while offset < len(data) and data[offset] == 255: offset += 1
                marker = data[offset]; offset += 1
                if marker in (0xd9, 0xda): break
                length = int.from_bytes(data[offset:offset+2], "big")
                if length < 2 or offset+length > len(data): raise ValueError("invalid JPEG segment")
                if marker in (0xc0,0xc1,0xc2) and length >= 7:
                    height, width = struct.unpack(">HH", data[offset+3:offset+7]); break
                offset += length
        else: raise ValueError("PNG or JPEG required")
        if not 1 <= width <= 8192 or not 1 <= height <= 8192 or width*height > 16000000:
            raise ValueError("image dimensions exceed limit; resize with FFmpeg first")
        return {"type": "image", "mimeType": mime, "data": base64.b64encode(data).decode("ascii")}

    def listing(self, area):
        root = self.area_root(area); out = []
        def walk(fd, prefix):
            for name in os.listdir(fd):
                if len(out) >= 2000: return
                try:
                    st = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    path = prefix + name
                    if stat.S_ISREG(st.st_mode) and st.st_nlink == 1:
                        out.append({"path": path, "bytes": st.st_size})
                    elif stat.S_ISDIR(st.st_mode):
                        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                        try: walk(child, path + "/")
                        finally: os.close(child)
                except OSError: continue
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try: walk(fd, "")
        finally: os.close(fd)
        return out

    def execute(self, program, args, timeout=600):
        if program not in ("python", "node", "ffmpeg", "ffprobe"):
            raise ValueError("fixed interpreter or FFmpeg only")
        if not isinstance(args, list) or len(args) > 200 or not all(isinstance(a, str) and "\x00" not in a and len(a) < 32768 for a in args):
            raise ValueError("invalid argument vector")
        timeout = min(max(int(timeout), 1), 600)
        binaries = {"python": "/usr/bin/python3", "node": "/usr/local/bin/node", "ffmpeg": "/usr/bin/ffmpeg", "ffprobe": "/usr/bin/ffprobe"}
        if program in ("python", "node"):
            if not args: raise ValueError("script required")
            script = self.path("work", args[0], True)
            if not script.is_file(): raise ValueError("script must be a regular file")
            # No -c / -e / runtime flags. Script itself may do arbitrary local editing,
            # but the inherited Landlock + seccomp boundary remains enforced.
            args = [str(script)] + args[1:]
        scratch = self.work / ".tmp"
        scratch.mkdir(exist_ok=True)
        env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": str(scratch), "TMPDIR": str(scratch),
               "EDITOR_INPUT_DIR": str(self.inputs), "EDITOR_WORK_DIR": str(self.work), "OMP_NUM_THREADS": "2", "OPENBLAS_NUM_THREADS": "2"}
        cmd = [self.executable, str(self.work), str(self.inputs), binaries[program], *args]
        # Logs stay in the sandbox; cap exposure to the model, not execution safety.
        with tempfile.TemporaryFile() as log:
            proc = subprocess.Popen(cmd, cwd=self.work, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
            try:
                code = proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL); proc.wait()
                return {"exitCode": None, "error": "tool_timeout"}
            finally:
                # A script returning early must not leave its FFmpeg children running.
                try: os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError: pass
            log.seek(0, 2); length = log.tell(); log.seek(max(0, length - 65536))
            tail = log.read().decode("utf-8", errors="replace")
        return {"exitCode": code, "output": tail, "truncated": length > 65536}

TOOLS = [
    {"name": "read_image", "description": "View an actual PNG/JPEG image from task input/work as image content. Max 8 MiB/16MP; use FFmpeg to extract or resize a video frame first.", "inputSchema": {"type": "object", "properties": {"area": {"enum": ["input", "work"]}, "path": {"type": "string"}}, "required": ["area", "path"], "additionalProperties": False}},
    {"name": "read_file", "description": "Read UTF-8 text from this task's input or work area. Media: use run with ffprobe or a local script.", "inputSchema": {"type": "object", "properties": {"area": {"enum": ["input", "work"]}, "path": {"type": "string"}}, "required": ["area", "path"], "additionalProperties": False}},
    {"name": "write_file", "description": "Create/replace a UTF-8 file only inside this task workspace, including Python/Node editing programs.", "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}, "text": {"type": "string"}}, "required": ["path", "text"], "additionalProperties": False}},
    {"name": "list_files", "description": "List files in this task only.", "inputSchema": {"type": "object", "properties": {"area": {"enum": ["input", "work"]}}, "required": ["area"], "additionalProperties": False}},
    {"name": "run", "description": "Execute a workspace Python/Node script, or ffmpeg/ffprobe, with no network and no secret/session access. For scripts, args[0] is workspace-relative. EDITOR_INPUT_DIR/EDITOR_WORK_DIR are available. FFmpeg may use these absolute paths. No shell; fixed executable; max 600s.", "inputSchema": {"type": "object", "properties": {"program": {"enum": ["python", "node", "ffmpeg", "ffprobe"]}, "args": {"type": "array", "items": {"type": "string"}}, "timeout": {"type": "integer", "minimum": 1, "maximum": 600}}, "required": ["program", "args"], "additionalProperties": False}},
]

def dispatch(box, name, a):
    if name == "read_image": return box.image(a["area"], a["path"])
    if name == "read_file": return box.read(a["area"], a["path"])
    if name == "write_file": return box.write(a["path"], a["text"])
    if name == "list_files": return box.listing(a["area"])
    if name == "run": return box.execute(a["program"], a["args"], a.get("timeout", 600))
    raise ValueError("unknown tool")
