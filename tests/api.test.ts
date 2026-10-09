import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { createApp } from "../server/app.ts";
import { Jobs } from "../server/jobs.ts";
import { Providers } from "../server/providers.ts";
import { tempStore, fixture, requirements, mockMedia } from "./helpers.ts";
import { ingest, zipEntries } from "../server/ingest.ts";
import { searchReferences } from "../server/references.ts";

async function server() {
  const t = tempStore(),
    provider = new Providers({
      seedanceBase: "",
      seedanceKey: "",
      seedanceModel: "fixture",
      falKey: "",
      falBase: "",
      opusBase: "",
      opusKey: "",
      opusModel: "fixture",
    }),
    jobs = new Jobs(t.store, provider, mockMedia());
  jobs.stopped = true;
  const app = createApp(t.store, jobs, {
    dist: "/does-not-exist",
    search: async (q, s) => ({
      source: s,
      items: [
        {
          id: "pubmed-fixture",
          title: q,
          url: "https://pubmed.ncbi.nlm.nih.gov/1/",
          use: "evidence",
          excerpt: "fixture evidence",
        },
      ],
    }),
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => listener.once("listening", r));
  const address = listener.address() as any;
  const url = `http://127.0.0.1:${address.port}`;
  let cookie = "";
  return {
    ...t,
    jobs,
    url,
    async request(
      path: string,
      method = "GET",
      body?: any,
      headers: Record<string, string> = {},
    ) {
      const response = await fetch(url + path, {
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body && !(body instanceof FormData)
            ? { "content-type": "application/json" }
            : {}),
          ...headers,
        },
        body: body
          ? body instanceof FormData
            ? body
            : JSON.stringify(body)
          : undefined,
      });
      if (response.headers.has("set-cookie"))
        cookie = response.headers.get("set-cookie")!.split(";")[0];
      return response;
    },
    async login() {
      const r = await this.request("/api/auth/setup", "POST", {
        password: "test-storyflow-password",
      });
      assert.equal(r.status, 200);
    },
    async shutdown() {
      jobs.stop();
      await new Promise<void>((r) => listener.close(() => r()));
      t.close();
    },
  };
}

