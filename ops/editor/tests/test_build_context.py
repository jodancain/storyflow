"""Validate this worker's deliberately small, exact-file Docker build allowlist.

This is not a general Dockerignore implementation. Unknown patterns / dynamic
COPY inputs fail explicitly so a future Dockerfile cannot silently evade this
check. No Docker daemon, network, package install, or model call is involved.
"""
import json
from pathlib import Path, PurePosixPath
import re
import shlex
import tempfile
import unittest


def literal_relative_file(value):
    if not isinstance(value, str) or not value or value.startswith("/") or any(c in value for c in "*?[]$!\\"):
        raise ValueError("build context requires literal relative files")
    if any(p in ("", ".", "..") for p in value.split("/")):
        raise ValueError("unsafe build source")
    return value


def verify_context(root):
    root = Path(root)
    rules = [line.strip() for line in (root / ".dockerignore").read_text().splitlines()
             if line.strip() and not line.lstrip().startswith("#")]
    if not rules or rules[0] != "*" or any(not r.startswith("!") for r in rules[1:]):
        raise ValueError("review updated Dockerignore semantics; exact allowlist required")
    allowed = {literal_relative_file(rule[1:]) for rule in rules[1:]}
    sources = []
    # Join Dockerfile continuations before parsing both shell and JSON COPY form.
    dockerfile = re.sub(r"\\\r?\n", " ", (root / "Dockerfile").read_text())
    for line in dockerfile.splitlines():
        match = re.match(r"^\s*COPY\s+(.+)$", line, flags=re.IGNORECASE)
        if not match: continue
        arguments = match[1].strip()
        flags = []
        while arguments.startswith("--"):
            flag, separator, arguments = arguments.partition(" ")
            if not separator: raise ValueError("invalid COPY flags")
            flags.append(flag); arguments = arguments.lstrip()
        if any(f.startswith("--from=") for f in flags):
            continue  # A stage/image copy has no local-context sources.
        if any(not (f.startswith("--chown=") or f.startswith("--chmod=") or f == "--link") for f in flags):
            raise ValueError("review unsupported COPY flag")
        items = json.loads(arguments) if arguments.startswith("[") else shlex.split(arguments)
        if not isinstance(items, list) or len(items) < 2 or not all(isinstance(i, str) for i in items):
            raise ValueError("invalid COPY form")
        for item in items[:-1]:
            source = literal_relative_file(item)
            if source not in allowed: raise ValueError(f"COPY source excluded from context: {source}")
            path = root / source
            if any((root.joinpath(*PurePosixPath(source).parts[:n])).is_symlink()
                   for n in range(1, len(PurePosixPath(source).parts) + 1)) or not path.is_file():
                raise ValueError(f"COPY source missing or not a plain file: {source}")
            sources.append(source)
    if not sources: raise ValueError("no local COPY sources checked")
    return sources


class DockerBuildContextTests(unittest.TestCase):
    def test_every_real_local_copy_source_exists_and_is_in_exact_allowlist(self):
        sources = verify_context(Path(__file__).resolve().parents[1])
        self.assertIn("image_bridge.py", sources)
        self.assertIn("worker.py", sources)
        self.assertIn("package-lock.json", sources)

    def test_missing_whitelist_file_and_unsupported_semantics_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "Dockerfile").write_text('FROM scratch\nCOPY ["worker.py", "image_bridge.py", "/app/"]\n')
            (root / "worker.py").write_text("# fixture")
            (root / "image_bridge.py").write_text("# fixture")
            (root / ".dockerignore").write_text("*\n!worker.py\n")
            with self.assertRaisesRegex(ValueError, "excluded.*image_bridge.py"): verify_context(root)
            (root / ".dockerignore").write_text("*\n!worker.py\n!image_bridge.py\n")
            self.assertEqual(verify_context(root), ["worker.py", "image_bridge.py"])
            (root / "image_bridge.py").unlink()
            with self.assertRaisesRegex(ValueError, "missing.*image_bridge.py"): verify_context(root)
            (root / ".dockerignore").write_text("*\n!*.py\n")
            with self.assertRaises(ValueError): verify_context(root)


if __name__ == "__main__": unittest.main()
