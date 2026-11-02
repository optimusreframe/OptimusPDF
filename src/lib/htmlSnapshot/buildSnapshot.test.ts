import { describe, expect, it } from "vitest";
import { parse } from "parse5";
import {
  assertClean,
  buildSnapshot,
  chooseSrcsetCandidate,
  normalizeInlineDataUri,
  parseSrcset,
  validateImageBytes,
  type FetchedResource,
  type ResourceFetcher,
} from "@/lib/htmlSnapshot/buildSnapshot";
import { SnapshotError, SNAPSHOT_LIMITS } from "@/lib/htmlSnapshot/types";

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
const enc = (text: string) => new TextEncoder().encode(text);

type Table = Record<string, { mime: string; bytes: Uint8Array }>;

function fetcher(table: Table, log: string[] = []): ResourceFetcher {
  return async (url): Promise<FetchedResource> => {
    log.push(url);
    const found = table[url];
    if (!found) return { ok: false };
    return { ok: true, bytes: found.bytes, mime: found.mime, contentType: found.mime, url };
  };
}

const PAGE = "https://sitio.example.com/blog/post.html";

async function build(html: string, table: Table = {}, log: string[] = []) {
  return buildSnapshot({ html, pageUrl: PAGE, fetchResource: fetcher(table, log) });
}

/** Cuenta elementos y atributos del HTML resultante, como lo veria un navegador. */
function inspect(html: string) {
  const doc = parse(html, { scriptingEnabled: false });
  const tags: string[] = [];
  const attrs: Array<{ tag: string; name: string; value: string }> = [];
  const stack = [doc as unknown as { childNodes: unknown[] }];
  while (stack.length) {
    const node = stack.pop()!;
    for (const child of node.childNodes as Array<{ tagName?: string; attrs?: Array<{ name: string; value: string }>; childNodes?: unknown[] }>) {
      if (child.tagName) {
        tags.push(child.tagName.toLowerCase());
        for (const attr of child.attrs ?? []) attrs.push({ tag: child.tagName.toLowerCase(), name: attr.name.toLowerCase(), value: attr.value });
        stack.push(child as { childNodes: unknown[] });
      }
    }
  }
  return { tags, attrs };
}

