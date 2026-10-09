import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { ingest } from "../server/ingest.ts";
import { tempStore, fixture, requirements } from "./helpers.ts";

const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const sentence = "This is a synthetic medical story source.";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2RkAAAAASUVORK5CYII=",
  "base64",
);

// Minimal valid PDF with a text drawing operation, a font and a real xref table.
// No report generator dependency; pypdf must genuinely extract the rendered text.
function textPdf() {
  const stream = `BT /F1 16 Tf 40 150 Td (${sentence}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function docx() {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>合成故事：小林记录症状。</w:t></w:r></w:p><w:p><w:r><w:t>医生说明下一步检查。</w:t></w:r></w:p></w:body></w:document>',
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

test("real PDF extraction preserves original bytes, SHA and page provenance", async () => {
  const t = tempStore();
  try {
    const project = t.store.create("PDF source", requirements, fixture()),
      bytes = textPdf();
    const [file] = await ingest(
      t.store,
      project.id,
      "medical-source.pdf",
      bytes,
    );
    assert.equal(file.name, "medical-source.pdf");
    assert.equal(file.mime, "application/pdf");
    assert.equal(file.sha256, digest(bytes));
    assert.deepEqual(t.store.bytes(file.id), bytes);
    assert.match(file.text, /\[Page 1\]/);
    assert.ok(file.text.includes(sentence));
    assert.equal(file.metadata.pages, 1);
    assert.deepEqual(file.metadata.warnings, []);
    assert.equal(file.metadata.extractionError, undefined);
    const saved = t.store.file(file.id);
    assert.equal(saved.text, file.text);
    assert.deepEqual(saved.metadata, file.metadata);
  } finally {
    t.close();
  }
});

test("real DOCX extraction retains Chinese paragraph text and the original package", async () => {
  const t = tempStore();
  try {
    const project = t.store.create("DOCX source", requirements, fixture()),
      bytes = await docx();
    const [file] = await ingest(t.store, project.id, "story.docx", bytes);
    assert.equal(
      file.mime,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    assert.equal(file.text, "合成故事：小林记录症状。\n医生说明下一步检查。");
    assert.equal(file.metadata.extractionError, undefined);
    assert.equal(file.sha256, digest(bytes));
    assert.deepEqual(t.store.bytes(file.id), bytes);
    assert.equal(t.store.file(file.id).text, file.text);
  } finally {
    t.close();
  }
});

test("ZIP imports child source files and reports unsupported/nested entries without losing valid children", async () => {
  const t = tempStore();
  try {
    const project = t.store.create("ZIP sources", requirements, fixture()),
      zip = new JSZip();
    const children = new Map<string, Buffer>([
      ["source.pdf", textPdf()],
      ["story.docx", await docx()],
      ["reference.png", png],
      ["notes.txt", Buffer.from("合成笔记：需要专属素材。")],
    ]);
    for (const [name, bytes] of children) zip.file(`sources/${name}`, bytes);
    zip.file("unsupported.exe", Buffer.from("MZ unsupported fixture"));
    const nested = new JSZip();
    nested.file("nested.txt", "not recursively imported");
    zip.file("nested.zip", await nested.generateAsync({ type: "nodebuffer" }));
    zip.file("__MACOSX/._resource", "skip metadata");
    zip.file(".DS_Store", "skip metadata");
    const results = await ingest(
      t.store,
      project.id,
      "production-package.zip",
      await zip.generateAsync({ type: "nodebuffer" }),
    );
    assert.equal(results.length, 6);
    assert.equal(t.store.files(project.id).length, 4);
    for (const file of results.filter((f) => f.id)) {
      const expected = children.get(file.name);
      assert.ok(expected);
      assert.equal(file.projectId, project.id);
      assert.equal(file.sha256, digest(expected));
      assert.deepEqual(t.store.bytes(file.id), expected);
    }
    assert.ok(
      results.find((f) => f.name === "source.pdf").text.includes(sentence),
    );
    assert.match(
      results.find((f) => f.name === "story.docx").text,
      /小林记录症状/,
    );
    assert.equal(
      results.find((f) => f.name === "unsupported.exe").imported,
      false,
    );
    assert.match(
      results.find((f) => f.name === "unsupported.exe").error,
      /不支持/,
    );
    assert.equal(results.find((f) => f.name === "nested.zip").imported, false);
    assert.match(results.find((f) => f.name === "nested.zip").error, /嵌套ZIP/);
  } finally {
    t.close();
  }
});

test("image import preserves pixels and makes no fabricated OCR or medical evidence", async () => {
  const t = tempStore();
  try {
    const project = t.store.create("Image source", requirements, fixture());
    const [file] = await ingest(t.store, project.id, "reference.png", png);
    assert.equal(file.mime, "image/png");
    assert.equal(file.text, "");
    assert.equal(file.sha256, digest(png));
    assert.deepEqual(t.store.bytes(file.id), png);
    assert.match(file.metadata.warnings.join(" "), /不自动转写为医学证据/);
    assert.deepEqual(t.store.project(project.id).ontology.evidence, []);
  } finally {
    t.close();
  }
});

test("unsupported files reject before storing; failed PDF extraction retains source with explicit error", async () => {
  const t = tempStore();
  try {
    const project = t.store.create(
      "Unsupported sources",
      requirements,
      fixture(),
    );
    await assert.rejects(
      ingest(
        t.store,
        project.id,
        "application.exe",
        Buffer.from("MZ fixture executable bytes"),
      ),
      /不支持或无法识别/,
    );
    assert.equal(t.store.files(project.id).length, 0);
    const damaged = Buffer.from("%PDF-1.4\ninvalid truncated document");
    const [file] = await ingest(t.store, project.id, "damaged.pdf", damaged);
    assert.equal(file.text, "");
    assert.ok(file.metadata.extractionError);
    assert.match(file.metadata.warnings.join(" "), /原文件已保留/);
    assert.deepEqual(t.store.bytes(file.id), damaged);
    assert.equal(file.sha256, digest(damaged));
  } finally {
    t.close();
  }
});