test("single administrator, origin checks, revisions and bound-hash reviews", async () => {
  const s = await server();
  try {
    assert.equal((await s.request("/api/projects")).status, 401);
    await s.login();
    assert.equal(
      (
        await s.request(
          "/api/projects",
          "POST",
          { name: "attack" },
          { origin: "https://another.example" },
        )
      ).status,
      403,
    );
    let response = await s.request("/api/projects", "POST", {
      name: "test",
      requirements,
    });
    assert.equal(response.status, 201);
    let p = await response.json();
    response = await s.request(`/api/projects/${p.id}`, "PATCH", {
      baseRevision: 1,
      ontology: fixture(),
    });
    assert.equal(response.status, 200);
    p = await response.json();
    assert.equal(p.revision, 2);
    assert.equal(
      (
        await s.request(`/api/projects/${p.id}`, "PATCH", {
          baseRevision: 1,
          name: "stale",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await s.request(`/api/projects/${p.id}/reviews`, "PUT", {
          targetId: "s1",
          targetHash: "old",
          status: "pass",
        })
      ).status,
      409,
    );
    response = await s.request(`/api/projects/${p.id}/reviews`, "PUT", {
      targetId: "s1",
      targetHash: p.compiled.targetHashes.s1,
      status: "pass",
      note: "checked",
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).reviews[0].note, "checked");
    assert.equal(
      (
        await s.request("/api/auth/setup", "POST", {
          password: "another-password",
        })
      ).status,
      409,
    );
  } finally {
    await s.shutdown();
  }
});

test("template imports its own redistributable files; project ZIP remaps portable media", async () => {
  const s = await server();
  try {
    await s.login();
    const r = await s.request("/api/projects", "POST", {
      name: "template",
      template: "lupus-v6",
    });
    assert.equal(r.status, 201);
    const p = await r.json();
    assert.equal(p.ontology.shots.length, 20);
    assert.equal(p.files.length, 12);
    assert.equal(p.ontology.spec.totalFrames, 1500);
    for (const f of p.files) {
      assert.equal(s.store.bytes(f.id).length, f.bytes);
    }
    const exported = await s.request(`/api/projects/${p.id}/export`);
    assert.equal(exported.status, 200);
    const form = new FormData();
    form.append(
      "file",
      new Blob([await exported.arrayBuffer()]),
      "project.zip",
    );
    const result = await s.request("/api/import", "POST", form);
    assert.equal(result.status, 201);
    const imported = await result.json();
    assert.notEqual(imported.id, p.id);
    assert.equal(imported.files.length, 12);
    assert.equal(imported.jobs.length, 0);
    const html = await s.request(`/api/projects/${p.id}/review.html`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /首帧|first.frame/);
  } finally {
    await s.shutdown();
  }
});

test("uploads preserve source and text; byte ranges and attachment identity work", async () => {
  const s = await server();
  try {
    await s.login();
    const p = await (
      await s.request("/api/projects", "POST", { name: "files" })
    ).json();
    const form = new FormData();
    form.append(
      "files",
      new Blob(["source notes & <b>not executable</b>"]),
      "notes.txt",
    );
    const response = await s.request(
      `/api/projects/${p.id}/files`,
      "POST",
      form,
    );
    assert.equal(response.status, 201);
    const [f] = await response.json();
    assert.equal(f.text, "source notes & <b>not executable</b>");
    const range = await s.request(`/api/files/${f.id}`, "GET", undefined, {
      range: "bytes=0-5",
    });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), "source");
    assert.match(range.headers.get("content-range") || "", /^bytes 0-5\//);
    const download = await s.request(`/api/files/${f.id}?download=1`);
    assert.match(
      download.headers.get("content-disposition") || "",
      /attachment; filename="?notes.txt"?/,
    );
    assert.equal(
      (
        await s.request(`/api/files/${f.id}`, "GET", undefined, {
          range: "bytes=9999-99999",
        })
      ).status,
      416,
    );
  } finally {
    await s.shutdown();
  }
});

test("ZIP traversal and private cross-project file references are rejected", async () => {
  const s = await server();
  try {
    const a = s.store.create("a", requirements, fixture()),
      b = s.store.create("b", requirements, fixture());
    const f = s.store.addFile(
      a.id,
      "image.png",
      "image/png",
      Buffer.from("abc"),
    );
    await s.login();
    const o = fixture();
    o.assets = [
      {
        id: "foreign",
        kind: "image",
        purpose: "reference",
        label: "foreign",
        gap: false,
        fileId: f.id,
        sha256: f.sha256,
      },
    ];
    assert.equal(
      (
        await s.request(`/api/projects/${b.id}`, "PATCH", {
          baseRevision: 1,
          ontology: o,
        })
      ).status,
      422,
    );
    const zip = new JSZip();
    zip.file("../escape.txt", "unsafe");
    await assert.rejects(
      async () => zipEntries(await zip.generateAsync({ type: "nodebuffer" })),
      /非法原始路径/,
    );
  } finally {
    await s.shutdown();
  }
});

test("reference results are registered as provenance, not fabricated production assets", async () => {
  const s = await server();
  try {
    await s.login();
    const p = await (
      await s.request("/api/projects", "POST", { name: "sources" })
    ).json();
    const search = await (
      await s.request("/api/references/search?q=lupus&source=pubmed")
    ).json();
    const response = await s.request(
      `/api/projects/${p.id}/references`,
      "POST",
      { baseRevision: p.revision, item: search.items[0] },
    );
    assert.equal(response.status, 200);
    const updated = await response.json();
    assert.equal(updated.ontology.evidence.length, 1);
    assert.equal(updated.files.length, 0);
    assert.equal(updated.ontology.assets.length, 0);
  } finally {
    await s.shutdown();
  }
});

test("Commons and PubMed protocol tests preserve author/license without a live external call", async () => {
  const reply = {
    query: {
      pages: {
        "1": {
          pageid: 1,
          title: "File:Hand.jpg",
          imageinfo: [
            {
              descriptionurl:
                "https://commons.wikimedia.org/wiki/File:Hand.jpg",
              thumburl: "https://upload.wikimedia.org/hand.jpg",
              extmetadata: {
                Artist: { value: "<a>Author</a>" },
                LicenseShortName: { value: "CC BY 4.0" },
              },
            },
          ],
        },
      },
    },
  };
  const commons = await searchReferences(
    "hand",
    "commons",
    async () => new Response(JSON.stringify(reply)),
  );
  assert.equal(commons.items[0].author, "Author");
  assert.equal(commons.items[0].license, "CC BY 4.0");
  let calls = 0;
  const pubmed = await searchReferences(
    "lupus",
    "pubmed",
    async () =>
      new Response(
        JSON.stringify(
          ++calls === 1
            ? { esearchresult: { idlist: ["1"] } }
            : {
                result: {
                  "1": {
                    title: "Evidence",
                    authors: [{ name: "Author" }],
                    pubdate: "2026",
                  },
                },
              },
        ),
      ),
  );
  assert.equal(pubmed.items[0].url, "https://pubmed.ncbi.nlm.nih.gov/1/");
});
