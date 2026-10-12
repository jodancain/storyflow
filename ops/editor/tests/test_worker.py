import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from worker import Worker, MODEL, normalize, read, save, sha_file, lock, redact
from sandbox import Sandbox, scoped

class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.inputs=self.root/"input"; self.inputs.mkdir(); (self.inputs/"source.txt").write_text("fixture")
        self.secret=self.root/"secret"; self.secret.write_text("synthetic-private-key")
        self.worker=Worker(self.root/"state",self.root/"work",self.root/"sessions",self.inputs,{"EDITOR_API_KEY_FILE":str(self.secret)})
        self.worker.preflight=lambda:None
        self.spec={"schema":1,"idempotencyKey":"one","prompt":"Write a real output.","inputs":[{"path":"source.txt","sha256":sha_file(self.inputs/"source.txt")}],"outputs":[{"path":"result.txt"}]}
        self.calls=0

    def tearDown(self): self.temp.cleanup()

    def good_capture(self, cmd, env, prompt, work, log, timeout, callback):
        self.calls+=1
        # Proof that a durable intent exists before the injected provider process.
        states=list((self.worker.state/"jobs").glob("*/state.json")); state=read(states[0]); self.assertEqual(state["status"],"running")
        self.assertTrue((states[0].parent/"attempts"/f'{state["attempts"]:03d}'/"intent.json").exists())
        (work/"result.txt").write_text("actual artifact")
        callback({"type":"assistant","message":{"model":MODEL}})
        self.execution(callback)
        callback({"type":"result","subtype":"success","is_error":False})
        return 0

    def execution(self, callback, code=0):
        callback({"type":"assistant","message":{"model":MODEL,"content":[{"type":"tool_use","id":"run1","name":"mcp__editor__run","input":{"program":"python","args":["build.py"]}}]}})
        callback({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"run1","content":[{"type":"text","text":json.dumps({"exitCode":code,"output":"local execution"})}]}]}})

    def submit(self): return self.worker.submit(self.spec)["jobId"]

    def test_idempotency_and_conflict(self):
        first=self.submit(); self.assertEqual(first,self.submit())
        self.spec["prompt"]="different"
        with self.assertRaises(ValueError): self.submit()

    def test_reservation_is_durable_before_job_and_heals_same_submit(self):
        from worker import save as real_save
        def interrupted(path,data):
            if Path(path).name == "job.json": raise OSError("synthetic power loss")
            real_save(path,data)
        with patch("worker.save",side_effect=interrupted):
            with self.assertRaises(OSError): self.submit()
        index=self.worker.key_index(normalize(self.spec))
        self.assertTrue(index.exists()); self.assertFalse(list((self.worker.state/"jobs").glob("*/state.json")))
        altered=dict(self.spec,prompt="changed after crash")
        with self.assertRaises(ValueError): self.worker.submit(altered)
        job=self.submit(); self.assertEqual(read(index)["jobId"],job)

    def test_missing_reservation_cannot_schedule_legacy_orphan(self):
        job=self.submit(); self.worker.key_index(normalize(self.spec)).unlink()
        self.worker.capture=self.good_capture
        s=self.worker.tick(); self.assertEqual(s["status"],"needs_reconcile"); self.assertEqual(self.calls,0)
        self.assertIsNone(self.worker.tick())

    def test_orphan_attempt_is_blocked_and_resume_uses_new_number(self):
        job=self.submit(); d,_,state=self.worker.load(job)
        (d/"attempts/001").mkdir(parents=True)
        self.worker.capture=self.good_capture
        s=self.worker.tick(); self.assertEqual(s["status"],"needs_reconcile"); self.assertEqual(s["attempts"],1); self.assertEqual(self.calls,0)
        self.worker.resume(job,state["sessionId"],"continue after operator verified orphan","human approval")
        self.assertEqual(self.worker.tick()["attempts"],2); self.assertTrue((d/"attempts/002/intent.json").exists())

    def test_attempt_state_is_persisted_before_attempt_directory(self):
        job=self.submit(); original=Path.mkdir
        def mkdir(path,*args,**kwargs):
            if path.name=="001":
                self.assertEqual(self.worker.load(job)[2]["status"],"submitting")
                raise OSError("synthetic loss")
            return original(path,*args,**kwargs)
        with patch.object(Path,"mkdir",mkdir):
            with self.assertRaises(OSError): self.worker.tick()
        self.assertIsNone(self.worker.tick()); self.assertEqual(self.worker.load(job)[2]["status"],"needs_reconcile")

    def test_adopted_descendants_are_killed_without_touching_baseline(self):
        import worker
        with patch.object(worker.sys,"platform","linux"), patch.object(worker,"descendants",side_effect=[{10,20,30},{10},]), patch.object(worker.os,"kill") as kill, patch.object(worker.os,"waitpid",return_value=(0,0)), patch.object(worker.time,"sleep"):
            worker.cleanup_descendants({10})
        self.assertEqual({call.args[0] for call in kill.call_args_list},{20,30})

    def test_success_requires_real_file_and_records_hash(self):
        job=self.submit(); self.worker.capture=self.good_capture
        s=self.worker.tick(); self.assertEqual(s["status"],"completed"); self.assertEqual(self.calls,1)
        self.assertEqual(s["outputs"][0]["sha256"],hashlib.sha256(b"actual artifact").hexdigest())
        self.assertIsNone(self.worker.tick()); self.assertEqual(self.calls,1)

    def test_text_success_without_output_is_failure(self):
        self.submit()
        def capture(*args): self.execution(args[-1]); args[-1]({"type":"result","subtype":"success"}); return 0
        self.worker.capture=capture
        self.assertEqual(self.worker.tick()["status"],"failed_validation")
        self.assertIsNone(self.worker.tick())

    def test_missing_secret_does_not_write_intent(self):
        job=self.submit(); self.secret.unlink(); s=self.worker.tick()
        self.assertEqual(s["status"],"waiting_configuration"); self.assertEqual(s["attempts"],0)
        self.assertFalse((self.worker.directory(job)/"attempts").exists())

    def test_sandbox_failure_prevents_model(self):
        self.submit()
        def fail(): raise ValueError("sandbox not enabled")
        self.worker.preflight=fail
        s=self.worker.tick(); self.assertEqual(s["attempts"],0); self.assertEqual(s["status"],"waiting_configuration")

    def test_input_drift_prevents_model(self):
        self.submit(); (self.inputs/"source.txt").write_text("changed")
        s=self.worker.tick(); self.assertEqual(s["status"],"invalid_input"); self.assertEqual(s["attempts"],0)

    def test_unknown_submission_never_automatically_replays(self):
        self.submit()
        def capture(*args): self.calls+=1; raise TimeoutError()
        self.worker.capture=capture
        self.assertEqual(self.worker.tick()["status"],"needs_reconcile")
        self.assertIsNone(self.worker.tick()); self.assertEqual(self.calls,1)

    def test_restart_running_without_receipt_becomes_unknown(self):
        job=self.submit(); d,spec,s=self.worker.load(job); s.update(status="running",attempts=1); save(d/"state.json",s)
        self.worker.capture=self.good_capture
        self.assertIsNone(self.worker.tick()); self.assertEqual(self.worker.load(job)[2]["status"],"needs_reconcile"); self.assertEqual(self.calls,0)

    def test_restart_completed_rechecks_output_hash(self):
        job=self.submit(); self.worker.capture=self.good_capture; self.worker.tick()
        (self.worker.work/job/"workspace"/"result.txt").write_text("tampered")
        w=Worker(self.worker.state,self.worker.work,self.worker.sessions,self.inputs,{})
        self.assertIsNone(w.tick()); self.assertEqual(w.load(job)[2]["status"],"artifact_invalid")

    def test_crash_after_output_receipt_recovers_without_model(self):
        job=self.submit(); self.worker.capture=self.good_capture; self.worker.tick()
        d,_,s=self.worker.load(job); s["status"]="running"; save(d/"state.json",s)
        w=Worker(self.worker.state,self.worker.work,self.worker.sessions,self.inputs,{})
        self.assertIsNone(w.tick()); self.assertEqual(w.load(job)[2]["status"],"completed")

    def test_explicit_resume_is_same_session_with_new_intent(self):
        job=self.submit()
        self.worker.capture=lambda *a:1; self.worker.tick(); s=self.worker.load(job)[2]
        with self.assertRaises(ValueError): self.worker.resume(job,s["sessionId"],"continue","")
        with self.assertRaises(ValueError): self.worker.resume(job,"wrong","continue","human chat message")
        self.worker.resume(job,s["sessionId"],"continue","human message reference")
        original=self.good_capture
        def capture(cmd,*args): self.assertIn("--resume",cmd); self.assertIn(s["sessionId"],cmd); return original(cmd,*args)
        self.worker.capture=capture
        new=self.worker.tick(); self.assertEqual(new["attempts"],2); self.assertEqual(new["status"],"completed")
        self.assertTrue((self.worker.directory(job)/"attempts/001/intent.json").exists())

    def test_different_response_model_blocks_success(self):
        self.submit()
        def capture(*args):
            args[-1]({"type":"assistant","message":{"model":"different-model"}}); args[-1]({"type":"result","subtype":"success"}); return 0
        self.worker.capture=capture
        self.assertEqual(self.worker.tick()["status"],"needs_reconcile")

    def test_events_after_terminal_are_unknown(self):
        self.submit()
        def capture(*args):
            args[-1]({"type":"result","subtype":"success"}); args[-1]({"type":"result","subtype":"success"}); return 0
        self.worker.capture=capture
        self.assertEqual(self.worker.tick()["status"],"needs_reconcile")

    def test_explicit_resume_keeps_valid_completed_stage(self):
        job=self.submit(); work,_=self.worker.stage(job,self.spec); (work/"result.txt").write_text("existing")
        self.worker.capture=lambda *a:1; self.worker.tick()
        self.worker.resume(job,self.worker.load(job)[2]["sessionId"],"Verify and preserve completed result.txt","user-authorized repair")
        def capture(*a): self.execution(a[-1]); a[-1]({"type":"result","subtype":"success"}); return 0
        self.worker.capture=capture
        s=self.worker.tick(); self.assertEqual(s["status"],"completed")
        self.assertEqual(s["outputs"][0]["sha256"],hashlib.sha256(b"existing").hexdigest())
        self.assertEqual(s["executionEvidence"]["successfulScriptRunCount"],1)

    def test_missing_returned_model_cannot_complete(self):
        self.submit()
        def capture(*a): a[-1]({"type":"result","subtype":"success"}); return 0
        self.worker.capture=capture
        self.assertEqual(self.worker.tick()["status"],"needs_reconcile")

    def test_model_text_without_actual_tool_execution_cannot_complete(self):
        self.submit()
        def capture(*a):
            (a[3]/"result.txt").write_text("existing")
            a[-1]({"type":"assistant","message":{"model":MODEL}})
            a[-1]({"type":"result","subtype":"success"}); return 0
        self.worker.capture=capture
        self.assertEqual(self.worker.tick()["status"],"failed_validation")

    def test_failed_tool_does_not_count_as_execution(self):
        self.submit()
        def capture(*a):
            (a[3]/"result.txt").write_text("existing")
            self.execution(a[-1],code=1); a[-1]({"type":"result","subtype":"success"}); return 0
        self.worker.capture=capture
        self.assertEqual(self.worker.tick()["status"],"failed_validation")

    def test_output_hash_contract(self):
        self.spec["outputs"][0]["sha256"]="0"*64; self.submit(); self.worker.capture=self.good_capture
        self.assertEqual(self.worker.tick()["status"],"failed_validation")

    def test_global_worker_lock_prevents_parallel_heavy_jobs(self):
        self.submit()
        with lock(self.worker.state/"worker.lock"):
            with self.assertRaises(BlockingIOError): self.worker.tick()

    def test_job_snapshot_tamper_blocks(self):
        job=self.submit(); d,_,s=self.worker.load(job); self.spec["prompt"]="mutated"; save(d/"job.json",self.spec)
        with self.assertRaises(ValueError): self.worker.tick()

    def test_model_and_base_are_frozen(self):
        self.worker.env["EDITOR_MODEL"]="different"
        with self.assertRaises(ValueError): self.worker.credentials()
        self.worker.env["EDITOR_MODEL"]=MODEL; self.worker.env["ANTHROPIC_BASE_URL"]="https://attacker.invalid"
        with self.assertRaises(ValueError): self.worker.credentials()

    def test_native_profile_freezes_endpoint_and_all_model_aliases(self):
        state=self.worker.submit(self.spec)
        profile=self.worker.profile(); self.assertEqual(profile["name"],"9router-native")
        self.assertEqual(profile["base"],"https://router.yundongyl.cn")
        cmd,env=self.worker.command(normalize(self.spec),state,self.root,self.inputs,self.root,profile["base"],"synthetic-key")
        self.assertEqual(cmd[cmd.index("--model")+1],"ezr/claude-opus-5-5")
        for key in ["ANTHROPIC_MODEL","ANTHROPIC_DEFAULT_OPUS_MODEL","ANTHROPIC_DEFAULT_SONNET_MODEL","ANTHROPIC_DEFAULT_HAIKU_MODEL"]:
            self.assertEqual(env[key],"ezr/claude-opus-5-5")
        self.worker.capture=self.good_capture; result=self.worker.tick()
        intent=read(self.worker.directory(state["jobId"])/"attempts/001/intent.json")
        self.assertEqual(intent["messagesEndpoint"],"https://router.yundongyl.cn/v1/messages")
        self.assertNotIn("/auto",intent["messagesEndpoint"])
        self.assertEqual(result["executionEvidence"]["modelIdentityEvidence"],"gateway_report_only_not_independent_upstream_identity")

    def test_native_capture_uses_private_bridge_but_intent_keeps_real_origin(self):
        state=self.worker.submit(self.spec)
        original=self.good_capture
        def capture(cmd,env,*args):
            self.assertTrue(env["ANTHROPIC_BASE_URL"].startswith("http://127.0.0.1:"))
            self.assertNotEqual(env["ANTHROPIC_API_KEY"],"synthetic-private-key")
            self.assertEqual(env["ANTHROPIC_MODEL"],MODEL)
            return original(cmd,env,*args)
        self.worker.capture=capture; result=self.worker.tick()
        attempt=self.worker.directory(state["jobId"])/"attempts/001"
        self.assertEqual(result["status"],"completed")
        self.assertEqual(read(attempt/"intent.json")["apiBase"],"https://router.yundongyl.cn")
        self.assertEqual(read(attempt/"image-bridge.json")["forwardedRequests"],0)
        self.assertNotIn("synthetic-private-key",(attempt/"image-bridge.json").read_text())

    def test_profile_sets_mcp_inspection_byte_limit_without_credential(self):
        state=self.worker.submit(self.spec)
        for profile,limit in [("9router-native",98304),("ezr-direct",8388608)]:
            self.worker.env["EDITOR_ROUTE_PROFILE"]=profile
            config=self.worker.profile()
            cmd,_=self.worker.command(normalize(self.spec),state,self.root,self.inputs,self.root,config["base"],"synthetic-secret")
            mcp=json.loads(cmd[cmd.index("--mcp-config")+1])["mcpServers"]["editor"]["env"]
            self.assertEqual(mcp["EDITOR_IMAGE_MAX_BYTES"],str(limit))
            self.assertEqual(set(mcp),{"EDITOR_TASK_WORK","EDITOR_TASK_INPUT","EDITOR_IMAGE_MAX_BYTES"})
            self.assertNotIn("synthetic-secret",json.dumps(mcp))

    def test_ezr_direct_is_explicit_and_no_automatic_profile_fallback(self):
        self.worker.env.update(EDITOR_ROUTE_PROFILE="ezr-direct",ANTHROPIC_BASE_URL="https://ezr.sh",EDITOR_MODEL="claude-opus-5-5")
        base,_=self.worker.credentials(); self.assertEqual(base,"https://ezr.sh")
        self.assertEqual(self.worker.profile()["acceptedReportedModels"],("claude-opus-5-5",))
        self.worker.env["ANTHROPIC_BASE_URL"]="https://router.yundongyl.cn"
        with self.assertRaises(ValueError): self.worker.credentials()
        self.worker.env["EDITOR_ROUTE_PROFILE"]="auto"
        with self.assertRaises(ValueError): self.worker.credentials()

    def test_native_profile_accepts_unprefixed_gateway_report_and_preserves_it(self):
        self.submit()
        def capture(*args):
            def unprefix(event):
                if isinstance(event.get("message"),dict) and event["message"].get("model")==MODEL: event["message"]["model"]="claude-opus-5-5"
                args[-1](event)
            return self.good_capture(*args[:-1],unprefix)
        self.worker.capture=capture; result=self.worker.tick()
        self.assertEqual(result["status"],"completed"); self.assertEqual(result["reportedModels"],["claude-opus-5-5"])
        self.assertEqual(result["executionEvidence"]["requestedModel"],MODEL)

    def test_resume_does_not_count_old_synthetic_or_replayed_tool_evidence(self):
        job=self.submit(); self.worker.capture=lambda *a:1; self.worker.tick()
        d,_,state=self.worker.load(job); old={"type":"assistant","uuid":"old-uuid","message":{"id":"old-message","model":"<synthetic>"}}
        (d/"attempts/001/stream.ndjson").write_text(json.dumps(old)+"\n")
        old_hash=sha_file(d/"attempts/001/stream.ndjson")
        self.worker.resume(job,state["sessionId"],"authorized native gateway continuation","user new route authorization")
        def capture(*args):
            args[-1](old)
            args[-1]({"type":"assistant","isReplay":True,"message":{"model":"different-old-model"}})
            return self.good_capture(*args)
        self.worker.capture=capture; result=self.worker.tick()
        self.assertEqual(result["status"],"completed"); self.assertEqual(result["observedModels"],[MODEL])
        self.assertEqual(result["executionEvidence"]["ignoredReplayEventCount"],2)
        self.assertEqual(sha_file(d/"attempts/001/stream.ndjson"),old_hash)

    def test_synthetic_success_alone_cannot_prove_current_model(self):
        self.submit()
        def capture(*args):
            args[-1]({"type":"assistant","message":{"model":"<synthetic>"}})
            args[-1]({"type":"result","subtype":"success"}); return 0
        self.worker.capture=capture; result=self.worker.tick()
        self.assertEqual(result["status"],"needs_reconcile"); self.assertEqual(result["observedModels"],[])
        self.assertEqual(result["reportedModels"],["<synthetic>"])

    def test_cli_environment_is_whitelist_and_no_builtin_tools(self):
        s=self.worker.submit(self.spec); cmd,env=self.worker.command(normalize(self.spec),s,self.root,self.inputs,self.root,"https://router.yundongyl.cn","synthetic-private-key")
        self.assertEqual(cmd[cmd.index("--tools")+1],""); self.assertIn("--strict-mcp-config",cmd)
        self.assertNotIn("--fallback-model",cmd); self.assertNotIn("synthetic-private-key", " ".join(cmd))
        self.assertEqual(env["CLAUDE_CODE_MAX_RETRIES"],"0"); self.assertNotIn("VOLCENGINE_SECRET_ACCESS_KEY",env)

    def test_private_file_modes(self):
        job=self.submit(); self.assertEqual((self.worker.directory(job)/"job.json").stat().st_mode & 0o777,0o600)

    def test_secret_redaction(self):
        text='key echoed synthetic-private-key Authorization: Bearer sk-abcdefghijklmnopqrst'
        red=redact(text,["synthetic-private-key"])
        self.assertNotIn("synthetic-private-key",red); self.assertNotIn("sk-abcdefghijklmnopqrst",red)

    def test_capture_redacts_split_chunks_and_final_json(self):
        work=self.root/"capture"; work.mkdir(); log=self.root/"private-log"
        script="import sys;sys.stdout.write('synthetic-');sys.stdout.flush();sys.stdout.write('private-key\\n');sys.stdout.write('{\\\"type\\\":\\\"result\\\",\\\"subtype\\\":\\\"success\\\"}');sys.stdout.flush()"
        events=[]
        code=self.worker.capture([sys.executable,"-c",script],{"ANTHROPIC_API_KEY":"synthetic-private-key"},"prompt",work,log,5,events.append)
        self.assertEqual(code,0); self.assertNotIn("synthetic-private-key",log.read_text()); self.assertEqual(events[-1]["subtype"],"success")

    def test_bridge_capture_redacts_upstream_echo_and_local_token(self):
        work=self.root/"capture"; work.mkdir(); log=self.root/"private-log"
        self.worker._capture_secrets=("synthetic-upstream-value",)
        script="import sys;sys.stdout.write('synthetic-upstream-');sys.stdout.flush();sys.stdout.write('value local-token\\n');sys.stdout.write('{\\\"type\\\":\\\"result\\\",\\\"error\\\":\\\"synthetic-upstream-value\\\"}');sys.stdout.flush()"
        events=[]
        self.worker.capture([sys.executable,"-c",script],{"ANTHROPIC_API_KEY":"local-token"},"prompt",work,log,5,events.append)
        self.assertNotIn("synthetic-upstream-value",log.read_text()); self.assertNotIn("local-token",log.read_text())
        self.assertEqual(events[-1]["error"],"[REDACTED]")

class SandboxTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.root=Path(self.temp.name); self.work=self.root/"work"; self.inputs=self.root/"input"
        self.work.mkdir(); self.inputs.mkdir(); self.box=Sandbox(self.work,self.inputs)
    def tearDown(self): self.temp.cleanup()
    def test_scoped_files_and_input_readonly(self):
        self.box.write("notes/edit.py","print('ok')"); self.assertIn("print",self.box.read("work","notes/edit.py"))
        with self.assertRaises(ValueError): self.box.write("../secret","bad")
        with self.assertRaises(ValueError): self.box.read("other","secret")
    def test_symlink_and_hardlink_are_rejected(self):
        secret=self.root/"secret"; secret.write_text("private"); (self.work/"link").symlink_to(secret)
        with self.assertRaises(ValueError): self.box.read("work","link")
        os.link(secret,self.work/"hard")
        with self.assertRaises(ValueError): self.box.read("work","hard")
    def test_read_parent_symlink_swap_does_not_redirect_open(self):
        (self.work/"dir").mkdir(); (self.work/"dir/file.txt").write_text("safe")
        (self.root/"outside").mkdir(); (self.root/"outside/file.txt").write_text("secret")
        original=os.open; changed=False
        def opening(path,*args,**kwargs):
            nonlocal changed
            fd=original(path,*args,**kwargs)
            if path=="dir" and not changed:
                changed=True; (self.work/"dir").rename(self.work/"old"); (self.work/"dir").symlink_to(self.root/"outside",target_is_directory=True)
            return fd
        with patch("sandbox.os.open",side_effect=opening): self.assertEqual(self.box.read("work","dir/file.txt"),"safe")

    def test_final_symlink_swap_is_denied_at_open(self):
        (self.work/"file.txt").write_text("safe"); (self.root/"secret").write_text("secret")
        original=os.open; changed=False
        def opening(path,*args,**kwargs):
            nonlocal changed
            if path=="file.txt" and not changed:
                changed=True; (self.work/"file.txt").unlink(); (self.work/"file.txt").symlink_to(self.root/"secret")
            return original(path,*args,**kwargs)
        with patch("sandbox.os.open",side_effect=opening):
            with self.assertRaises(ValueError): self.box.read("work","file.txt")

    def test_write_parent_symlink_swap_never_changes_outside(self):
        (self.work/"dir").mkdir(); (self.root/"outside").mkdir(); (self.root/"outside/file.txt").write_text("private")
        original=os.open; changed=False
        def opening(path,*args,**kwargs):
            nonlocal changed
            fd=original(path,*args,**kwargs)
            if path=="dir" and not changed:
                changed=True; (self.work/"dir").rename(self.work/"old"); (self.work/"dir").symlink_to(self.root/"outside",target_is_directory=True)
            return fd
        with patch("sandbox.os.open",side_effect=opening): self.box.write("dir/file.txt","new")
        self.assertEqual((self.root/"outside/file.txt").read_text(),"private")
        self.assertEqual((self.work/"old/file.txt").read_text(),"new")

    def test_listing_does_not_follow_directory_symlink(self):
        (self.root/"outside").mkdir(); (self.root/"outside/secret.txt").write_text("private")
        (self.work/"link").symlink_to(self.root/"outside",target_is_directory=True)
        self.assertEqual(self.box.listing("work"),[])

    def test_unsafe_schema_paths_and_unknown_fields(self):
        base={"schema":1,"idempotencyKey":"k","prompt":"p","inputs":[],"outputs":[{"path":"../x"}]}
        with self.assertRaises(ValueError): normalize(base)
        base["outputs"]=[{"path":"x"}]; base["apiKey"]="not-allowed"
        with self.assertRaises(ValueError): normalize(base)
    def test_arbitrary_shell_or_inline_script_not_allowed(self):
        with self.assertRaises(ValueError): self.box.execute("bash",["-c","echo x"])
        with self.assertRaises(FileNotFoundError): self.box.execute("python",["-c","print(1)"])
    def test_image_content_is_png_and_bounded(self):
        import base64
        png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==')
        (self.inputs/"frame.png").write_bytes(png)
        r=self.box.image("input","frame.png"); self.assertEqual(r["type"],"image"); self.assertEqual(r["mimeType"],"image/png")
        (self.inputs/"fake.png").write_text("not an image")
        with self.assertRaises(ValueError): self.box.image("input","fake.png")

    def test_native_image_cap_rejects_without_modifying_source_direct_still_accepts(self):
        import base64
        from sandbox import ImageReadLimitError, NATIVE_IMAGE_BYTES
        png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==')
        large=png+b"\0"*(100*1024)
        file=self.inputs/"large.png"; file.write_bytes(large); before=sha_file(file)
        native=Sandbox(self.work,self.inputs,image_max_bytes=NATIVE_IMAGE_BYTES)
        with self.assertRaisesRegex(ImageReadLimitError,"96 KiB.*FFmpeg.*64 KiB"): native.image("input","large.png")
        self.assertEqual(sha_file(file),before)
        self.assertEqual(base64.b64decode(self.box.image("input","large.png")["data"]),large)
        (self.inputs/"small.png").write_bytes(png)
        self.assertEqual(base64.b64decode(native.image("input","small.png")["data"]),png)

