import { describe, expect, it } from "vitest";
import { assertClean, buildSnapshot, type FetchedResource, type ResourceFetcher } from "@/lib/htmlSnapshot/buildSnapshot";
import { SnapshotError } from "@/lib/htmlSnapshot/types";

/**
 * Bateria de la SEGUNDA revision de seguridad (HTML hostil que evadia el pre-escaner y seguia siendo cuadratico, bomba de memoria
 * del algoritmo de elementos de formato, ReDoS en la comprobacion final, escapes tras un salto de formulario, amplificacion de CSS).
 * Cada vector debe terminar (rechazado o aceptado) en MENOS DE 1,5 s y con la memoria acotada. Sin red: el recurso es falso.
 */

const FAST_MS = 1500;
const MAX_RSS_MB = 300;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const rep = (text: string, count: number) => text.repeat(count);
const seq = (make: (index: number) => string, count: number) => {
  let out = "";
  for (let index = 0; index < count; index += 1) out += make(index);
  return out;
};

type Outcome = { ms: number; code: "ok" | string; rssMB: number; html?: string; fetched: string[] };

async function attempt(html: string, resources: (url: string, kind: "css" | "image") => FetchedResource = () => ({ ok: false })): Promise<Outcome> {
  const fetched: string[] = [];
  const fetchResource: ResourceFetcher = async (url, kind) => {
    fetched.push(url);
    return resources(url, kind);
  };
  const baseline = process.memoryUsage().rss;
  const started = Date.now();
  try {
    const result = await buildSnapshot({ html, pageUrl: "http://example.test/", fetchResource, deadline: Date.now() + 10_000 });
    return { ms: Date.now() - started, code: "ok", rssMB: (process.memoryUsage().rss - baseline) / 1e6, html: result.html, fetched };
  } catch (error) {
    return { ms: Date.now() - started, code: error instanceof SnapshotError ? error.code : `otro:${String(error)}`, rssMB: (process.memoryUsage().rss - baseline) / 1e6, fetched };
  }
}

describe("evasiones del pre-escaner: parse5 cuadratico -> corte DESDE DENTRO del analizador", () => {
  const CASES: Array<[string, string]> = [
    ["<div/> x39 000", "<body>" + rep("<div/>", 39_000)],
    ["<!--> + <div> x39 000", "<body><!-->" + rep("<div>", 39_000)],
    ["<!--> + <div> x100 000 (antes 32 s)", "<body><!-->" + rep("<div>", 100_000)],
    ['<a x"> + <div> x39 000', '<body><a x">' + rep("<div>", 39_000)],
    ["<svg><title> + <div> x39 000", "<body><svg><title>" + rep("<div>", 39_000)],
    ["<svg><style> + <div> x39 000", "<body><svg><style>" + rep("<div>", 39_000)],
    ["<div></x> x19 000", "<body>" + rep("<div></x>", 19_000)],
    ["<li><dd><dt> x12 000", "<body><dl>" + rep("<li><dd><dt>", 12_000)],
    ["<ruby> x8 000", "<body>" + rep("<ruby><rb>a<rt>b<rp>c", 8_000)],
    ["<template><div> x12 000", "<body>" + rep("<template><div>", 12_000)],
    ["<table> + <div>x x6 500 con <b> sin cerrar", "<body><table>" + rep("<b i=1>", 600) + rep("<div>", 600) + rep("<td>x</tr>", 12_000)],
  ];
  for (const [label, html] of CASES) {
    it(`${label}: se rechaza (too-large) en menos de 1,5 s`, async () => {
      const outcome = await attempt(html);
      expect(outcome.code).toBe("too-large");
      expect(outcome.ms).toBeLessThan(FAST_MS);
      expect(outcome.rssMB).toBeLessThan(MAX_RSS_MB);
    });
  }
});

