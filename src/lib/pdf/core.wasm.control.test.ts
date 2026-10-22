import { describe, expect, it } from "vitest";
import { buildImagesCorpus } from "@/lib/pdf/extractAssets/__fixtures__/images/corpus";
import { findImageAssets } from "@/lib/pdf/extractAssets/images";
import { openLegacy } from "@/lib/pdf/extractAssets/images.testUtils";

/**
 * CONTROL de U7.0, en su PROPIO archivo: pdf.js guarda el decodificador WASM en estado estatico del modulo (una vez
 * cargado, otra apertura ya no necesita `wasmUrl`), asi que esta prueba solo es honesta en un proceso donde ningun otro
 * documento haya cargado antes el decodificador. Vitest aisla los modulos por archivo.
 *
 * Demuestra QUE arregla la configuracion: sin `wasmUrl` las imagenes JPX y JBIG2 no se decodifican.
 */
describe("sin wasmUrl (lo que ocurria antes de U7.0)", () => {
  it.each(["jpx", "jbig2"])("la imagen %s NO se decodifica y se avisa", async (name) => {
    const entry = (await buildImagesCorpus()).find((item) => item.name === name)!;
    const opened = await openLegacy(entry.bytes, { wasmUrl: null });
    try {
      const result = await findImageAssets(opened.doc, { ops: opened.ops, bytes: entry.bytes });
      expect(result.assets).toHaveLength(0);
      expect(result.warnings.map((warning) => warning.code)).toEqual(["decode-failed"]);
    } finally {
      await opened.close();
    }
  });
});
