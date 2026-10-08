import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * W1-D: la pista de captura ("Listo para capturar", "Mantén firme"...) va SOBRE
 * el video, que puede ser una hoja blanca. Medido en Chromium con la camara
 * falsa (por pixel) y compuesto sobre blanco puro:
 *   - ok con texto verde sobre tinte verde del 20 %: ~2:1
 *   - unknown con texto atenuado (`text-muted-foreground`): 2,7:1 (1,6:1 sobre blanco)
 *   - texto blanco sobre negro al 55-60 %: >= 7,8:1 por pixel y >= 4,7:1 sobre blanco
 * Contrato: el texto de TODOS los tonos es `text-foreground` (que `on-media` fija
 * en blanco en ambos temas) sobre negro translucido; el verde de "ok" solo va en
 * el borde. `HINT_TONE` no se exporta: se lee del codigo fuente y, si el bloque
 * deja de encontrarse, el test falla (no pasa en vacio).
 */
const SOURCE = readFileSync(new URL("./CameraStage.tsx", import.meta.url), "utf8");
const BLOCK =
  /const HINT_TONE: Record<CaptureHint, string> = \{([\s\S]*?)\n\};/.exec(SOURCE)?.[1] ?? "";
const TONES: Record<string, string> = Object.fromEntries(
  [...BLOCK.matchAll(/^\s*(\w+):\s*"([^"]+)",/gm)].map((match) => [match[1], match[2]]),
);
const tokens = (tone: string) => tone.split(/\s+/);

describe("CameraStage: tonos de la pista de captura", () => {
  it("encuentra los cuatro tonos en el codigo fuente", () => {
    expect(BLOCK).not.toBe("");
    expect(Object.keys(TONES).sort()).toEqual(["hold_steady", "ok", "too_dark", "unknown"]);
  });

  it("el texto de todos los tonos es `text-foreground`: ni verde ni atenuado", () => {
    for (const [name, tone] of Object.entries(TONES)) {
      expect(tokens(tone), name).toContain("text-foreground");
      expect(tone, name).not.toMatch(/text-(success|muted-foreground|signal|destructive)/);
    }
  });

  it("el fondo es negro translucido (55-60 %) sin tinte de color; el verde de `ok` queda en el borde", () => {
    for (const [name, tone] of Object.entries(TONES)) {
      expect(tone, name).toMatch(/(^|\s)bg-black\/(55|60)(\s|$)/);
      expect(tone, name).not.toMatch(/bg-(success|signal|destructive)/);
    }
    expect(tokens(TONES.ok)).toContain("border-success/60");
  });

  it("el chip declara `on-media` (paleta clara del texto en ambos temas) junto al tono", () => {
    expect(SOURCE).toMatch(/"on-media [^"]*",\s*\n\s*HINT_TONE\[hint\]/);
  });
});
