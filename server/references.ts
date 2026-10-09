import { ensure } from "./util.ts";
export async function searchReferences(
  query: string,
  source: string,
  fetchImpl = fetch,
) {
  ensure(
    query.trim().length >= 2 && query.length <= 200,
    "请输入2–200字符关键词",
  );
  if (source === "commons") {
    const url = new URL("https://commons.wikimedia.org/w/api.php");
    url.search = new URLSearchParams({
      action: "query",
      format: "json",
      generator: "search",
      gsrsearch: query,
      gsrnamespace: "6",
      gsrlimit: "12",
      prop: "imageinfo",
      iiprop: "url|extmetadata",
      iiurlwidth: "640",
    }).toString();
    const r = await fetchImpl(url, {
      signal: AbortSignal.timeout(20000),
      headers: { "User-Agent": "StoryFlow/0.1 (reference research)" },
    });
    ensure(r.ok, "Commons检索暂不可用", 502);
    const d: any = await r.json();
    const strip = (s: string) =>
      String(s || "")
        .replace(/<[^>]*>/g, "")
        .slice(0, 800);
    return {
      source,
      items: Object.values(d.query?.pages || {}).map((v: any) => {
        const i = v.imageinfo?.[0] || {},
          m = i.extmetadata || {};
        return {
          id: `commons-${v.pageid}`,
          title: v.title.replace(/^File:/, ""),
          url: i.descriptionurl,
          image: i.thumburl || i.url,
          author: strip(m.Artist?.value),
          license: strip(m.LicenseShortName?.value),
          licenseUrl: m.LicenseUrl?.value,
          excerpt: strip(m.ImageDescription?.value),
          use: "reference",
        };
      }),
    };
  }
  ensure(source === "pubmed", "不支持的参考来源");
  const base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
  const r = await fetchImpl(
    `${base}esearch.fcgi?db=pubmed&retmode=json&retmax=12&term=${encodeURIComponent(query)}`,
    { signal: AbortSignal.timeout(20000) },
  );
  ensure(r.ok, "PubMed检索暂不可用", 502);
  const d: any = await r.json();
  const ids = d.esearchresult?.idlist || [];
  if (!ids.length) return { source, items: [] };
  const summary = await fetchImpl(
    `${base}esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}`,
    { signal: AbortSignal.timeout(20000) },
  );
  ensure(summary.ok, "PubMed摘要暂不可用", 502);
  const data: any = await summary.json();
  return {
    source,
    items: ids.map((id: string) => {
      const x = data.result?.[id] || {};
      return {
        id: `pubmed-${id}`,
        title: x.title || id,
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
        author: (x.authors || [])
          .slice(0, 3)
          .map((a: any) => a.name)
          .join(", "),
        excerpt: [x.fulljournalname, x.pubdate].filter(Boolean).join(" · "),
        license: "论文条目仅供依据检索；图片复用许可需另核",
        use: "evidence",
      };
    }),
  };
}
export function publicURL(value: unknown) {
  if (value === undefined || value === "") return undefined;
  ensure(typeof value === "string" && value.length <= 3000, "链接无效");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("链接格式无效");
  }
  ensure(
    url.protocol === "https:" && !url.username && !url.password,
    "仅接受无凭据HTTPS来源链接",
  );
  ensure(
    !/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[|.*\.local$)/i.test(
      url.hostname,
    ),
    "不接受私网来源链接",
  );
  return url.href;
}
