import { describe, expect, it } from "vitest";
import { decodeIdentifierEscapes, escapeForStyleElement, scanCss } from "@/lib/htmlSnapshot/cssScan";

const text = (css: string) => scanCss(css).pieces.filter((p) => p.kind === "text").map((p) => (p as { value: string }).value).join("");

describe("scanCss", () => {
  it("separa url() con y sin comillas y los deja fuera del texto", () => {
    const { pieces } = scanCss('a{background:url(x.png)} b{background:url("y z.png")} c{background:URL( \'w.png\' )}');
    expect(pieces.filter((p) => p.kind === "url").map((p) => p.value)).toEqual(["x.png", "y z.png", "w.png"]);
  });

  it("no confunde una cadena que contiene 'url(' ni un comentario con una referencia", () => {
    const { pieces } = scanCss('/* url(oculto.png) */ a::after{content:"url(no-es-ref.png)"}');
    expect(pieces.some((p) => p.kind === "url")).toBe(false);
    expect(text('/* c */ a{b:c}')).toBe(" a{b:c}");
  });

  it("extrae @import en sus tres formas con su lista de medios", () => {
    const { pieces } = scanCss('@import url("a.css") screen; @import "b.css"; @import url(c.css) print and (min-width:1px); a{}');
    expect(pieces.filter((p) => p.kind === "import")).toEqual([
      { kind: "import", value: "a.css", media: "screen" },
      { kind: "import", value: "b.css", media: "" },
      { kind: "import", value: "c.css", media: "print and (min-width:1px)" },
    ]);
  });

  it("elimina @font-face enteros (y cuenta cuantos)", () => {
    const result = scanCss('@font-face{font-family:X;src:url(x.woff2) format("woff2")} p{color:red} @font-face{src:url("y.woff")}');
    expect(result.fontFaceBlocks).toBe(2);
    expect(result.pieces.some((p) => p.kind === "url")).toBe(false);
    expect(text('@font-face{src:url(x.woff2)} p{color:red}').trim()).toBe("p{color:red}");
  });

  it("image-set y similares pasan a none (no se pueden incrustar)", () => {
    expect(text('a{background:image-set("a.png" 1x, "b.png" 2x)}')).toBe("a{background:none}");
    expect(text("a{background:-webkit-image-set(url(a.png) 1x)}")).toBe("a{background:none}");
  });

  it("un url( sin cerrar descarta el resto en vez de adivinar", () => {
    const { pieces } = scanCss("a{color:red} b{background:url(sin-cerrar.png");
    expect(pieces.some((p) => p.kind === "url")).toBe(false);
  });

  it("quita <!-- y --> y @charset", () => {
    expect(text('@charset "utf-8"; <!-- a{b:c} -->').trim()).toBe("a{b:c}");
  });
});

describe("escapeForStyleElement", () => {
  it("impide cerrar el <style> o abrir un comentario HTML desde el CSS", () => {
    const hostile = 'a{content:"</style><script>alert(1)</script><!--"}';
    const safe = escapeForStyleElement(hostile);
    expect(safe).not.toMatch(/<\/style/i);
    expect(safe).not.toContain("<!--");
    expect(escapeForStyleElement("</STYLE>")).not.toMatch(/<\/style/i);
  });
});

describe("decodeIdentifierEscapes", () => {
  it("decodifica los escapes que escriben una letra (la forma en que se camuflaba url( / @import / image-set()", () => {
    expect(decodeIdentifierEscapes("u\\72l(http://x)")).toBe("url(http://x)");
    expect(decodeIdentifierEscapes("\\75rl(http://x)")).toBe("url(http://x)");
    expect(decodeIdentifierEscapes("\\75 rl(http://x)")).toBe("url(http://x)");
    expect(decodeIdentifierEscapes("\\000075rl(http://x)")).toBe("url(http://x)");
    expect(decodeIdentifierEscapes('@\\69mport "a.css"')).toBe('@import "a.css"');
    expect(decodeIdentifierEscapes("\\69mage-set(a)")).toBe("image-set(a)");
    expect(decodeIdentifierEscapes("\\55\\52\\4c(x)")).toBe("URL(x)");
    expect(decodeIdentifierEscapes("u\\rl(x)")).toBe("url(x)");
    expect(decodeIdentifierEscapes("image\\2d set(x)")).toBe("image-set(x)");
  });

  it("NO toca los escapes de signos ni de digitos (nombres de clase de Tailwind), ni lo que va en cadenas o comentarios", () => {
    for (const same of [".md\\:flex", ".w-1\\/2", ".\\31 0", ".a\\.b", "a{content:\"\\75rl(\"}", "/* \\75rl( */a{}", "a\\{b", ".\\e9 x"]) {
      expect(decodeIdentifierEscapes(same), same).toBe(same);
    }
  });

  it("sin barras invertidas devuelve el mismo texto", () => {
    const css = "a{color:red}";
    expect(decodeIdentifierEscapes(css)).toBe(css);
  });

  it("scanCss ve las referencias camufladas como lo que son", () => {
    const { pieces } = scanCss("a{background:u\\72l(http://x.example/a.png)} @\\69mport 'b.css'; c{background:\\69mage-set(url(d.png) 1x)}");
    expect(pieces.filter((p) => p.kind === "url").map((p) => p.value)).toEqual(["http://x.example/a.png"]);
    expect(pieces.filter((p) => p.kind === "import")).toHaveLength(1);
    expect(pieces.filter((p) => p.kind === "text").map((p) => (p as { value: string }).value).join("")).toContain("background:none");
  });
});
