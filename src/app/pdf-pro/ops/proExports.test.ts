import { afterEach, describe, expect, it } from "vitest";
import { __resetProExportsForTests, getProExports, registerProExport } from "@/app/pdf-pro/ops/proExports";

/** Registro de exportaciones de «Convertir»: dos marcadores y un punto de extension para U8. */

afterEach(() => __resetProExportsForTests());

describe("proExports", () => {
  it("trae los marcadores de imagenes y texto, en ese orden, enlazados a su herramienta suelta", () => {
    expect(getProExports().map((entry) => [entry.id, entry.slug])).toEqual([
      ["images", "pdf-to-jpg"],
      ["text", "pdf-to-text"],
    ]);
  });

  it("los textos salen en ambos idiomas y son distintos", () => {
    for (const entry of getProExports()) {
      expect(entry.title("es")).not.toBe(entry.title("en"));
      expect(entry.body("es").length).toBeGreaterThan(3);
    }
  });

  it("los marcadores no tienen `run` (aun) y no piden red", () => {
    for (const entry of getProExports()) {
      expect(entry.run).toBeUndefined();
      expect(entry.requiresNetwork).toBe(false);
    }
  });

  it("registrar con la misma id REEMPLAZA el marcador sin cambiar su posicion", () => {
    const run = async () => ({ blob: new Blob(["x"]), filename: "x.png" });
    const original = getProExports()[0];
    registerProExport({ ...original, run });
    const after = getProExports();
    expect(after.map((entry) => entry.id)).toEqual(["images", "text"]);
    expect(after[0].run).toBe(run);
  });

  it("registrar una id nueva la anade al final", () => {
    registerProExport({ id: "word", title: () => "Word", body: () => "docx", slug: "pdf-to-word", requiresNetwork: true });
    expect(getProExports().map((entry) => entry.id)).toEqual(["images", "text", "word"]);
    expect(getProExports()[2].requiresNetwork).toBe(true);
  });

  it("el reinicio de pruebas deja el registro como al cargar", () => {
    registerProExport({ id: "word", title: () => "W", body: () => "d", slug: "pdf-to-word", requiresNetwork: true });
    __resetProExportsForTests();
    expect(getProExports()).toHaveLength(2);
  });
});
