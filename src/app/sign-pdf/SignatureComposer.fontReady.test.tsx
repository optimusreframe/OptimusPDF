import { afterEach, describe, expect, it } from "vitest";
import { signatureFontReady, unicodeRangeCovers } from "@/app/sign-pdf/SignatureComposer";

/*
 * Safari: `document.fonts.check()` devuelve TRUE mientras la fuente se descarga, y una cara `font-display: swap` que
 * sigue bajando figura como «error» (medido en WebKit 26.5 con el .woff2 retenido 2,5 s: «error» + check true todo el
 * rato y «loaded» al llegar; Chromium da «loading» + check false). `signatureFontReady` ya no se fia solo de `check`:
 * mira ademas las caras de la familia real que cubren el texto.
 */

type FakeFace = { family: string; status: string; unicodeRange: string };

function installFonts(options: { check: boolean; faces: FakeFace[] }): void {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      check: () => options.check,
      load: () => Promise.resolve([]),
      ready: Promise.resolve(),
      [Symbol.iterator]: () => options.faces[Symbol.iterator](),
    },
  });
}

const LATIN = "U+0000-00FF, U+0131, U+0152-0153, U+2000-206F";
const CYRILLIC = "U+0301, U+0400-045F, U+0490-0491";
const SPEC = `96px "Caveat", "Caveat Fallback", cursive`;

afterEach(() => {
  delete (document as unknown as { fonts?: unknown }).fonts;
});

describe("unicodeRangeCovers", () => {
  it("rangos, codigos sueltos y comodines", () => {
    expect(unicodeRangeCovers("U+0000-00FF", "Maria")).toBe(true);
    expect(unicodeRangeCovers("U+0131", "ı")).toBe(true);
    expect(unicodeRangeCovers("U+0400-045F", "Maria")).toBe(false);
    expect(unicodeRangeCovers("U+0400-045F", "Мария")).toBe(true);
    expect(unicodeRangeCovers("U+4??", "ф")).toBe(true); // U+4?? = U+0400-04FF y «ф» es U+0444
    expect(unicodeRangeCovers("U+4??", "A")).toBe(false);
    expect(unicodeRangeCovers("U+0-10FFFF", "A")).toBe(true);
    expect(unicodeRangeCovers("basura", "A")).toBe(false);
    expect(unicodeRangeCovers("U+0000-00FF", "")).toBe(false);
  });
});

describe("signatureFontReady (con un navegador que dice check=true mientras la fuente baja)", () => {
  it("sin la API de fuentes no hay nada que esperar", () => {
    expect(signatureFontReady(SPEC, "Maria")).toBe(true);
  });

  it("check=false: no esta lista (Chromium mientras carga)", () => {
    installFonts({ check: false, faces: [{ family: "Caveat", status: "loading", unicodeRange: LATIN }] });
    expect(signatureFontReady(SPEC, "Maria")).toBe(false);
  });

  it("check=true pero la cara latina que cubre el texto sigue «error» (Safari bajando la fuente): NO esta lista", () => {
    installFonts({
      check: true,
      faces: [
        { family: "Caveat", status: "unloaded", unicodeRange: CYRILLIC },
        { family: "Caveat", status: "error", unicodeRange: LATIN },
      ],
    });
    expect(signatureFontReady(SPEC, "Maria Gonzalez")).toBe(false);
  });

  it("la misma situacion pero con la cara ya cargada: lista (las caras de otros alfabetos sin cargar no cuentan)", () => {
    installFonts({
      check: true,
      faces: [
        { family: "Caveat", status: "unloaded", unicodeRange: CYRILLIC },
        { family: "Caveat", status: "error", unicodeRange: "U+0100-02BA" },
        { family: "Caveat", status: "loaded", unicodeRange: LATIN },
      ],
    });
    expect(signatureFontReady(SPEC, "Maria Gonzalez")).toBe(true);
  });

  it("un texto en cirilico necesita la cara cirilica aunque la latina este cargada", () => {
    installFonts({
      check: true,
      faces: [
        { family: "Caveat", status: "loaded", unicodeRange: LATIN },
        { family: "Caveat", status: "unloaded", unicodeRange: CYRILLIC },
      ],
    });
    expect(signatureFontReady(SPEC, "Мария")).toBe(false);
  });

  it("las caras de OTRAS familias y la de ajuste de metricas no cuentan", () => {
    installFonts({
      check: true,
      faces: [
        { family: "JetBrains Mono", status: "unloaded", unicodeRange: LATIN },
        { family: "Caveat Fallback", status: "error", unicodeRange: LATIN },
        { family: "Caveat", status: "loaded", unicodeRange: LATIN },
      ],
    });
    expect(signatureFontReady(SPEC, "Maria")).toBe(true);
  });

  it("un `document.fonts` que no es iterable (simulaciones y navegadores antiguos) se comporta como antes: manda `check`", () => {
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { check: () => true, load: () => Promise.resolve([]), ready: Promise.resolve() },
    });
    expect(signatureFontReady(SPEC, "Maria")).toBe(true);
  });
});
