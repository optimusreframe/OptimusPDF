import { describe, expect, it } from "vitest";
import { blankDocument, decodedLikeEngine, textDocument, type BlankKind } from "@/lib/scan/__fixtures__/blurDocs";
import { measurePage } from "@/lib/scan/quality";

/**
 * «Borrosa» y «en blanco» a la resolucion con la que mira el motor (original decodificado a 1280 px; la nitidez se mide a 960):
 * un texto de 12 MP o de 2 MP desenfocado hasta no leerse se marca borroso y NO es una hoja en blanco (quitar las hojas en blanco
 * borraria paginas con contenido); las hojas vacias (digital, con degradado, con numero de pagina o sello) siguen en blanco;
 * los textos nitidos o con desenfoque leve no se marcan.
 */

describe("borrosa / en blanco a la resolucion del motor — src/lib/scan/quality.ts", () => {
  const cases: Array<{ K: number; sigma: number; blurry: boolean }> = [
    { K: 1, sigma: 0, blurry: false },
    { K: 1, sigma: 1.5, blurry: false },
    { K: 1, sigma: 5, blurry: true },
    { K: 1, sigma: 10, blurry: true },
    { K: 2, sigma: 0, blurry: false },
    { K: 2, sigma: 8, blurry: true },
    { K: 3, sigma: 0, blurry: false },
    { K: 3, sigma: 6, blurry: false },
    { K: 3, sigma: 20, blurry: true },
    { K: 3, sigma: 30, blurry: true },
  ];
  for (const { K, sigma, blurry } of cases) {
    it(`texto ${1200 * K}x${1600 * K}, desenfoque ${sigma} px: ${blurry ? "borrosa y NO en blanco" : "nitida, ni borrosa ni en blanco"}`, () => {
      const quality = measurePage(decodedLikeEngine(textDocument(K, sigma)));
      expect(quality.blurry).toBe(blurry);
      expect(quality.blank).toBe(false);
    }, 60_000);
  }

  for (const kind of ["digital", "gradient", "page-number", "stamp"] as BlankKind[]) {
    it(`hoja en blanco (${kind}): en blanco y no borrosa`, () => {
      const quality = measurePage(decodedLikeEngine(blankDocument(kind)));
      expect(quality.blank).toBe(true);
      expect(quality.blurry).toBe(false);
    });
  }
});