class MCPProtocolTests(unittest.TestCase):
    def test_native_stdio_size_error_is_actionable_and_no_image_returned(self):
        import subprocess
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); work=root/"work"; inputs=root/"inputs"; work.mkdir(); inputs.mkdir()
            file=inputs/"large.png"; file.write_bytes(b"x"*(96*1024+1))
            requests=[{"jsonrpc":"2.0","id":1,"method":"tools/list"},
                      {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_image","arguments":{"area":"input","path":"large.png"}}}]
            result=subprocess.run([sys.executable,str(Path(__file__).resolve().parents[1]/"mcp_server.py")],
                input="".join(json.dumps(r)+"\n" for r in requests),capture_output=True,text=True,check=True,timeout=10,
                env={"EDITOR_TASK_WORK":str(work),"EDITOR_TASK_INPUT":str(inputs),"EDITOR_IMAGE_MAX_BYTES":"98304"})
            replies=[json.loads(line)["result"] for line in result.stdout.splitlines()]
            description=next(t["description"] for t in replies[0]["tools"] if t["name"]=="read_image")
            self.assertIn("96 KiB",description); self.assertIn("64 KiB",description)
            self.assertTrue(replies[1]["isError"]);self.assertEqual(replies[1]["content"][0]["type"],"text")
            self.assertIn("FFmpeg",replies[1]["content"][0]["text"]); self.assertIn("64 KiB",replies[1]["content"][0]["text"])
            self.assertNotIn('"data":',result.stdout);self.assertEqual(file.stat().st_size,96*1024+1)

    def test_actual_stdio_initialize_list_read_write(self):
        import subprocess
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); work=root/"work"; inputs=root/"inputs"; work.mkdir(); inputs.mkdir()
            (inputs/"brief.txt").write_text("fixture")
            requests=[
                {"jsonrpc":"2.0","id":1,"method":"initialize","params":{}},
                {"jsonrpc":"2.0","id":2,"method":"tools/list"},
                {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_file","arguments":{"area":"input","path":"brief.txt"}}},
                {"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"write_file","arguments":{"path":"check.py","text":"print(1)"}}}
            ]
            result=subprocess.run([sys.executable,str(Path(__file__).resolve().parents[1]/"mcp_server.py")],
                input="".join(json.dumps(r)+"\n" for r in requests), capture_output=True,text=True,check=True,timeout=10,
                env={"EDITOR_TASK_WORK":str(work),"EDITOR_TASK_INPUT":str(inputs),"ANTHROPIC_API_KEY":"synthetic-protocol-secret"})
            replies=[json.loads(line) for line in result.stdout.splitlines()]
            self.assertEqual(len(replies),4); self.assertEqual(result.stderr,"")
            self.assertEqual(replies[0]["result"]["protocolVersion"],"2024-11-05")
            self.assertEqual(len(replies[1]["result"]["tools"]),5)
            self.assertEqual(json.loads(replies[2]["result"]["content"][0]["text"]),"fixture")
            self.assertEqual((work/"check.py").read_text(),"print(1)")
            self.assertNotIn("synthetic-protocol-secret",result.stdout)

if __name__ == "__main__": unittest.main()