describe("bomba de memoria de la lista de elementos de formato activos", () => {
  const BOMBS: Array<[string, string]> = [
    ["<div><b i=N>x</div></x> x9 000 (antes: OOM de 4 GB)", "<body>" + seq((i) => `<div><b i=${i}>x</div></x>`, 9_000)],
    ["<div><b i=N></div></x><p> x8 000", "<body>" + seq((i) => `<div><b i=${i}></div></x><p>`, 8_000)],
    ["<div><font color=cN>x</div></x> x9 000", "<body>" + seq((i) => `<div><font color=c${i}>x</div></x>`, 9_000)],
  ];
  for (const [label, html] of BOMBS) {
    it(`${label}: se corta por elementos creados, con la memoria acotada`, async () => {
      const outcome = await attempt(html);
      expect(outcome.code).toBe("too-large");
      expect(outcome.ms).toBeLessThan(FAST_MS);
      expect(outcome.rssMB).toBeLessThan(MAX_RSS_MB);
    });
  }
});

describe("un <a> no acumula en la lista de formato (un <a> nuevo cierra el anterior)", () => {
  it("<div><a href=hN>x</div></x> x9 000 se procesa rapido (aceptado o cortado) con la memoria acotada", async () => {
    const outcome = await attempt("<body>" + seq((i) => `<div><a href=h${i}>x</div></x>`, 9_000));
    expect(["ok", "too-large"]).toContain(outcome.code);
    expect(outcome.ms).toBeLessThan(FAST_MS);
    expect(outcome.rssMB).toBeLessThan(MAX_RSS_MB);
  });
});

describe("atributos de una etiqueta: el tope no se esquiva con `/` ni con comillas pegadas", () => {
  const attacks: Array<[string, string]> = [
    ["a0/a1/a2/... x120 000 (antes 15 s)", "<body><div " + Array.from({ length: 120_000 }, (_, i) => `a${i}`).join("/") + ">"],
    ['a0="1"a1="1"... x120 000', "<body><div " + Array.from({ length: 120_000 }, (_, i) => `a${i}="1"`).join("") + ">"],
    ["a0=1 a1=1 ... x60 000", "<body><div " + Array.from({ length: 60_000 }, (_, i) => `a${i}=1`).join(" ") + ">"],
    ["etiqueta de CIERRE con 120 000 atributos", "<body></div " + Array.from({ length: 120_000 }, (_, i) => `a${i}`).join("/") + ">"],
    ["oculto tras <!--> (comentario abrupto)", "<body><!--><div " + Array.from({ length: 120_000 }, (_, i) => `a${i}`).join("/") + ">"],
    ["oculto en <svg><style>", "<body><svg><style><div " + Array.from({ length: 120_000 }, (_, i) => `a${i}`).join("/") + ">"],
  ];
  for (const [label, html] of attacks) {
    it(`${label}: se rechaza en menos de 1,5 s`, async () => {
      const outcome = await attempt(html);
      expect(outcome.code).toBe("too-large");
      expect(outcome.ms).toBeLessThan(FAST_MS);
    });
  }
});

