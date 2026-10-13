# StoryFlow private editor worker

Independent Claude Code 2.1.258 / Node 22 editor runtime. Default `9router-native` uses `https://router.yundongyl.cn/v1/messages` with the exact wire model `ezr/claude-opus-5-5`; the explicitly selected `ezr-direct` profile remains available. No `/auto` route or automatic model/profile fallback. No public port or StoryFlow database mount. The model can write and execute local Python/Node postproduction programs through a scoped MCP server, use FFmpeg and inspect PNG/JPEG frames.

Read [the setup and recovery guide](../../docs/EDITOR-WORKER.md) before running a task. `.env.example` contains only host path placeholders and the approved API origin. Keep the real secret and inputs outside this build directory.

For the native 9Router profile, a per-attempt loopback bridge preserves tool images as image content through the deployed router's Claude-to-OpenAI translation. The bridge keeps the exact upstream model and forwards responses unchanged, without retries. Claude Code receives a temporary loopback token; the real upstream key remains inside the worker. Inspect frames as separate JPEG thumbnails (at most 64 KiB recommended, 96 KiB hard limit) to avoid the router's base64-sensitive token estimate. Original media and final render resolution are unchanged. The direct profile retains its original image limit.

Docker uses BuildKit and its private `storyflow-editor-npm` download cache. The four media/runtime packages are pinned to the versions installed for this run: `python3=3.11.2-1+b1`, `ffmpeg=7:5.1.9-0+deb12u1`, `chromium=155.0.8059.39-1~deb12u1`, and `fonts-noto-cjk=1:20220127+repack1-1`. If a repository no longer supplies a pinned version, the build must fail. An operator must explicitly review and change the corresponding Docker build ARG, then repeat runtime/media checks; do not silently remove the pin or upgrade. Compiler, system libraries and transitive apt dependencies are not fully snapshot-pinned.

```sh
python3 -m unittest discover -s ops/editor/tests -v
docker build -t storyflow-editor:claude-2.1.258 ops/editor
docker run --rm --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges \
  storyflow-editor:claude-2.1.258 python3 /opt/editor/sandbox_smoke.py
# Set the private paths shown in .env.example, then:
docker compose -f ops/editor/compose.yaml up -d
```

Build and local sandbox checks do not call a model. Submit a frozen JSON job only within an authorized scope. Interrupted model execution is never automatically resubmitted: verify private state and use an explicitly authorized same-session `resume`. Technical output validation does not approve the voice, medical content or film.

Final lip-sync review is a separate step after the actual final edit and before publication. Freeze the final film, approved master audio, segment plan and driving-audio hashes. A human reviews every spoken segment at normal speed, then checks its beginning, middle, end and edit boundaries: speaker/text, source in-point, speed, mouth motion, pauses and occlusion. Source-frame and A/V-clock matches do not establish natural-looking speech. Inner narration or offscreen speech may be marked not applicable only with an explicit reason and no visible speaking mouth; old talking footage under inner narration requires repair.

Failed segments return to editing or lip-sync production with the same final approved driving audio, within the authorized generation scope. A photo-plus-audio adapter creates a new talking-person clip; it is not evidence of motion-preserving repair to the original video's mouth. Recompose and review the new final hash again. Any changed final file or bound input invalidates the old review for publication; retain the history. Pending, failed or incomplete review blocks lip-sync approval. This is an operator-run private workflow, not a new public application API or automatic paid generation/publishing bridge. See [the workflow](../../docs/VOICE-FIRST-WORKFLOW.md#最后再对一遍嘴型) and [blank handoff template](../../docs/templates/EDITOR-BRIEF.md).

Use `final_lip_review.py init / record / check` with a complete frame timeline and an operator-owned review file. Each visible-speech segment needs an explicit human pass; other segments require a reasoned not-applicable record. `record --expected-revision` protects concurrent opinions, and every referenced file hash is checked. For worker handoff, the review must be `/state/jobs/<jobId>/final-lip-review.json`, outside the model workspace. `worker.py delivery-check` binds that review to the completed job's actual outputs and frozen master; `export-reviewed` then writes only the reviewed film and a redacted `DELIVERY.json` to a new private destination. It neither publishes nor approves medical content. See [exact schema and commands](../../docs/EDITOR-WORKER.md#私有逐段记录); a persistent handoff mount is not part of the default Compose configuration.

The main executor recorded a successful real Linux/Claude Code smoke on 2026-10-12: native 9Router Messages returned `claude-opus-5-5`, with seven successful tools and two actual Python executions, producing an independently checked one-second, 25-frame H.264/AAC MP4. This gateway-reported model name does not independently verify upstream model identity.

On 2026-10-13 the rebuilt runtime also completed the authorized full-film task: actual inspection of 12 images, executed editing code, 36 shots and five newly driven doctor clips. Independent checks verified 60 seconds / 1500 frames / 25fps / 1080×1920, full decoding, all 13 voice sections and the final spoken sentence against the approved master, and all 446 subtitle characters. The doctor frames were separately matched to their source clocks. This is a review film with known prop/action continuity limitations, not human content or lip-sync-naturalness approval. Runtime evidence stays private. See the guide for the image-bridge repair and the preserved incomplete preparation attempts.
