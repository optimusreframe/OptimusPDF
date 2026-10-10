import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/*
 * W6-C · U7: Caveat (la manuscrita de las firmas) solo la usa /sign-pdf, pero
 * `layout.tsx` es el raiz: con `preload` por defecto Next anade un
 * <link rel="preload" as="font"> a TODAS las paginas (74,6 kB de fuente en /,
 * /merge-pdf...). Con `preload: false` el @font-face sigue declarado y el
 * navegador solo descarga el archivo cuando algo renderiza esa familia.
 */
const source = readFileSync(path.resolve(process.cwd(), "src/app/layout.tsx"), "utf8");

function fontCall(name: string): string {
  const start = source.indexOf(`const ${name} = `);
  expect(start, name).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("});", start) + 3);
}

describe("layout.tsx — fuentes", () => {
  it("Caveat no se precarga en cada página y mantiene display swap", () => {
    const call = fontCall("caveat");
    expect(call).toMatch(/preload:\s*false/);
    expect(call).toMatch(/display:\s*"swap"/);
    expect(call).toContain('variable: "--font-caveat"');
  });

  it("JetBrains Mono tampoco se precarga (W1-D)", () => {
    expect(fontCall("jetbrainsMono")).toMatch(/preload:\s*false/);
  });

  it("la variable sigue en <html> (SignatureComposer la lee de la raíz)", () => {
    expect(source).toMatch(/\$\{caveat\.variable\}/);
  });
});