describe("ReDoS en la comprobacion final (cssIsSelfContained)", () => {
  const nested = rep("url(#", 40_000); // 200 KB
  it("url(#url(#url(#... en un atributo SVG, en <style>, en style=\"\" y dentro de una cadena: termina rapido", async () => {
    const pages = [
      `<svg><rect fill="${nested}x"/></svg>`,
      `<svg><rect stroke="${nested}x" filter="${nested}x" mask="${nested}x"/></svg>`,
      `<style>a{background:${nested}x}</style><p>x`,
      `<p style='background:${nested}x'>x</p>`,
      `<style>a{content:"${nested}x"}</style><p>x`,
    ];
    for (const html of pages) {
      const outcome = await attempt(html);
      expect(outcome.ms, html.slice(0, 40)).toBeLessThan(FAST_MS);
      expect(outcome.rssMB).toBeLessThan(MAX_RSS_MB);
    }
  });

  it("assertClean directo sobre el peor caso tambien es lineal", () => {
    const started = Date.now();
    for (const html of [`<svg><rect fill="${nested}x"/></svg>`, `<style>${nested}</style>`, `<p style="${nested}">`]) {
      expect(() => assertClean(html)).toThrow(SnapshotError);
    }
    // ... con espacios entre medias y con un `)` lejano
    expect(() => assertClean(`<style>${rep("url(" + " ".repeat(20), 10_000)}</style>`)).toThrow(SnapshotError);
    expect(() => assertClean(`<style>a{b:${rep("url(#", 30_000)}x)}</style>`)).toThrow(SnapshotError);
    expect(Date.now() - started).toBeLessThan(FAST_MS);
  });

  it("lo legitimo sigue pasando: url(#id), data: y mezclas", () => {
    expect(() => assertClean('<svg><rect fill="url(#g)" stroke="url( \'#h\' )"/></svg>')).not.toThrow();
    expect(() => assertClean(`<style>a{background:url("data:image/png;base64,iVBORw0KGgo=")}b{fill:url(#x)}</style>`)).not.toThrow();
    expect(() => assertClean('<p style=\'background:url("data:image/gif;base64,R0lGOD")\'>x</p>')).not.toThrow();
    expect(() => assertClean(`<style>a{background:url("data:image/png;base64,${"url".repeat(5000)}")}</style>`)).not.toThrow();
  });

  it("las comillas y parentesis raros dentro de un url() se rechazan (fallan cerrado)", () => {
    for (const css of ['url(#a url(http://x.example/b.png)', 'url("#a" "http://x.example/b.png")', "url(#a(b)", 'url("data:image/png;base64,AA\')']) {
      expect(() => assertClean(`<style>a{background:${css}}</style>`), css).toThrow(SnapshotError);
    }
  });
});

describe("escapes CSS tras un salto de formulario (U+000C) o un retorno de carro dentro de una cadena", () => {
  const png = (): FetchedResource => ({ ok: true, bytes: PNG, mime: "image/png", contentType: "image/png", url: "http://x.example/a.png" });
  const NEWLINES: Array<[string, string]> = [
    ["U+000C", "\f"],
    ["U+000D", "\r"],
    ["CRLF", "\r\n"],
  ];
  for (const [label, newline] of NEWLINES) {
    it(`${label}: u\\72l( tras la cadena se ve como url( (se pide con TODAS las defensas y se incrusta; nada externo en el resultado)`, async () => {
      const outcome = await attempt(`<style>a{content:"x${newline};background:u\\72l(http://x.example/a.png)}</style><p>x`, png);
      expect(outcome.code).toBe("ok");
      expect(outcome.fetched).toEqual(["http://x.example/a.png"]);
      expect(outcome.html).not.toMatch(/x\.example/);
      expect(outcome.html).toContain("data:image/png;base64,");
    });
  }

  it("tambien \\69mage-set, @\\69mport y en style=\"\" y en atributos SVG", async () => {
    const css = (s: string) => ({
      imageset: `<style>a{content:"x\f;background:\\69mage-set("http://x.example/a.png" 1x)}</style><p>x`,
      importRule: `<style>a{content:"x\f;}@\\69mport "http://x.example/a.css";</style><p>x`,
      attr: `<p style='content:"x\f;background:u\\72l(http://x.example/a.png)'>x</p>`,
      svg: `<svg><rect fill="x\f;u\\72l(http://x.example/a.svg)"/></svg>`,
    })[s as "imageset"];
    for (const key of ["imageset", "importRule", "attr", "svg"]) {
      const outcome = await attempt(css(key), png);
      expect(outcome.html ?? "", key).not.toMatch(/x\.example/);
      expect(outcome.html ?? "", key).not.toMatch(/@import|image-set/);
      expect(["ok", "unreachable"], key).toContain(outcome.code);
    }
  });

  it("un salto de linea normal (\\n) sigue cerrando la cadena como siempre", async () => {
    const outcome = await attempt(`<style>a{content:"x\n;background:u\\72l(http://x.example/a.png)}</style><p>x`, png);
    expect(outcome.fetched).toEqual(["http://x.example/a.png"]);
  });
});

