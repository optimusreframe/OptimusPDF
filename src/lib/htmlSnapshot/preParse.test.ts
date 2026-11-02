import { describe, expect, it } from "vitest";
import { checkHtmlComplexity, measureHtmlComplexity } from "@/lib/htmlSnapshot/preParse";
import { SNAPSHOT_LIMITS } from "@/lib/htmlSnapshot/types";

describe("checkHtmlComplexity (filtro barato: etiquetas y atributos por etiqueta)", () => {
  it("una pagina normal pasa", () => {
    expect(checkHtmlComplexity("<!doctype html><html><head><title>x</title></head><body><div><p>hola <b>mundo</b></p><ul><li>a<li>b</ul></div></body></html>")).toBe(true);
  });

  it("tope de etiquetas (aperturas y cierres)", () => {
    expect(checkHtmlComplexity("<span>x</span>".repeat(SNAPSHOT_LIMITS.maxTags / 2 - 1))).toBe(true);
    expect(checkHtmlComplexity("<span>x</span>".repeat(SNAPSHOT_LIMITS.maxTags))).toBe(false);
  });

  it("cuenta los atributos como el TOKENIZADOR: separados por espacio, por `/` y por comillas pegadas", () => {
    const attrs = (separator: (i: number) => string, n: number) => Array.from({ length: n }, (_, i) => separator(i)).join("");
    expect(measureHtmlComplexity(`<div ${attrs((i) => `a${i}=1 `, 10)}>`).maxAttributes).toBe(10);
    expect(measureHtmlComplexity(`<div ${attrs((i) => `a${i}/`, 10)}>`).maxAttributes).toBe(10);
    expect(measureHtmlComplexity(`<div ${attrs((i) => `a${i}="1"`, 10)}>`).maxAttributes).toBe(10);
    expect(measureHtmlComplexity(`<div ${attrs((i) => `a${i}='1'`, 10)}>`).maxAttributes).toBe(10);
    expect(measureHtmlComplexity(`<div ${attrs((i) => `a${i}=x/`, 10)}>`).maxAttributes).toBe(1); // `/` dentro de un valor sin comillas no separa
    // Las comillas solo delimitan justo tras `=`: en un nombre son letras (`a"b` es UN atributo con comillas en el nombre).
    expect(measureHtmlComplexity(`<div a"b c"d>`).maxAttributes).toBe(2);
  });

  it("rechaza 120 000 atributos separados por `/` o por comillas pegadas (se evadia el tope) y por espacios", () => {
    for (const html of [
      `<body><div ${Array.from({ length: 120_000 }, (_, i) => `a${i}`).join("/")}>`,
      `<body><div ${Array.from({ length: 120_000 }, (_, i) => `a${i}="1"`).join("")}>`,
      `<body><div ${Array.from({ length: 60_000 }, (_, i) => `a${i}=1`).join(" ")}>`,
    ]) {
      expect(checkHtmlComplexity(html)).toBe(false);
    }
  });

  it("tope de bytes por etiqueta SIN contar el contenido de los valores entre comillas", () => {
    expect(checkHtmlComplexity(`<img src="data:image/png;base64,${"A".repeat(500_000)}" alt="x">`)).toBe(true);
    expect(checkHtmlComplexity(`<img src=${"A".repeat(20_000)}>`)).toBe(false);
    expect(checkHtmlComplexity(`<div ${" ".repeat(20_000)}>`)).toBe(false);
  });

  it("no se deja engañar: lo que parece comentario/texto pero el tokenizador lee como etiquetas SI se cuenta", () => {
    const many = Array.from({ length: 300 }, (_, i) => `a${i}`).join("/");
    // `<!-->` y `<!--->` son comentarios VACIOS (acaban ahi), `--!>` tambien cierra un comentario.
    expect(checkHtmlComplexity(`<!--><div ${many}>`)).toBe(false);
    expect(checkHtmlComplexity(`<!---><div ${many}>`)).toBe(false);
    expect(checkHtmlComplexity(`<!-- x --!><div ${many}>`)).toBe(false);
    // Dentro de <svg>/<math>, <title>/<style>/<script> NO son texto plano: su contenido es marcado.
    expect(checkHtmlComplexity(`<svg><title><div ${many}>`)).toBe(false);
    expect(checkHtmlComplexity(`<svg><style><div ${many}>`)).toBe(false);
    expect(checkHtmlComplexity(`<math><script><div ${many}>`)).toBe(false);
    // `<a x">` no abre comillas: es un atributo `x"`.
    expect(checkHtmlComplexity(`<a x"><div ${many}>`)).toBe(false);
    // En HTML normal si lo son: ahi el contenido no se lee como etiquetas.
    expect(checkHtmlComplexity(`<title><div ${many}></title>`)).toBe(true);
    expect(checkHtmlComplexity(`<script>if (a < b) { x = "<div ${many}>"; }</script>`)).toBe(true);
  });

  it("un comentario normal oculta lo que hay dentro", () => {
    const many = Array.from({ length: 300 }, (_, i) => `a${i}`).join("/");
    expect(checkHtmlComplexity(`<!-- <div ${many}> -->`)).toBe(true);
  });

  it("un `<` suelto, un `>` dentro de comillas y los cierres con atributos", () => {
    expect(measureHtmlComplexity("<p>a < b y c <3</p>").tags).toBe(2);
    expect(measureHtmlComplexity(`<a title="a > <b> c" href=x>t</a>`).tags).toBe(2);
    const many = Array.from({ length: 300 }, (_, i) => `a${i}`).join("/");
    expect(checkHtmlComplexity(`</div ${many}>`)).toBe(false); // las etiquetas de cierre tambien llevan atributos para el tokenizador
  });

  it("es lineal: 1,4 MB de basura se mide en milisegundos", () => {
    const started = Date.now();
    measureHtmlComplexity("<div ".repeat(100_000) + "x".repeat(900_000));
    measureHtmlComplexity("<<<<<<<<".repeat(150_000));
    measureHtmlComplexity("<!--".repeat(300_000));
    measureHtmlComplexity('<a x="'.repeat(200_000));
    expect(Date.now() - started).toBeLessThan(800);
  });
});
