import copy
import hashlib
import importlib.util
import json
import multiprocessing
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


MODULE = Path(__file__).resolve().parents[1] / "final_lip_review.py"
spec = importlib.util.spec_from_file_location("final_lip_review", MODULE)
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


def concurrent_record(timeline, target, reviewer_name, queue):
    try:
        result = review.record(timeline, target, "doctor", "pass", reviewer_name, "Watched final film", 1)
        queue.put((True, result["revision"]))
    except review.ReviewError as error:
        queue.put((False, str(error)))


class FinalLipReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="storyflow-final-lip-review-")
        self.root = Path(self.temp.name).resolve()
        self.timeline = self.root / "timeline.json"
        self.target = self.root / "operator" / "review.json"
        refs = {}
        for name in ("film.mp4", "master.wav", "doctor.mp4", "speech.wav", "cutaway.mp4", "card.mp4"):
            data = ("synthetic identity fixture " + name).encode()
            (self.root / name).write_bytes(data)
            refs[name] = {"path": name, "sha256": hashlib.sha256(data).hexdigest()}
        def segment(sid, start, end, mode, video, speech):
            return {"id": sid, "startFrame": start, "endFrame": end, "mode": mode,
                    "speakerId": "doctor" if speech else "", "text": "请按时复查。" if speech else "",
                    "sourceVideo": refs[video], "sourceInFrame": 0, "sourceFps": 25,
                    "speed": {"numerator": 1, "denominator": 1},
                    "audio": refs["speech.wav"] if speech else None, "audioInFrame": 0}
        self.data = {"schema": review.TIMELINE_SCHEMA, "fps": 25, "totalFrames": 75,
                     "film": refs["film.mp4"], "audio": refs["master.wav"],
                     "segments": [segment("doctor", 0, 25, "visible_speech", "doctor.mp4", True),
                                  segment("cutaway", 25, 50, "voiceover", "cutaway.mp4", True),
                                  segment("timecard", 50, 75, "silent", "card.mp4", False)]}
        self.write_timeline()

    def tearDown(self):
        self.temp.cleanup()

    def write_timeline(self):
        self.timeline.write_text(json.dumps(self.data), encoding="utf-8")

    def initialize(self):
        return review.initialize(self.timeline, self.target)

    def approve_all(self):
        for revision, (sid, status) in enumerate((("doctor", "pass"), ("cutaway", "not_applicable"), ("timecard", "na")), 1):
            review.record(self.timeline, self.target, sid, status, "Operator", "Watched this exact final-film interval", revision)

    def test_init_pending_then_complete_human_coverage_and_history(self):
        result = self.initialize()
        self.assertFalse(result["ok"])
        self.assertEqual(result["coverage"]["pending"], 3)
        self.assertFalse(review.check(self.target)["ok"])
        self.approve_all()
        result = review.check(self.target)
        self.assertTrue(result["ok"])
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["revision"], 4)
        self.assertEqual(result["film"]["path"], str(self.root / "film.mp4"))
        self.assertEqual(len(json.loads(self.target.read_text())["history"]), 4)
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o600)

    def test_missing_overlap_tail_gap_duplicate_unknown_mode_and_noninteger_rejected(self):
        original = copy.deepcopy(self.data)
        cases = [lambda v: v["segments"].pop(1),
                 lambda v: v["segments"][1].update(startFrame=24),
                 lambda v: v["segments"][-1].update(endFrame=74),
                 lambda v: v["segments"][1].update(id="doctor"),
                 lambda v: v["segments"][1].update(mode="looks-good"),
                 lambda v: v["segments"][0].update(startFrame=False),
                 lambda v: v["segments"][0].update(endFrame=25.0)]
        for change in cases:
            with self.subTest(change=change):
                self.data = copy.deepcopy(original)
                change(self.data)
                self.write_timeline()
                with self.assertRaises(review.ReviewError):
                    self.initialize()
                self.assertFalse(self.target.exists())

    def test_unknown_segment_status_modes_and_blank_human_fields_rejected(self):
        self.initialize()
        for sid, status, person, note in [("unknown", "pass", "Operator", "Seen"),
                                          ("doctor", "not_applicable", "Operator", "Skip"),
                                          ("cutaway", "pass", "Operator", "Seen"),
                                          ("timecard", "not_applicable", "Operator", ""),
                                          ("doctor", "pass", "", "Seen"),
                                          ("doctor", "auto_pass", "Operator", "Seen")]:
            with self.subTest(sid=sid, status=status), self.assertRaises(review.ReviewError):
                review.record(self.timeline, self.target, sid, status, person, note, 1)
        self.assertEqual(review.check(self.target)["revision"], 1)

    def test_change_stays_blocked_and_reapproval_appends_history(self):
        self.initialize()
        result = review.record(self.timeline, self.target, "doctor", "change", "Operator", "Mouth closes before last word", 1)
        self.assertEqual(result["state"], "changes_requested")
        review.record(self.timeline, self.target, "doctor", "pass", "Operator", "Rechecked this unchanged source", 2)
        result = review.check(self.target)
        self.assertFalse(result["ok"])
        self.assertEqual(result["coverage"]["pending"], 2)
        self.assertEqual(json.loads(self.target.read_text())["history"][1]["status"], "change")

    def test_init_never_overwrites_and_stale_revision_never_writes(self):
        self.initialize()
        before = self.target.read_bytes()
        with self.assertRaisesRegex(review.ReviewError, "already exists"):
            self.initialize()
        with self.assertRaisesRegex(review.ReviewError, "revision conflict"):
            review.record(self.timeline, self.target, "doctor", "pass", "Operator", "Seen", 0)
        self.assertEqual(before, self.target.read_bytes())

    def test_actual_film_master_source_and_speech_hash_drift_rejected_by_record_and_check(self):
        self.initialize()
        self.approve_all()
        for name in ("film.mp4", "master.wav", "doctor.mp4", "speech.wav"):
            with self.subTest(name=name):
                path = self.root / name
                original = path.read_bytes()
                path.write_bytes(b"replacement")
                with self.assertRaisesRegex(review.ReviewError, "hash changed"):
                    review.check(self.target)
                with self.assertRaises(review.ReviewError):
                    review.record(self.timeline, self.target, "doctor", "pass", "Operator", "Seen", 4)
                path.write_bytes(original)

    def test_timeline_cut_speed_dialogue_and_audio_reference_change_invalidate(self):
        self.initialize()
        original = copy.deepcopy(self.data)
        for mutate in [lambda v: v["segments"][0].update(sourceInFrame=1),
                       lambda v: v["segments"][0]["speed"].update(numerator=2),
                       lambda v: v["segments"][0].update(text="另一句"),
                       lambda v: v["segments"][0].update(audioInFrame=1),
                       lambda v: v["segments"][0].update(audio=v["audio"])]:
            with self.subTest(mutate=mutate):
                self.data = copy.deepcopy(original)
                mutate(self.data)
                self.write_timeline()
                with self.assertRaisesRegex(review.ReviewError, "Frozen"):
                    review.check(self.target)
        self.data = original
        self.write_timeline()
        self.assertFalse(review.check(self.target)["ok"])

    def test_technical_success_cannot_grant_mouth_shape_approval_or_skip_history(self):
        self.data["technical"] = {"avOffsetMs": 0, "fullDecodePassed": True, "lipSyncPassed": True, "allApproved": True}
        self.write_timeline()
        self.assertFalse(self.initialize()["ok"])
        self.assertEqual(review.check(self.target)["coverage"]["pending"], 3)
        data = json.loads(self.target.read_text())
        data["segments"][0].update(status="pass", reviewer="auto", note="stats", at="now")
        self.target.write_text(json.dumps(data))
        with self.assertRaisesRegex(review.ReviewError, "history"):
            review.check(self.target)

    def test_reference_urls_parent_paths_missing_files_and_symlinks_rejected(self):
        original = copy.deepcopy(self.data)
        (self.root / "link.mp4").symlink_to(self.root / "doctor.mp4")
        (self.root / "linked-directory").symlink_to(self.root, target_is_directory=True)
        for name in ("https://example.invalid/video.mp4", "../doctor.mp4", "/tmp/doctor.mp4", "missing.mp4", "link.mp4", "linked-directory/doctor.mp4"):
            with self.subTest(name=name):
                self.data = copy.deepcopy(original)
                self.data["segments"][0]["sourceVideo"]["path"] = name
                self.write_timeline()
                with self.assertRaises(review.ReviewError):
                    self.initialize()
        self.data = original
        self.write_timeline()
        self.initialize()
        actual = self.target.with_name("actual.json")
        self.target.rename(actual)
        self.target.symlink_to(actual)
        with self.assertRaises(review.ReviewError):
            review.check(self.target)

    def test_duplicate_json_fields_and_malformed_modes_fail_closed(self):
        raw = self.timeline.read_text()
        self.timeline.write_text(raw.replace('"fps": 25', '"fps": 24, "fps": 25'))
        with self.assertRaises(review.ReviewError):
            self.initialize()
        self.data["segments"][0]["mode"] = {"visible_speech": True}
        self.write_timeline()
        with self.assertRaises(review.ReviewError):
            self.initialize()
        self.data["segments"][0]["mode"] = "visible_speech"
        self.data["segments"][0]["sourceFps"] = 10 ** 1000
        self.write_timeline()
        with self.assertRaises(review.ReviewError):
            self.initialize()

    def test_reference_directory_swap_cannot_redirect_hash_read(self):
        nested = self.root / "nested"
        nested.mkdir()
        (nested / "doctor.mp4").write_bytes((self.root / "doctor.mp4").read_bytes())
        self.data["segments"][0]["sourceVideo"]["path"] = "nested/doctor.mp4"
        self.write_timeline()
        original_open = os.open
        swapped = False
        with tempfile.TemporaryDirectory(prefix="storyflow-lip-outside-") as outside:
            # Identical bytes make a plain string-path SHA check insufficient.
            (Path(outside) / "doctor.mp4").write_bytes((self.root / "doctor.mp4").read_bytes())
            def racing_open(path, flags, *args, **kwargs):
                nonlocal swapped
                if path == "nested" and kwargs.get("dir_fd") is not None and not swapped:
                    swapped = True
                    nested.rename(self.root / "original-nested")
                    nested.symlink_to(outside, target_is_directory=True)
                return original_open(path, flags, *args, **kwargs)
            with mock.patch.object(review.os, "open", side_effect=racing_open):
                with self.assertRaises(review.ReviewError):
                    self.initialize()
            self.assertTrue(swapped)
            self.assertFalse(self.target.exists())

    def test_24fps_integer_coverage_is_supported(self):
        self.data["fps"] = 24
        self.write_timeline()
        self.initialize()
        self.approve_all()
        self.assertEqual(review.check(self.target)["fps"], 24)

    def test_record_concurrent_expected_revision_has_exactly_one_winner(self):
        self.initialize()
        context = multiprocessing.get_context("spawn")
        queue = context.Queue()
        processes = [context.Process(target=concurrent_record, args=(str(self.timeline), str(self.target), name, queue))
                     for name in ("One", "Two")]
        for process in processes:
            process.start()
        for process in processes:
            process.join(10)
            self.assertEqual(process.exitcode, 0)
        outcomes = [queue.get(timeout=2) for _ in processes]
        self.assertEqual(sorted(passed for passed, _ in outcomes), [False, True])
        self.assertEqual(review.check(self.target)["revision"], 2)
        self.assertFalse(list(self.target.parent.glob(".review.json.*")))

    def test_cli_check_is_nonzero_until_complete_and_drift_is_invalid(self):
        env = {"PATH": os.defpath, "HOME": str(Path.home())}
        def cli(*args):
            return subprocess.run([sys.executable, str(MODULE), *args], capture_output=True, text=True, env=env)
        result = cli("init", "--timeline", str(self.timeline), "--review", str(self.target))
        self.assertEqual(result.returncode, 0, result.stdout)
        result = cli("check", "--review", str(self.target))
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["state"], "pending_review")
        self.approve_all()
        self.assertEqual(cli("check", "--review", str(self.target)).returncode, 0)
        (self.root / "film.mp4").write_bytes(b"drift")
        self.assertEqual(cli("check", "--review", str(self.target)).returncode, 1)


if __name__ == "__main__":
    unittest.main()
