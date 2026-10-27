import { describe, expect, it } from "vitest";
import { EMPTY_PAGES, SPARSE_PAGES, blankDocument, decodedLikeEngine, sparsePage, textDocument, type BlankKind } from "@/lib/scan/__fixtures__/blurDocs";
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
    { K: 1, sigma: 20, blurry: true },
    // Tan difuminado que no queda ni una celda de tinta: sigue siendo un bloque de luz, NO una hoja en blanco.
    { K: 1, sigma: 30, blurry: true },
    { K: 3, sigma: 90, blurry: true },
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

  for (const kind of ["digital", "gradient"] as BlankKind[]) {
    it(`hoja en blanco (${kind}): en blanco, no casi vacia y no borrosa`, () => {
      const quality = measurePage(decodedLikeEngine(blankDocument(kind)));
      expect(quality.blank).toBe(true);
      expect(quality.sparse).toBe(false);
      expect(quality.blurry).toBe(false);
    });
  }

  // Una pagina con UN trazo (numero de pagina, sello) tiene contenido: NUNCA «en blanco» (quitar las hojas en blanco la borraria);
  // es «casi vacia» y la interfaz pide confirmacion.
  for (const kind of ["page-number", "stamp"] as BlankKind[]) {
    it(`pagina casi vacia (${kind}): casi vacia, NO en blanco y no borrosa`, () => {
      const quality = measurePage(decodedLikeEngine(blankDocument(kind)));
      expect(quality.blank).toBe(false);
      expect(quality.sparse).toBe(true);
      expect(quality.blurry).toBe(false);
    });
  }

  // Informe del verificador: «Quitar hojas en blanco» borraba 12 de 14 paginas con poco contenido. Aqui las 10 con contenido escaso
  // (a 1200 x 1600 y a 3000 x 4000) NUNCA salen en blanco, y las 4 vacias de verdad SI.
  for (const [W, H] of [[1200, 1600], [3000, 4000]] as const) {
    for (const [name, spec] of Object.entries(SPARSE_PAGES)) {
      it(`contenido escaso «${name}» (${W}x${H}): nunca en blanco${spec.sparse ? ", casi vacia" : ", con contenido normal (ni en blanco ni casi vacia)"}`, () => {
        const quality = measurePage(decodedLikeEngine(sparsePage(spec.draw, W, H)));
        expect(quality.blank).toBe(false);
        expect(quality.sparse).toBe(spec.sparse);
      }, 60_000);
    }
    for (const [name, draw] of Object.entries(EMPTY_PAGES)) {
      it(`hoja vacia de verdad «${name}» (${W}x${H}): en blanco y no casi vacia`, () => {
        const quality = measurePage(decodedLikeEngine(sparsePage(draw, W, H)));
        expect(quality.blank).toBe(true);
        expect(quality.sparse).toBe(false);
      }, 60_000);
    }
  }
});