describe("amplificacion de memoria al expandir CSS", () => {
  const sheet = (text: string) => (url: string, kind: "css" | "image"): FetchedResource =>
    kind === "css" ? { ok: true, bytes: new TextEncoder().encode(text), mime: "text/css", contentType: "text/css", url } : { ok: false };
  const links = (count: number) => `<html><head>${Array.from({ length: count }, (_, i) => `<link rel=stylesheet href=s${i}.css>`).join("")}</head><body>x</body></html>`;

  it("10 hojas de 1 MB de `a{b:url(a)}` (antes ~1,3 GB de RSS): too-large rapido y con la memoria acotada", async () => {
    const outcome = await attempt(links(10), sheet(rep("a{b:url(a)}", Math.floor((1024 * 1024) / 11))));
    expect(outcome.code).toBe("too-large");
    expect(outcome.ms).toBeLessThan(FAST_MS);
    expect(outcome.rssMB).toBeLessThan(MAX_RSS_MB);
  });

  it("los <style> en linea y los style=\"\" cuentan en el mismo presupuesto", async () => {
    const outcome = await attempt(`<html><head><style>${rep("a{b:url(a)}", 40_000)}</style><style>${rep("a{b:url(a)}", 40_000)}</style></head><body><p>x</p></body></html>`);
    expect(outcome.code).toBe("too-large");
    const many = await attempt(`<html><body>${rep(`<p style="${rep("b:url(a);", 100)}">x</p>`, 1_500)}</body></html>`);
    expect(many.code).toBe("too-large");
  });

  it("una hoja grande pero normal (1 MB sin url) cabe", async () => {
    const outcome = await attempt(links(1), sheet(rep("a{color:red}", 85_000)));
    expect(outcome.code).toBe("ok");
  });
});

describe("el peor caso ACEPTADO", () => {
  it("99 000 elementos bien formados (el tope es 100 000): se procesa en menos de 1,5 s con la memoria acotada", async () => {
    const outcome = await attempt("<html><body>" + rep("<i>x</i>", 49_500) + rep("<span>y</span>", 49_500) + "</body></html>");
    expect(outcome.code).toBe("ok");
    expect(outcome.ms).toBeLessThan(FAST_MS);
    expect(outcome.rssMB).toBeLessThan(MAX_RSS_MB);
  });

  it("anidado de 690 niveles con 30 000 hijos, p sin cerrar, select y otros casos legitimos pasan", async () => {
    for (const html of [
      "<body>" + rep("<div>", 690) + rep("<span>t</span>", 30_000),
      "<body>" + rep("<p>x", 39_000),
      "<body><select>" + rep("<option>a", 39_000),
      "<body>" + rep("<ul><li>a</li></ul>", 20_000),
    ]) {
      const outcome = await attempt(html);
      expect(outcome.code).toBe("ok");
      expect(outcome.ms).toBeLessThan(FAST_MS);
    }
  });

  it("150 000 elementos (por encima del tope) se rechazan", async () => {
    const outcome = await attempt("<html><body>" + rep("<i>x</i>", 150_000) + "</body></html>");
    expect(outcome.code).toBe("too-large");
  });
});