describe("buildSnapshot — saneo", () => {
  const HOSTILE = `<!doctype html><html lang="es" onload="x()"><head>
    <meta http-equiv="refresh" content="0;url=https://evil.example/"><base href="https://sitio.example.com/base/">
    <title>Mi pagina &amp; mas</title><script>alert(1)</script>
    <link rel="icon" href="/f.ico"><link rel="preload" href="/a.js" as="script">
  </head><body onload="steal()">
    <script src="https://evil.example/x.js"></script><noscript><img src="/pixel.gif"></noscript>
    <iframe src="https://evil.example/frame"></iframe><object data="x.swf"></object><embed src="y.swf">
    <video src="v.mp4" poster="p.png"></video><audio src="a.mp3"></audio>
    <form action="https://evil.example/post" method="post"><input name="q" formaction="https://evil.example/"><button formaction="/x">Ir</button></form>
    <a href="javascript:alert(1)" onclick="x()" target="_blank" ping="https://evil.example/p">js</a>
    <a href="  JaVa&#x09;Script:alert(1)">js2</a>
    <a href="data:text/html,<script>alert(1)</script>">d</a>
    <a href="/ruta/relativa">rel</a><a href="#ancla">ancla</a><a href="mailto:a@b.c">mail</a>
    <img src="x" onerror="alert(1)" srcdoc="x">
    <div style="background:url(javascript:alert(1));width:expression(alert(1))">e</div>
    <svg onload="x()"><script>alert(1)</script><a xlink:href="javascript:alert(1)"><text>s</text></a><animate attributeName="href" values="javascript:alert(1)"/><use href="https://evil.example/s.svg#a"/><use href="#local"/></svg>
    <math><mi xlink:href="javascript:alert(1)">x</mi></math>
    <template><script>alert(1)</script></template>
    <p>Texto visible que debe sobrevivir al saneado completo del documento.</p>
  </body></html>`;

  it("elimina scripts, marcos, formularios activos, base, manejadores y esquemas peligrosos", async () => {
    const out = await build(HOSTILE);
    const { tags, attrs } = inspect(out.html);
    for (const forbidden of ["script", "noscript", "iframe", "object", "embed", "video", "audio", "base", "form", "template", "math", "animate", "link"]) {
      expect(tags, forbidden).not.toContain(forbidden);
    }
    expect(attrs.filter((a) => a.name.startsWith("on"))).toEqual([]);
    expect(attrs.filter((a) => ["srcdoc", "formaction", "action", "ping", "target", "http-equiv", "poster"].includes(a.name))).toEqual([]);
    expect(out.html).not.toMatch(/javascript:/i);
    expect(out.html).not.toMatch(/evil\.example/);
    expect(out.html).not.toContain("expression(");
    expect(out.html).toContain("Texto visible");
    expect(out.title).toBe("Mi pagina & mas");
    expect(() => assertClean(out.html)).not.toThrow();
  });

  it("los enlaces: relativo -> absoluto, ancla se queda, mailto/data/javascript se quitan", async () => {
    const out = await build(HOSTILE);
    const hrefs = inspect(out.html).attrs.filter((a) => a.tag === "a" && a.name === "href").map((a) => a.value);
    expect(hrefs).toContain("https://sitio.example.com/ruta/relativa");
    expect(hrefs).toContain("#ancla");
    expect(hrefs.some((h) => /mailto|data:|javascript/i.test(h))).toBe(false);
  });

  it("el control de formulario queda (inerte) pero sin destino de envio", async () => {
    const out = await build(HOSTILE);
    const { tags } = inspect(out.html);
    expect(tags).toContain("input");
    expect(tags).toContain("button");
  });

  it("<use> de SVG solo conserva referencias locales", async () => {
    const out = await build(HOSTILE);
    const uses = inspect(out.html).attrs.filter((a) => a.tag === "use").map((a) => a.value);
    expect(uses).toEqual(["#local"]);
  });

  it("avisa de scripts ignorados y de contenido incrustado omitido", async () => {
    const out = await build(HOSTILE);
    expect(out.notes).toEqual(expect.arrayContaining([{ code: "scripts-ignored", count: 3 }, { code: "embeds-omitted", count: 5 }]));
  });

  it("idempotente: volver a analizar y serializar el resultado no revive nada", async () => {
    const out = await build(HOSTILE);
    const again = await buildSnapshot({ html: out.html, pageUrl: PAGE, fetchResource: fetcher({}) });
    expect(() => assertClean(again.html)).not.toThrow();
    expect(inspect(again.html).tags).not.toContain("script");
  });

  it("el HTML resultante lleva <meta charset> en UTF-8", async () => {
    const out = await build("<html><head></head><body><p>ñ</p></body></html>");
    expect(out.html).toContain('<meta charset="utf-8">');
  });

  it("assertClean falla cerrado ante un resto peligroso", () => {
    expect(() => assertClean("<html><body><script>1</script></body></html>")).toThrow(SnapshotError);
    expect(() => assertClean('<html><body><img src="https://x.example/a.png"></body></html>')).toThrow(SnapshotError);
    expect(() => assertClean('<html><body><div onclick="x()"></div></body></html>')).toThrow(SnapshotError);
    expect(() => assertClean('<html><body><div style="background:url(https://x.example/a.png)"></div></body></html>')).toThrow(SnapshotError);
    expect(() => assertClean("<html><head><style>@import 'x.css';</style></head><body></body></html>")).toThrow(SnapshotError);
  });
});

