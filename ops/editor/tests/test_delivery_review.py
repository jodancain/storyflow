"""Operator delivery boundary with synthetic files; no model/media-quality claims."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from worker import Worker, read, save, sha_file
from final_lip_review import initialize, record


class DeliveryReviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        inputs = self.root / "input"; inputs.mkdir()
        (inputs / "master.wav").write_bytes(b"synthetic approved master")
        (inputs / "source.mp4").write_bytes(b"synthetic original footage")
        self.worker = Worker(self.root / "state", self.root / "work", self.root / "sessions", inputs, {})
        self.spec = {"schema": 1, "idempotencyKey": "delivery-fixture", "prompt": "Synthetic offline test",
                     "inputs": [{"path": name, "sha256": sha_file(inputs / name)} for name in ("master.wav", "source.mp4")],
                     "outputs": [{"path": "film.mp4", "media": {"kind": "video", "fps": 25, "frames": 50}}, {"path": "private-script.py"}]}
        self.job = self.worker.submit(self.spec)["jobId"]
        self.d, _, state = self.worker.load(self.job)
        self.work, staged = self.worker.stage(self.job, self.spec)
        (self.work / "film.mp4").write_bytes(b"synthetic rendered film")
        (self.work / "private-script.py").write_bytes(b"private edit instructions")
        self.receipt = [{"path": o["path"], "sha256": sha_file(self.work / o["path"]), "bytes": (self.work / o["path"]).stat().st_size} for o in self.spec["outputs"]]
        state.update(status="completed", attempts=1, outputs=self.receipt)
        save(self.d / "state.json", state); save(self.d / "attempts/001/outputs.json", self.receipt)
        # Media decoding is covered by worker sandbox integration. These tests
        # isolate the operator-review binding and prevent provider submissions.
        self.worker.outputs = lambda *args: self.receipt
        self.timeline = self.work.parent / "final-lip-timeline.json"
        ref = lambda path: {"path": path, "sha256": sha_file(self.work.parent / path)}
        self.timeline_data = {"schema": "storyflow-final-lip-timeline-v1", "fps": 25, "totalFrames": 50,
                              "film": ref("workspace/film.mp4"), "audio": ref("inputs/master.wav"),
                              "segments": [{"id": "spoken", "startFrame": 0, "endFrame": 50, "mode": "visible_speech",
                                            "speakerId": "fixture-speaker", "text": "Synthetic dialogue",
                                            "sourceVideo": ref("inputs/source.mp4"), "sourceInFrame": 0, "sourceFps": 25,
                                            "speed": {"numerator": 1, "denominator": 1},
                                            "audio": ref("inputs/master.wav"), "audioInFrame": 0}]}
        save(self.timeline, self.timeline_data)
        self.review = self.d / "final-lip-review.json"
        initialize(self.timeline, self.review)

    def tearDown(self):
        self.tmp.cleanup()

    def approve(self):
        record(self.timeline, self.review, "spoken", "pass", "Synthetic test reviewer", "Synthetic gate fixture, not a perceptual review", read(self.review)["revision"])

    def test_completed_without_human_review_cannot_export(self):
        result = self.worker.delivery_check(self.job, self.review)
        self.assertFalse(result["ok"])
        with self.assertRaises(ValueError): self.worker.export_reviewed(self.job, self.review, self.root / "handoff")
        self.assertFalse((self.root / "handoff").exists())

    def test_export_only_exact_reviewed_film_and_public_safe_manifest(self):
        self.approve()
        target = self.root / "handoff"
        result = self.worker.export_reviewed(self.job, self.review, target)
        self.assertFalse(result["publiclyPublished"])
        self.assertEqual(set(p.name for p in target.iterdir()), {"film.mp4", "DELIVERY.json"})
        self.assertEqual(sha_file(target / "film.mp4"), sha_file(self.work / "film.mp4"))
        manifest = (target / "DELIVERY.json").read_text()
        self.assertNotIn("fixture-speaker", manifest); self.assertNotIn(str(self.root), manifest)
        with self.assertRaises(FileExistsError): self.worker.export_reviewed(self.job, self.review, target)

    def test_model_workspace_cannot_supply_approval_even_with_correct_contents(self):
        self.approve()
        fake = self.work / "final-lip-review.json"; fake.write_bytes(self.review.read_bytes())
        with self.assertRaisesRegex(ValueError, "operator-owned"):
            self.worker.delivery_check(self.job, fake)
        original = self.review.with_suffix(".original"); self.review.rename(original); self.review.symlink_to(original)
        with self.assertRaisesRegex(ValueError, "operator-owned"):
            self.worker.delivery_check(self.job, self.review)

    def test_edited_film_or_any_declared_output_drift_blocks_handoff(self):
        self.approve()
        (self.work / "film.mp4").write_bytes(b"changed film")
        with self.assertRaises(ValueError): self.worker.delivery_check(self.job, self.review)
        self.worker.outputs = lambda *args: []
        with self.assertRaisesRegex(ValueError, "output drift"):
            self.worker.delivery_check(self.job, self.review)

    def test_timeline_fps_must_match_actual_output_contract(self):
        self.timeline_data["fps"] = 24
        save(self.timeline, self.timeline_data)
        self.review.unlink(); initialize(self.timeline, self.review)
        with self.assertRaisesRegex(ValueError, "frame clock"):
            self.worker.delivery_check(self.job, self.review)

    def test_replacement_master_outside_frozen_inputs_is_rejected(self):
        replacement = self.work / "replacement.wav"; replacement.write_bytes(b"new unapproved voice")
        self.timeline_data["audio"] = {"path": "workspace/replacement.wav", "sha256": sha_file(replacement)}
        save(self.timeline, self.timeline_data)
        self.review.unlink(); initialize(self.timeline, self.review)
        with self.assertRaisesRegex(ValueError, "frozen job input"):
            self.worker.delivery_check(self.job, self.review)

    def test_replacement_segment_voice_cannot_hide_behind_approved_master(self):
        replacement = self.work / "replacement.wav"; replacement.write_bytes(b"new segment voice")
        self.timeline_data["segments"][0]["audio"] = {"path": "workspace/replacement.wav", "sha256": sha_file(replacement)}
        save(self.timeline, self.timeline_data)
        self.review.unlink(); initialize(self.timeline, self.review)
        with self.assertRaisesRegex(ValueError, "segment driving audio"):
            self.worker.delivery_check(self.job, self.review)

    def test_review_change_during_copy_removes_incomplete_handoff(self):
        self.approve()
        real = self.worker._delivery_check
        results = [real(self.job, self.review), {**real(self.job, self.review), "ok": False}]
        with patch.object(self.worker, "_delivery_check", side_effect=results):
            with self.assertRaisesRegex(ValueError, "changed during export"):
                self.worker.export_reviewed(self.job, self.review, self.root / "handoff")
        self.assertFalse((self.root / "handoff").exists())

    def test_incomplete_job_and_private_output_directory_are_rejected(self):
        self.approve()
        with self.assertRaisesRegex(ValueError, "outside editor roots"):
            self.worker.export_reviewed(self.job, self.review, self.work / "handoff")
        state = read(self.d / "state.json"); state["status"] = "needs_reconcile"; save(self.d / "state.json", state)
        with self.assertRaisesRegex(ValueError, "not complete"):
            self.worker.delivery_check(self.job, self.review)


if __name__ == "__main__":
    unittest.main()
