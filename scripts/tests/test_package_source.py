import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile


spec = importlib.util.spec_from_file_location("package_source", Path(__file__).resolve().parents[1] / "package-source.py")
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class SourcePackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "Release Fixture")
        self.git("config", "user.email", "fixture@example.invalid")

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], stderr=subprocess.PIPE)

    def write(self, name, content=b"fixture"):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def commit(self):
        self.git("add", "-A")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD").decode().strip()

    def test_complete_commit_bytes_not_workspace_and_deterministic(self):
        expected = {
            "src/应用.ts": b"application\x00bytes\n", "server/main.ts": b"server\n",
            "ops/editor/worker.py": b"editor\n", "ops/editor/.env.example": b"EDITOR_API_KEY_FILE=/private/key\n",
            "examples/assets/generated/originals/A-CHAR-D00.png": b"authorized-derived-image",
            "README.md": b"readme", "package-lock.json": b"{}", "Dockerfile": b"FROM test\n",
        }
        for name, data in expected.items():
            self.write(name, data)
        executable = self.write("scripts/run.sh", b"#!/bin/sh\nexit 0\n")
        executable.chmod(0o755)
        expected["scripts/run.sh"] = executable.read_bytes()
        commit = self.commit()
        self.write("src/应用.ts", b"dirty workspace must not be packaged")
        self.write(".env", b"SECRET=untracked-value")
        self.write("artifacts/private/session.json", b"private untracked data")
        first = package.package_source(self.repo, commit, self.root / "first")
        second = package.package_source(self.repo, commit, self.root / "second")
        self.assertEqual(first, second)
        self.assertEqual(first["fileCount"], len(expected))
        self.assertEqual(first["commit"], commit)
        with zipfile.ZipFile(self.root / "first" / first["archive"]) as archive:
            self.assertEqual(set(archive.namelist()), {"storyflow/" + name for name in expected})
            for entry in first["files"]:
                data = archive.read("storyflow/" + entry["path"])
                self.assertEqual(data, expected[entry["path"]])
                self.assertEqual(data, self.git("cat-file", "blob", entry["gitBlob"]))
                self.assertEqual(hashlib.sha256(data).hexdigest(), entry["sha256"])
            self.assertEqual(archive.getinfo("storyflow/scripts/run.sh").external_attr >> 16, 0o100755)
        manifest = json.loads((self.root / "first" / "SOURCE.json").read_text())
        self.assertEqual(first, manifest)
        for line in (self.root / "first" / "SHA256SUMS").read_text().splitlines():
            digest, name = line.split("  ")
            self.assertEqual(digest, hashlib.sha256((self.root / "first" / name).read_bytes()).hexdigest())

    def test_sensitive_tracked_path_rejected_before_output(self):
        for name in (".env", "ops/editor/.env.local", "artifacts/output.json", "private/session.json",
                     "secrets/api-key", "data/db.sqlite-wal", "media/doctor-original.jpg", "原照/医生.jpg"):
            with self.subTest(name=name):
                with self.assertRaises(package.PackageError):
                    package.safe_path(name)
        self.write(".env", b"SECRET=tracked")
        commit = self.commit()
        with self.assertRaisesRegex(package.PackageError, "environment"):
            package.package_source(self.repo, commit, self.root / "release")
        self.assertFalse((self.root / "release").exists())

    def test_tracked_symlink_is_rejected_without_following(self):
        secret = self.root / "private-source-photo.jpg"
        secret.write_bytes(b"must not be read")
        (self.repo / "innocent-image.jpg").symlink_to(secret)
        commit = self.commit()
        with self.assertRaisesRegex(package.PackageError, "Links"):
            package.package_source(self.repo, commit, self.root / "release")
        self.assertFalse((self.root / "release").exists())

    def test_submodule_and_unsafe_archive_paths_rejected(self):
        self.write("README.md")
        commit = self.commit()
        self.git("update-index", "--add", "--cacheinfo", "160000," + commit + ",module")
        self.git("commit", "-qm", "gitlink fixture")
        with self.assertRaisesRegex(package.PackageError, "submodules"):
            package.package_source(self.repo, "HEAD", self.root / "release")
        for name in ("../secret", "/etc/passwd", "foo/../bar", "foo\\bar", "foo//bar", "foo\nbar"):
            with self.subTest(name=name):
                with self.assertRaises(package.PackageError):
                    package.safe_path(name)

    def test_private_media_hash_and_key_content_fail_closed(self):
        source = b"private original bytes with innocuous name"
        self.write("examples/assets/allowed-looking.png", source)
        commit = self.commit()
        with self.assertRaisesRegex(package.PackageError, "forbidden source-media hash"):
            package.package_source(self.repo, commit, self.root / "release", {hashlib.sha256(source).hexdigest()})
        self.assertFalse((self.root / "release").exists())
        self.write("config.txt", b"-----BEGIN " + b"PRIVATE KEY-----\n" + b"Q" * 64 + b"\n-----END PRIVATE KEY-----\n")
        commit = self.commit()
        with self.assertRaisesRegex(package.PackageError, "Private key material"):
            package.package_source(self.repo, commit, self.root / "release")
        self.assertFalse((self.root / "release").exists())

    def test_old_release_never_overwritten_and_invalid_revision_rejected(self):
        self.write("README.md")
        commit = self.commit()
        dest = self.root / "release"
        dest.mkdir()
        (dest / "keep").write_bytes(b"old delivery")
        with self.assertRaisesRegex(package.PackageError, "never overwritten"):
            package.package_source(self.repo, commit, dest)
        self.assertEqual((dest / "keep").read_bytes(), b"old delivery")
        with self.assertRaises(package.PackageError):
            package.package_source(self.repo, "--help", self.root / "other")
        with self.assertRaises(subprocess.CalledProcessError):
            package.package_source(self.repo, "no-such-revision", self.root / "other")
        self.assertFalse((self.root / "other").exists())

    def test_private_denylist_comments_and_invalid_values(self):
        denied = self.root / "deny.txt"
        denied.write_text("# private list\n" + "a" * 64 + "  # original\n\n")
        self.assertEqual(package.load_denied_hashes(denied), {"a" * 64})
        denied.write_text("invalid\n")
        with self.assertRaises(package.PackageError):
            package.load_denied_hashes(denied)

    def test_git_case_collision_is_rejected_for_mac_portability(self):
        self.write("README.md", b"first")
        self.commit()
        blob = self.git("hash-object", "README.md").decode().strip()
        # Create the tree collision in the index even on a case-insensitive Mac.
        self.git("update-index", "--add", "--cacheinfo", "100644," + blob + ",readme.md")
        self.git("commit", "-qm", "portable path collision")
        with self.assertRaisesRegex(package.PackageError, "collision"):
            package.package_source(self.repo, "HEAD", self.root / "release")
        self.assertFalse((self.root / "release").exists())


if __name__ == "__main__":
    unittest.main()
