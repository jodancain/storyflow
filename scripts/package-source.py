#!/usr/bin/env python3
"""Package a complete, immutable Git revision without reading working-tree files.

This is a source release, not a database backup or production-media export.
Only regular tracked blobs are accepted. Path checks are a defense in depth;
operators must also review new tracked content before publishing a release.
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import unicodedata
import zipfile


FORBIDDEN_PARTS = {
    ".git", ".ssh", ".aws", ".claude", ".codex", ".venv", "node_modules",
    "artifacts", "private", "secrets", "credentials", "data", "sessions",
    "test-results", "playwright-report", "dist", "dist-review", "coverage",
    "__pycache__", "doctor-originals", "original-photos", "原照", "原始资料包",
}
FORBIDDEN_SUFFIXES = {".sqlite", ".sqlite3", ".db", ".log", ".pem", ".key", ".p12", ".pfx", ".pyc"}
FORBIDDEN_NAMES = {"id_rsa", "id_ed25519", "id_ecdsa", ".ds_store", "runtime.env"}
FORBIDDEN_PHOTO = re.compile(r"(?:doctor[-_]original|original[-_]doctor|doctor[-_]source[-_]photo|医生原照)", re.I)
SHA256 = re.compile(r"^[0-9a-f]{64}$")


class PackageError(ValueError):
    pass


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.PIPE)


def safe_path(name):
    path = PurePosixPath(name)
    if not name or name.startswith("/") or "\\" in name or any(ord(c) < 32 for c in name):
        raise PackageError("Unsafe tracked path: " + repr(name))
    if path.as_posix() != name or any(part in {".", ".."} for part in path.parts):
        raise PackageError("Non-canonical tracked path: " + repr(name))
    parts = {part.lower() for part in path.parts}
    base = path.name.lower()
    if parts & FORBIDDEN_PARTS or base in FORBIDDEN_NAMES or FORBIDDEN_PHOTO.search(name):
        raise PackageError("Sensitive or runtime path is tracked: " + name)
    if (base == ".env" or base.startswith(".env.")) and base != ".env.example":
        raise PackageError("Private environment file is tracked: " + name)
    if path.suffix.lower() in FORBIDDEN_SUFFIXES or ".sqlite-" in base or ".sqlite3-" in base:
        raise PackageError("Private runtime file is tracked: " + name)
    return path


def read_tree(repo, commit):
    entries = []
    portable_paths = set()
    for record in git(repo, "ls-tree", "-rz", "--full-tree", commit).split(b"\0"):
        if not record:
            continue
        header, raw_name = record.split(b"\t", 1)
        mode, kind, oid = header.decode("ascii").split()
        name = raw_name.decode("utf-8", "strict")
        safe_path(name)
        portable_name = unicodedata.normalize("NFC", name).casefold()
        if portable_name in portable_paths:
            raise PackageError("Case/Unicode path collision would be unsafe on another Mac: " + name)
        portable_paths.add(portable_name)
        if mode not in {"100644", "100755"} or kind != "blob":
            raise PackageError("Links, submodules and non-regular entries are forbidden: " + name)
        entries.append((name, mode, oid))
    if not entries:
        raise PackageError("Cannot release an empty source tree")
    return sorted(entries)


def load_denied_hashes(filename):
    if not filename:
        return set()
    result = set()
    for line in Path(filename).read_text(encoding="utf-8").splitlines():
        value = line.partition("#")[0].strip().lower()
        if not value:
            continue
        if not SHA256.fullmatch(value):
            raise PackageError("The private denied-hash list must contain one SHA-256 per line")
        result.add(value)
    return result


def package_source(repo, revision, output_dir, denied_hashes=None):
    repo, output_dir = Path(repo).resolve(), Path(output_dir).absolute()
    if revision.startswith("-"):
        raise PackageError("Commit must not be a Git option")
    commit = git(repo, "rev-parse", "--verify", revision + "^{commit}").decode().strip()
    entries = read_tree(repo, commit)
    denied_hashes = set(denied_hashes or ())
    timestamp = int(git(repo, "show", "-s", "--format=%ct", commit))
    # A deterministic ZIP date must fit the DOS timestamp range.
    date = datetime.datetime.fromtimestamp(max(315532800, min(timestamp, 4354819198)), datetime.timezone.utc)
    date_tuple = (date.year, date.month, date.day, date.hour, date.minute, date.second)
    archive_name = "storyflow-source-" + commit[:12] + ".zip"
    if output_dir.exists() or output_dir.is_symlink():
        raise PackageError("Output directory already exists; old releases are never overwritten")
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir()  # Atomic reservation, also rejects a racing creator.
    try:
        archive = output_dir / archive_name
        files = []
        with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for name, mode, oid in entries:
                data = git(repo, "cat-file", "blob", oid)
                digest = hashlib.sha256(data).hexdigest()
                if digest in denied_hashes:
                    raise PackageError("A forbidden source-media hash was found: " + name)
                if re.search(rb"(?m)^-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{32,}", data):
                    raise PackageError("Private key material was found: " + name)
                info = zipfile.ZipInfo("storyflow/" + name, date_tuple)
                info.create_system = 3
                info.external_attr = (int(mode, 8) << 16)
                info.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(info, data)
                files.append({"path": name, "mode": mode, "gitBlob": oid, "bytes": len(data), "sha256": digest})
        zip_sha = hashlib.sha256(archive.read_bytes()).hexdigest()
        manifest = {"schema": 1, "kind": "complete-source-release", "commit": commit,
                    "archive": archive_name, "archivePrefix": "storyflow/", "archiveSha256": zip_sha,
                    "fileCount": len(files), "totalSourceBytes": sum(f["bytes"] for f in files),
                    "source": "Git commit blobs only; working tree and untracked files are excluded",
                    "safety": {"regularBlobsOnly": True, "runtimePathsRejected": True,
                               "privateHashDenylistChecked": bool(denied_hashes),
                               "boundary": "Path and private-key checks do not replace review of newly tracked content"},
                    "files": files}
        (output_dir / "SOURCE.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (output_dir / "COMMIT").write_text(commit + "\n", encoding="ascii")
        sums = []
        for name in (archive_name, "SOURCE.json", "COMMIT"):
            sums.append(hashlib.sha256((output_dir / name).read_bytes()).hexdigest() + "  " + name)
        (output_dir / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="ascii")
        return manifest
    except BaseException:
        # The directory was exclusively created by this invocation.
        shutil.rmtree(output_dir)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=".")
    parser.add_argument("--commit", required=True, help="Git commit/tag/ref to freeze")
    parser.add_argument("--output-dir", required=True, help="New destination; never overwrite an old release")
    parser.add_argument("--deny-sha256-file", help="Optional private file containing disallowed original-media SHA-256 values")
    args = parser.parse_args()
    try:
        result = package_source(args.repo, args.commit, args.output_dir, load_denied_hashes(args.deny_sha256_file))
        print(json.dumps({key: result[key] for key in ("commit", "archive", "archiveSha256", "fileCount", "totalSourceBytes")}, ensure_ascii=False))
    except (PackageError, OSError, UnicodeError, subprocess.CalledProcessError) as exc:
        # Git stderr can include environment details; never relay it wholesale.
        print("Source release failed: " + (str(exc) if not isinstance(exc, subprocess.CalledProcessError) else "Git revision/object could not be read"), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
