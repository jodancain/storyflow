# StoryFlow private editor worker

Independent Claude Code 2.1.258 / Node 22 editor runtime. Default `9router-native` uses `https://router.yundongyl.cn/v1/messages` with the exact wire model `ezr/claude-opus-5-5`; the explicitly selected `ezr-direct` profile remains available. No `/auto` route or automatic model/profile fallback. No public port or StoryFlow database mount. The model can write and execute local Python/Node postproduction programs through a scoped MCP server, use FFmpeg and inspect PNG/JPEG frames.

Read [the setup and recovery guide](../../docs/EDITOR-WORKER.md) before running a task. `.env.example` contains only host path placeholders and the approved API origin. Keep the real secret and inputs outside this build directory.

Docker uses BuildKit and its private `storyflow-editor-npm` download cache. The four media/runtime packages are pinned to the versions installed for this run: `python3=3.11.2-1+b1`, `ffmpeg=7:5.1.9-0+deb12u1`, `chromium=154.0.8037.92-1~deb12u1`, and `fonts-noto-cjk=1:20220127+repack1-1`. If a repository no longer supplies a pinned version, the build must fail. An operator must explicitly review and change the corresponding Docker build ARG, then repeat runtime/media checks; do not silently remove the pin or upgrade. Compiler, system libraries and transitive apt dependencies are not fully snapshot-pinned.

```sh
python3 -m unittest discover -s ops/editor/tests -v
docker build -t storyflow-editor:claude-2.1.258 ops/editor
docker run --rm --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges \
  storyflow-editor:claude-2.1.258 python3 /opt/editor/sandbox_smoke.py
# Set the private paths shown in .env.example, then:
docker compose -f ops/editor/compose.yaml up -d
```

Build and local sandbox checks do not call a model. Submit a frozen JSON job only within an authorized scope. Interrupted model execution is never automatically resubmitted: verify private state and use an explicitly authorized same-session `resume`. Technical output validation does not approve the voice, medical content or film.

The main executor recorded a successful real Linux/Claude Code smoke on 2026-10-12: native 9Router Messages returned `claude-opus-5-5`, with seven successful tools and two actual Python executions, producing an independently checked one-second, 25-frame H.264/AAC MP4. This gateway-reported model name does not independently verify upstream model identity. Formal voice review remains pending; the production video workflow has not been executed by this worker.