describe("buildSnapshot — hojas de estilo", () => {
  it("incrusta <link rel=stylesheet>, <style>, @import y las url() de imagen, sin dejar referencias externas", async () => {
    const log: string[] = [];
    const out = await build(
      `<html><head>
        <link rel="stylesheet" href="/css/main.css">
        <style>@import url("extra.css"); body{background:url(/img/fondo.png)}</style>
      </head><body><p>x</p></body></html>`,
      {
        "https://sitio.example.com/css/main.css": {
          mime: "text/css",
          bytes: enc('@import "base.css"; h1{background:url(../img/logo.png) no-repeat} @font-face{font-family:F;src:url(f.woff2)} p{color:red}'),
        },
        "https://sitio.example.com/css/base.css": { mime: "text/css", bytes: enc("body{margin:0}") },
        "https://sitio.example.com/blog/extra.css": { mime: "text/css", bytes: enc(".extra{color:blue}") },
        "https://sitio.example.com/img/logo.png": { mime: "image/png", bytes: PNG_1X1 },
        "https://sitio.example.com/img/fondo.png": { mime: "image/png", bytes: PNG_1X1 },
      },
      log,
    );
    expect(out.html).toContain("body{margin:0}"); // @import anidado, en su sitio
    expect(out.html).toContain(".extra{color:blue}");
    expect(out.html).toContain("p{color:red}");
    expect(out.html).not.toContain("@font-face");
    expect(out.html).not.toContain("f.woff2");
    expect(out.html).not.toMatch(/https?:\/\/sitio/); // ninguna referencia externa
    expect((out.html.match(/data:image\/png;base64,/g) ?? []).length).toBe(2);
    expect(log.filter((u) => u.endsWith("logo.png"))).toHaveLength(1);
    expect(out.notes).toEqual(expect.arrayContaining([{ code: "fonts-omitted", count: 1 }]));
    expect(inspect(out.html).tags).not.toContain("link");
  });

  it("resuelve las url() relativas respecto a LA HOJA, no a la pagina", async () => {
    const log: string[] = [];
    await build(
      '<html><head><link rel="stylesheet" href="https://cdn.example.net/a/b/estilo.css"></head><body></body></html>',
      {
        "https://cdn.example.net/a/b/estilo.css": { mime: "text/css", bytes: enc("i{background:url(../i/x.png)}") },
        "https://cdn.example.net/a/i/x.png": { mime: "image/png", bytes: PNG_1X1 },
      },
      log,
    );
    expect(log).toContain("https://cdn.example.net/a/i/x.png");
  });

  it("<link media=print> y @import con medios se envuelven en @media; 'all' no", async () => {
    const out = await build(
      '<html><head><link rel="stylesheet" media="print" href="/p.css"><link rel="stylesheet" media="all" href="/a.css"><style>@import url(/i.css) screen and (min-width:600px);</style></head><body></body></html>',
      {
        "https://sitio.example.com/p.css": { mime: "text/css", bytes: enc(".p{x:1}") },
        "https://sitio.example.com/a.css": { mime: "text/css", bytes: enc(".a{x:1}") },
        "https://sitio.example.com/i.css": { mime: "text/css", bytes: enc(".i{x:1}") },
      },
    );
    expect(out.html).toContain("@media print{.p{x:1}}");
    expect(out.html).toContain(".a{x:1}");
    expect(out.html).not.toContain("@media all");
    expect(out.html).toContain("@media screen and (min-width:600px){.i{x:1}}");
  });

  it("maximo 10 hojas (enlaces + @import): el resto se omite y se avisa", async () => {
    const table: Table = {};
    let links = "";
    for (let index = 0; index < 13; index += 1) {
      links += `<link rel="stylesheet" href="/s${index}.css">`;
      table[`https://sitio.example.com/s${index}.css`] = { mime: "text/css", bytes: enc(`.s${index}{x:1}`) };
    }
    const log: string[] = [];
    const out = await build(`<html><head>${links}</head><body></body></html>`, table, log);
    expect(log.filter((u) => u.endsWith(".css"))).toHaveLength(SNAPSHOT_LIMITS.maxStylesheets);
    expect(out.html).toContain(".s9{x:1}");
    expect(out.html).not.toContain(".s10{x:1}");
    expect(out.notes).toEqual(expect.arrayContaining([{ code: "styles-skipped", count: 3 }]));
  });

  it("@import circular o demasiado profundo no se cuelga", async () => {
    const out = await build('<html><head><link rel="stylesheet" href="/a.css"></head><body></body></html>', {
      "https://sitio.example.com/a.css": { mime: "text/css", bytes: enc('@import "b.css"; .a{x:1}') },
      "https://sitio.example.com/b.css": { mime: "text/css", bytes: enc('@import "a.css"; .b{x:1}') },
    });
    expect(out.html).toContain(".a{x:1}");
    expect(out.html).toContain(".b{x:1}");
    expect(out.html.match(/\.a\{x:1\}/g)!.length).toBeLessThanOrEqual(3);
  });

  it("una hoja con tipo equivocado o que falla se omite y se avisa", async () => {
    const out = await build('<html><head><link rel="stylesheet" href="/mal.css"><link rel="stylesheet" href="/falla.css"></head><body><p>x</p></body></html>', {
      "https://sitio.example.com/mal.css": { mime: "text/html", bytes: enc("<p>no es css</p>") },
    });
    expect(out.notes).toEqual(expect.arrayContaining([{ code: "styles-skipped", count: 2 }]));
    expect(out.html).not.toContain("no es css");
  });

  it("CSS hostil no puede cerrar el <style> ni colar un script", async () => {
    const out = await build('<html><head><style>a{content:"</style><script>alert(1)</script>"}</style></head><body></body></html>');
    expect(inspect(out.html).tags).not.toContain("script");
    expect(() => assertClean(out.html)).not.toThrow();
  });

  it("neutraliza expression(), -moz-binding y behavior", async () => {
    const out = await build("<html><head><style>a{width:expression(alert(1));-moz-binding:x;behavior:foo}</style></head><body></body></html>");
    expect(out.html).not.toMatch(/expression\s*\(|-moz-binding|behavior\s*:/i);
  });
});

describe("buildSnapshot — imagenes", () => {
  it("incrusta <img>, elige UN candidato de srcset y soporta carga perezosa", async () => {
    const log: string[] = [];
    const out = await build(
      `<html><body>
        <img src="/a.png" alt="a" loading="lazy" width="10" height="10">
        <img srcset="/s-400.jpg 400w, /s-800.jpg 800w, /s-2400.jpg 2400w" src="/s-400.jpg" sizes="100vw" alt="s">
        <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/lazy.png" alt="l">
        <picture><source srcset="/otro.webp" type="image/webp"><img src="/a.png" alt="p"></picture>
      </body></html>`,
      {
        "https://sitio.example.com/a.png": { mime: "image/png", bytes: PNG_1X1 },
        "https://sitio.example.com/s-800.jpg": { mime: "image/jpeg", bytes: JPEG },
        "https://sitio.example.com/lazy.png": { mime: "image/png", bytes: PNG_1X1 },
      },
      log,
    );
    expect(log.sort()).toEqual(["https://sitio.example.com/a.png", "https://sitio.example.com/lazy.png", "https://sitio.example.com/s-800.jpg"]);
    const { tags, attrs } = inspect(out.html);
    expect(tags).not.toContain("source");
    const imgs = attrs.filter((a) => a.tag === "img");
    expect(imgs.filter((a) => a.name === "src").every((a) => a.value.startsWith("data:image/"))).toBe(true);
    expect(imgs.filter((a) => ["srcset", "sizes", "loading", "data-src"].includes(a.name))).toEqual([]);
    expect(imgs.filter((a) => a.name === "width" || a.name === "alt").length).toBeGreaterThan(0);
  });

  it("la imagen que falla o no es lo que dice se omite (sin src) y se avisa", async () => {
    const out = await build('<html><body><img src="/falsa.png"><img src="/falta.png"><img src="/ok.gif"></body></html>', {
      "https://sitio.example.com/falsa.png": { mime: "image/png", bytes: enc("<html>no soy un png</html>") },
      "https://sitio.example.com/ok.gif": { mime: "image/gif", bytes: GIF },
    });
    const srcs = inspect(out.html).attrs.filter((a) => a.tag === "img" && a.name === "src");
    expect(srcs).toHaveLength(1);
    expect(out.notes).toEqual(expect.arrayContaining([{ code: "images-skipped", count: 2 }]));
  });

  it("maximo 30 imagenes distintas; las repetidas cuentan una sola vez", async () => {
    const table: Table = {};
    let body = "";
    for (let index = 0; index < 35; index += 1) {
      body += `<img src="/i${index}.png"><img src="/i0.png">`;
      table[`https://sitio.example.com/i${index}.png`] = { mime: "image/png", bytes: PNG_1X1 };
    }
    const log: string[] = [];
    const out = await build(`<html><body>${body}</body></html>`, table, log);
    expect(new Set(log).size).toBe(SNAPSHOT_LIMITS.maxImages);
    expect(log).toHaveLength(SNAPSHOT_LIMITS.maxImages);
    expect(out.notes).toEqual(expect.arrayContaining([{ code: "images-limit", count: 5 }]));
  });

  it("SVG con scripts se descarta; un SVG limpio se incrusta", async () => {
    const out = await build('<html><body><img src="/malo.svg"><img src="/bueno.svg"></body></html>', {
      "https://sitio.example.com/malo.svg": { mime: "image/svg+xml", bytes: enc('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') },
      "https://sitio.example.com/bueno.svg": { mime: "image/svg+xml", bytes: enc('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>') },
    });
    const srcs = inspect(out.html).attrs.filter((a) => a.tag === "img" && a.name === "src");
    expect(srcs).toHaveLength(1);
    expect(srcs[0].value.startsWith("data:image/svg+xml;base64,")).toBe(true);
  });

  it("topa la respuesta en ~3,5 MB omitiendo las imagenes mas grandes primero", async () => {
    const big = new Uint8Array(1_400_000);
    big.set(PNG_1X1.subarray(0, 8));
    const small = new Uint8Array(50_000);
    small.set(PNG_1X1.subarray(0, 8));
    const out = await build('<html><body><img src="/g1.png"><img src="/g2.png"><img src="/g3.png"><img src="/peq.png"></body></html>', {
      "https://sitio.example.com/g1.png": { mime: "image/png", bytes: big },
      "https://sitio.example.com/g2.png": { mime: "image/png", bytes: big },
      "https://sitio.example.com/g3.png": { mime: "image/png", bytes: big },
      "https://sitio.example.com/peq.png": { mime: "image/png", bytes: small },
    });
    expect(Buffer.byteLength(out.html, "utf-8")).toBeLessThanOrEqual(SNAPSHOT_LIMITS.maxResponseBytes);
    const srcs = inspect(out.html).attrs.filter((a) => a.tag === "img" && a.name === "src");
    expect(srcs.length).toBeGreaterThanOrEqual(2); // la pequena y al menos una grande
    expect(srcs.length).toBeLessThan(4);
    expect(srcs.some((a) => a.value.length < 100_000)).toBe(true); // la pequena SIEMPRE cabe
    expect(out.notes.some((n) => n.code === "images-budget")).toBe(true);
  });

  it("un background-image en un style en linea se incrusta; los http externos sin descargar desaparecen", async () => {
    const out = await build('<html><body><div style="background-image:url(/b.png);color:red">x</div><div style="background:url(https://nope.example.org/z.png)">y</div></body></html>', {
      "https://sitio.example.com/b.png": { mime: "image/png", bytes: PNG_1X1 },
    });
    expect(out.html).toContain("color:red");
    expect(out.html).not.toContain("nope.example.org");
    expect(() => assertClean(out.html)).not.toThrow();
  });

  it("una pagina vacia que depende de JavaScript avisa de poco contenido", async () => {
    const out = await build('<html><body><div id="root"></div><script src="/app.js"></script></body></html>');
    expect(out.notes).toEqual(expect.arrayContaining([{ code: "little-content" }, { code: "scripts-ignored", count: 1 }]));
  });

  it("<base href> se respeta SOLO para resolver relativas", async () => {
    const log: string[] = [];
    const out = await build('<html><head><base href="https://otro.example.net/dir/"></head><body><img src="a.png"></body></html>', {}, log);
    expect(log).toEqual(["https://otro.example.net/dir/a.png"]);
    expect(inspect(out.html).tags).not.toContain("base");
  });

  it("un arbol anidado a miles de niveles no revienta ni se cuelga", async () => {
    const deep = "<div>".repeat(5000) + "x" + "</div>".repeat(5000);
    const out = await build(`<html><body>${deep}</body></html>`);
    expect(out.html.length).toBeGreaterThan(0);
  });
});

describe("helpers", () => {
  it("parseSrcset / chooseSrcsetCandidate", () => {
    expect(parseSrcset("a.png 1x, b.png 2x")).toEqual([
      { url: "a.png", score: 800 },
      { url: "b.png", score: 1600 },
    ]);
    expect(parseSrcset("data:image/png;base64,AAA,BBB 100w, /x.png 200w").map((c) => c.score)).toEqual([100, 200]);
    expect(chooseSrcsetCandidate(parseSrcset("a 400w, b 1200w, c 3000w"))).toBe("b");
    expect(chooseSrcsetCandidate(parseSrcset("a 3000w, b 4000w"))).toBe("a");
    expect(chooseSrcsetCandidate([])).toBeNull();
  });

  it("validateImageBytes comprueba la firma de bytes", () => {
    expect(validateImageBytes("image/png", PNG_1X1)).toBe("image/png");
    expect(validateImageBytes("image/png", JPEG)).toBeNull();
    expect(validateImageBytes("image/jpeg", JPEG)).toBe("image/jpeg");
    expect(validateImageBytes("image/gif", GIF)).toBe("image/gif");
    expect(validateImageBytes("image/tiff", PNG_1X1)).toBeNull();
    expect(validateImageBytes("image/png", new Uint8Array())).toBeNull();
  });

  it("normalizeInlineDataUri reescribe en base64 y rechaza lo que no es imagen o es un SVG hostil", () => {
    const png = `data:image/png;base64,${PNG_1X1.toString("base64")}`;
    expect(normalizeInlineDataUri(png)).toBe(png);
    expect(normalizeInlineDataUri("data:text/html;base64,PGI+")).toBeNull();
    expect(normalizeInlineDataUri("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10'%3E%3Crect/%3E%3C/svg%3E")).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(normalizeInlineDataUri("data:image/svg+xml,%3Csvg%3E%3Cscript%3Ealert(1)%3C/script%3E%3C/svg%3E")).toBeNull();
    expect(normalizeInlineDataUri("data:image/png;base64,AAAA")).toBeNull(); // no es un PNG de verdad
  });
});