describe("tercera revision: atributos acumulados en <html>, foster-parenting con muchos hermanos y memoria del escaner de CSS", () => {
  const FAST = 500;

  it('"<html>" + "<html xN>" x30 000 y x60 000 (antes 12,7 s y 56,8 s): se rechaza al instante', async () => {
    for (const count of [30_000, 60_000]) {
      const outcome = await attempt("<html>" + Array.from({ length: count }, (_, i) => `<html x${i.toString(36)}>`).join(""));
      expect(outcome.code).toBe("too-large");
      expect(outcome.ms).toBeLessThan(FAST);
      expect(outcome.rssMB).toBeLessThan(MAX_RSS_MB);
    }
  });

  it("unos pocos <html>/<body> repetidos con atributos (lo normal) siguen pasando", async () => {
    const outcome = await attempt('<html lang=es><html class=a><body id=x><body class=y data-z=1><p>hola</p>');
    expect(outcome.code).toBe("ok");
  });

  it("<!--> x190 000 + <table> + <img> x99 000 (antes 3,6 s): se procesa en menos de 0,5 s", async () => {
    const outcome = await attempt("<body>" + rep("<!-->", 190_000) + "<table>" + rep("<img>", 99_000));
    expect(["ok", "too-large"]).toContain(outcome.code);
    expect(outcome.ms).toBeLessThan(FAST);
    expect(outcome.rssMB).toBeLessThan(MAX_RSS_MB);
  });

  it("variante con texto suelto (foster de texto, antes 2,6 s)", async () => {
    const outcome = await attempt("<body>" + rep("<!-->", 150_000) + "<table>" + rep("x<!--->", 99_000));
    expect(["ok", "too-large"]).toContain(outcome.code);
    expect(outcome.ms).toBeLessThan(FAST);
  });

  it("el foster-parenting sigue colocando el contenido ANTES de la tabla, en orden", async () => {
    const outcome = await attempt("<body><table>texto<b>negrita</b><tr><td>celda</td></tr></table>");
    expect(outcome.code).toBe("ok");
    const html = outcome.html ?? "";
    expect(html.indexOf("texto")).toBeLessThan(html.indexOf("<table"));
    expect(html.indexOf("negrita")).toBeLessThan(html.indexOf("<table"));
    expect(html.indexOf("<table")).toBeLessThan(html.indexOf("celda"));
  });

  it("10 hojas de 1 MiB de `a` + <style> de 1,4 MB de `a` (antes +437 MB): too-large ANTES de escanear, memoria acotada", async () => {
    const links = Array.from({ length: 10 }, (_, i) => `<link rel=stylesheet href=s${i}.css>`).join("");
    const sheet = (url: string, kind: "css" | "image"): FetchedResource =>
      kind === "css" ? { ok: true, bytes: new TextEncoder().encode(rep("a", 1024 * 1024)), mime: "text/css", contentType: "text/css", url } : { ok: false };
    const outcome = await attempt(`${links}<style>${rep("a", 1_400_000)}</style><p>x`, sheet);
    expect(outcome.code).toBe("too-large");
    expect(outcome.ms).toBeLessThan(FAST);
    expect(outcome.rssMB).toBeLessThan(MAX_RSS_MB);
  });

  it("el escaner acumula tramos: 1,4 MB de `a` en UNA hoja (dentro del tope) usa poca memoria y pasa", async () => {
    const outcome = await attempt(`<html><head><style>${rep("a{color:red}", 100_000)}</style></head><body>x</body></html>`);
    expect(outcome.code).toBe("ok");
    expect(outcome.rssMB).toBeLessThan(MAX_RSS_MB);
  });

  it("una imagen que ya sola no cabe en la respuesta no se pasa a base64 y se anota como omitida por tamano", async () => {
    const big = new Uint8Array(3_100_000);
    big.set(PNG);
    const result = await buildSnapshot({
      html: '<html><body><p>x</p><img src="http://x.example/g.png"><img src="http://x.example/p.png"></body></html>',
      pageUrl: "http://example.test/",
      fetchResource: async (url) => ({ ok: true, bytes: url.endsWith("g.png") ? big : PNG, mime: "image/png", contentType: "image/png", url }),
    });
    expect(result.notes.some((note) => note.code === "images-budget")).toBe(true);
    expect((result.html.match(/data:image\/png;base64,/g) ?? []).length).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(result.html))).toBeLessThanOrEqual(4_000_000);
  });
});
