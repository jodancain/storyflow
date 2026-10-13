#!/usr/bin/env python3
"""Offline, operator-owned final-film lip review. No provider/model calls.

The timeline describes every frame, not just doctor shots. Files referenced by it
must be local, relative to its directory, and carry their actual SHA-256. Keep the
review JSON outside the model's writable workspace. A named reviewer is an audit
record, not cryptographic proof of a human; the caller must enforce that boundary.

This gate checks identity, coverage and recorded human decisions. It cannot hear
speech, judge mouth shapes, or infer approval from technical timing statistics.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import tempfile


TIMELINE_SCHEMA = "storyflow-final-lip-timeline-v1"
REVIEW_SCHEMA = "storyflow-final-lip-review-v1"
SHA = re.compile(r"^[a-f0-9]{64}$")
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
MODES = {"visible_speech", "voiceover", "silent"}
DECISIONS = {"pass", "change", "not_applicable"}


class ReviewError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise ReviewError(message)


def fields(value, required, optional=()):
    require(isinstance(value, dict), "Expected a JSON object")
    require(set(required) <= value.keys() and not value.keys() - set(required) - set(optional),
            "Missing or unknown fields")


def integer(value, minimum=0, maximum=100000000):
    return type(value) is int and minimum <= value <= maximum


def text(value, limit=10000, empty=False):
    return isinstance(value, str) and len(value) <= limit and (empty or bool(value.strip()))


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def operator_path(value):
    raw = os.fspath(value)
    require("://" not in raw and "\x00" not in raw, "A local filesystem path is required")
    path = Path(raw).expanduser().absolute()
    # Resolve parent aliases (including macOS /tmp), never follow the file itself.
    path = path.parent.resolve() / path.name
    require(not path.is_symlink(), "Symlink files are not allowed")
    return path


def read_bytes(path, limit=None, parent_fd=None):
    try:
        fd = os.open(path if parent_fd is None else path.name,
                     os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent_fd)
        with os.fdopen(fd, "rb") as stream:
            before = os.fstat(stream.fileno())
            require(stat.S_ISREG(before.st_mode), "Expected a regular local file")
            require(limit is None or before.st_size <= limit, "JSON file is too large")
            digest = hashlib.sha256()
            content = [] if limit is not None else None
            count = 0
            while True:
                block = stream.read(1024 * 1024)
                if not block:
                    break
                count += len(block)
                require(limit is None or count <= limit, "JSON file is too large")
                digest.update(block)
                if content is not None:
                    content.append(block)
            after = os.fstat(stream.fileno())
        current = path.lstat() if parent_fd is None else os.stat(path.name, dir_fd=parent_fd, follow_symlinks=False)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        require(stat.S_ISREG(current.st_mode) and identity(before) == identity(after) == identity(current),
                "File changed during validation")
        return digest.hexdigest(), b"".join(content) if content is not None else None
    except OSError as error:
        raise ReviewError(f"Cannot read local file: {path}") from error


def load_json(path, limit=4 * 1024 * 1024):
    digest, content = read_bytes(path, limit)
    try:
        def invalid_constant(value):
            raise ValueError(value)
        def unique_fields(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError("duplicate JSON field")
                value[key] = item
            return value
        value = json.loads(content, parse_constant=invalid_constant, object_pairs_hook=unique_fields)
    except (ValueError, UnicodeDecodeError) as error:
        raise ReviewError("Invalid JSON") from error
    return value, digest


def reference(root, value, cache):
    fields(value, {"path", "sha256"})
    name = value["path"]
    require(isinstance(name, str) and 0 < len(name) <= 4096 and ":" not in name and "\\" not in name
            and "\x00" not in name and not name.startswith("/")
            and all(part not in ("", ".", "..") for part in name.split("/")),
            "References must be relative local paths inside the timeline directory")
    require(isinstance(value["sha256"], str) and SHA.fullmatch(value["sha256"]), "Invalid reference SHA-256")
    path = root
    for part in name.split("/"):
        path = path / part
        require(not path.is_symlink(), "Symlink references are not allowed")
    if name not in cache:
        # Open every component relative to a directory FD. A concurrent switch
        # of an intermediate directory to a symlink cannot redirect the read.
        parent = None
        try:
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            parent = os.open(root, flags)
            for part in name.split("/")[:-1]:
                child = os.open(part, flags, dir_fd=parent)
                os.close(parent)
                parent = child
            cache[name] = read_bytes(path, parent_fd=parent)[0]
        except OSError as error:
            raise ReviewError(f"Missing or unsafe referenced file: {name}") from error
        finally:
            if parent is not None:
                os.close(parent)
    require(cache[name] == value["sha256"], f"Referenced file hash changed: {name}")
    return {"path": str(path), "sha256": cache[name]}


def timeline_snapshot(timeline_path):
    path = operator_path(timeline_path)
    value, digest = load_json(path)
    fields(value, {"schema", "fps", "totalFrames", "film", "audio", "segments"}, {"technical"})
    require(value["schema"] == TIMELINE_SCHEMA, "Unknown timeline schema")
    require(type(value["fps"]) is int and value["fps"] in (24, 25), "Timeline fps must be 24 or 25")
    require(integer(value["totalFrames"], 1), "Invalid totalFrames")
    require(isinstance(value["segments"], list) and 0 < len(value["segments"]) <= 10000, "A complete segment list is required")
    cache = {}
    film = reference(path.parent, value["film"], cache)
    audio = reference(path.parent, value["audio"], cache)
    cursor, ids = 0, set()
    for segment in value["segments"]:
        fields(segment, {"id", "startFrame", "endFrame", "mode", "speakerId", "text", "sourceVideo",
                         "sourceInFrame", "sourceFps", "speed", "audio", "audioInFrame"})
        sid = segment["id"]
        require(isinstance(sid, str) and ID.fullmatch(sid) and sid not in ids, "Duplicate or invalid segment ID")
        ids.add(sid)
        require(integer(segment["startFrame"]) and integer(segment["endFrame"], 1)
                and segment["startFrame"] == cursor and segment["endFrame"] > cursor
                and segment["endFrame"] <= value["totalFrames"],
                "Segments must be ordered, non-overlapping and cover every frame without gaps")
        cursor = segment["endFrame"]
        require(isinstance(segment["mode"], str) and segment["mode"] in MODES, "Unknown segment mode")
        require(integer(segment["sourceInFrame"]) and integer(segment["audioInFrame"]), "Source/audio in-points must be integer frames")
        require(type(segment["sourceFps"]) in (int, float) and 0 < segment["sourceFps"] <= 240
                and math.isfinite(segment["sourceFps"]), "Invalid sourceFps")
        fields(segment["speed"], {"numerator", "denominator"})
        require(all(integer(v, 1, 1000) for v in segment["speed"].values()), "Speed must be a positive rational value")
        reference(path.parent, segment["sourceVideo"], cache)
        if segment["mode"] == "silent":
            require(segment["speakerId"] == "" and segment["text"] == ""
                    and segment["audio"] is None and segment["audioInFrame"] == 0,
                    "Silent segments must not declare speech or a speech-audio reference")
        else:
            require(text(segment["speakerId"], 200) and text(segment["text"]), "Speech segments require a speaker and exact dialogue")
            reference(path.parent, segment["audio"], cache)
    require(cursor == value["totalFrames"], "Segments do not cover the whole film")
    return {"timelinePath": str(path), "timelineSha256": digest, "film": film, "audio": audio,
            "timeline": value, "files": cache}


@contextlib.contextmanager
def review_lock(path, create=False):
    if create:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    require(path.parent.is_dir(), "Review directory does not exist")
    lock = path.with_name(path.name + ".lock")
    try:
        fd = os.open(lock, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    except OSError as error:
        raise ReviewError("Cannot acquire operator review lock") from error
    try:
        require(stat.S_ISREG(os.fstat(fd).st_mode), "Invalid review lock")
        fcntl.flock(fd, fcntl.LOCK_EX)
        require(not path.is_symlink(), "Symlink reviews are not allowed")
        yield
    finally:
        os.close(fd)


def save(path, value):
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(value, output, ensure_ascii=False, sort_keys=True, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def pending(sid):
    return {"id": sid, "status": "pending", "reviewer": "", "note": "", "at": None}


def decision(segment, status, reviewer, note):
    require(isinstance(status, str) and status in DECISIONS, "Unknown review status")
    require(text(reviewer, 200) and text(note), "Every human decision needs reviewer and note; not_applicable needs a reason")
    require(status != "pass" or segment["mode"] == "visible_speech", "Non-visible segments require not_applicable with a reason")
    require(status != "not_applicable" or segment["mode"] != "visible_speech", "Visible speech cannot be marked not_applicable")


def validated_review(path, timeline_path=None):
    review, _ = load_json(path)
    fields(review, {"schema", "revision", "timelinePath", "timelineSha256", "film", "audio", "segments", "history"})
    require(review["schema"] == REVIEW_SCHEMA and integer(review["revision"], 1), "Invalid review schema/revision")
    require(isinstance(review["timelinePath"], str), "Review timeline path is missing")
    snapshot = timeline_snapshot(timeline_path if timeline_path is not None else review["timelinePath"])
    require(all(review[key] == snapshot[key] for key in ("timelinePath", "timelineSha256", "film", "audio")),
            "Frozen film, audio or timeline changed; create a new review without overwriting history")
    segments = {s["id"]: s for s in snapshot["timeline"]["segments"]}
    require(isinstance(review["history"], list) and len(review["history"]) == review["revision"], "Review history/revision mismatch")
    expected = {sid: pending(sid) for sid in segments}
    for revision, event in enumerate(review["history"], 1):
        if revision == 1:
            fields(event, {"revision", "action", "at"})
            require(event["action"] == "init", "Review must begin pending")
        else:
            fields(event, {"revision", "action", "at", "segmentId", "status", "reviewer", "note"})
            require(event["action"] == "record" and isinstance(event["segmentId"], str)
                    and event["segmentId"] in segments, "Unknown reviewed segment")
            decision(segments[event["segmentId"]], event["status"], event["reviewer"], event["note"])
            expected[event["segmentId"]] = {"id": event["segmentId"], "status": event["status"],
                                            "reviewer": event["reviewer"], "note": event["note"], "at": event["at"]}
        require(type(event["revision"]) is int and event["revision"] == revision and text(event["at"], 100), "Invalid audit event")
    require(review["segments"] == list(expected.values()), "Review decisions do not match recorded history and complete segment coverage")
    return review, snapshot


def summary(review, snapshot):
    counts = {key: 0 for key in ("pending", "pass", "change", "not_applicable")}
    for segment in review["segments"]:
        counts[segment["status"]] += 1
    ready = not counts["pending"] and not counts["change"]
    return {"ok": ready, "state": "ready" if ready else "changes_requested" if counts["change"] else "pending_review",
            "revision": review["revision"], "film": snapshot["film"], "audio": snapshot["audio"],
            "timelinePath": snapshot["timelinePath"], "timelineSha256": snapshot["timelineSha256"],
            "fps": snapshot["timeline"]["fps"], "totalFrames": snapshot["timeline"]["totalFrames"],
            "coverage": {"total": len(review["segments"]), **counts},
            "scope": "Recorded final-film lip review only; not medical/content/publication approval"}


def initialize(timeline_path, review_path):
    path = operator_path(review_path)
    with review_lock(path, create=True):
        require(not path.exists(), "Review already exists; init never overwrites history")
        snapshot = timeline_snapshot(timeline_path)
        review = {"schema": REVIEW_SCHEMA, "revision": 1,
                  **{key: snapshot[key] for key in ("timelinePath", "timelineSha256", "film", "audio")},
                  "segments": [pending(s["id"]) for s in snapshot["timeline"]["segments"]],
                  "history": [{"revision": 1, "action": "init", "at": now()}]}
        save(path, review)
        return summary(review, snapshot)


def record(timeline_path, review_path, segment_id, status, reviewer, note, expected_revision):
    path = operator_path(review_path)
    with review_lock(path):
        review, snapshot = validated_review(path, timeline_path)
        require(type(expected_revision) is int and expected_revision == review["revision"], "Review revision conflict; reload before recording")
        segment = next((s for s in snapshot["timeline"]["segments"] if s["id"] == segment_id), None)
        require(segment is not None, "Unknown segment ID")
        status = "not_applicable" if status == "na" else status
        decision(segment, status, reviewer, note)
        at = now()
        review["revision"] += 1
        review["segments"] = [{"id": segment_id, "status": status, "reviewer": reviewer, "note": note, "at": at}
                              if s["id"] == segment_id else s for s in review["segments"]]
        review["history"].append({"revision": review["revision"], "action": "record", "at": at,
                                  "segmentId": segment_id, "status": status, "reviewer": reviewer, "note": note})
        save(path, review)
        return summary(review, snapshot)


def check(review_path, timeline_path=None):
    path = operator_path(review_path)
    with review_lock(path):
        return summary(*validated_review(path, timeline_path))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("init", "record", "check"):
        command = sub.add_parser(name)
        command.add_argument("--timeline", required=name != "check")
        command.add_argument("--review", required=True)
        if name == "record":
            command.add_argument("--expected-revision", type=int, required=True)
            command.add_argument("--segment", required=True)
            command.add_argument("--status", choices=["pass", "change", "not_applicable", "na"], required=True)
            command.add_argument("--reviewer", required=True)
            command.add_argument("--note", required=True)
    args = parser.parse_args()
    try:
        if args.command == "init":
            result = initialize(args.timeline, args.review)
        elif args.command == "record":
            result = record(args.timeline, args.review, args.segment, args.status, args.reviewer, args.note, args.expected_revision)
        else:
            result = check(args.review, args.timeline)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 2 if args.command == "check" and not result["ok"] else 0
    except (ReviewError, OSError, TypeError) as error:
        print(json.dumps({"ok": False, "state": "invalid", "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
