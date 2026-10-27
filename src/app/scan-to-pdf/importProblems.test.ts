import { describe, expect, it } from "vitest";
import { blobName, classifyImportFailure, mergeProblems, rejectedFile } from "@/app/scan-to-pdf/importProblems";
import { orientationCounts } from "@/app/scan-to-pdf/scanState";
import { engineNeedsReload, isEngineUnavailableError } from "@/app/scan-to-pdf/scanServices";
import { STRINGS } from "@/app/scan-to-pdf/strings";

const { es, en } = STRINGS;

describe("classifyImportFailure", () => {
  it("HEIC por tipo o por extension", () => {
    expect(classifyImportFailure(new File(["x"], "IMG_1.HEIC", { type: "" }))).toEqual({ name: "IMG_1.HEIC", kind: "heic" });
    expect(classifyImportFailure(new File(["x"], "foto", { type: "image/heif" })).kind).toBe("heic");
  });

  it("lo que no es una imagen", () => {
    expect(classifyImportFailure(new File(["hola"], "nota.txt", { type: "text/plain" }))).toEqual({ name: "nota.txt", kind: "notImage" });
  });

  it("una imagen que no se pudo leer esta danada", () => {
    expect(classifyImportFailure(new File(["no soy un jpeg"], "roto.jpg", { type: "image/jpeg" }))).toEqual({ name: "roto.jpg", kind: "damaged" });
    expect(classifyImportFailure(new File(["x"], "roto.png", { type: "" })).kind).toBe("damaged");
  });

  it("una captura de la camara no tiene nombre", () => {
    expect(blobName(new Blob(["x"], { type: "image/jpeg" }))).toBe("");
    expect(classifyImportFailure(new Blob(["x"], { type: "image/jpeg" }))).toEqual({ name: "", kind: "damaged" });
  });

  it("un archivo rechazado por el filtro nunca es «danado»", () => {
    expect(rejectedFile(new File(["x"], "viejo.bmp", { type: "image/bmp" })).kind).toBe("notImage");
    expect(rejectedFile(new File(["x"], "a.heic", { type: "image/heic" })).kind).toBe("heic");
  });
});

describe("mergeProblems", () => {
  it("no repite el mismo archivo y motivo, pero cuenta cada foto de la camara", () => {
    const a = { name: "a.txt", kind: "notImage" as const };
    expect(mergeProblems([a], [a, { name: "b.txt", kind: "notImage" }])).toHaveLength(2);
    const cam = { name: "", kind: "damaged" as const };
    expect(mergeProblems([cam], [cam])).toHaveLength(2);
  });

  it("tiene un tope", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ name: `f${i}.txt`, kind: "notImage" as const }));
    expect(mergeProblems([], many)).toHaveLength(50);
  });
});

describe("orientationCounts", () => {
  it("cuarto de vuelta = de lado; media vuelta = cabeza abajo", () => {
    expect(orientationCounts({ ids: ["a", "b", "c", "d"], deltas: { a: 90, b: 180, c: 270, d: -90 } })).toEqual({ side: 3, flipped: 1 });
    expect(orientationCounts({ ids: ["a"], deltas: { a: -180 } })).toEqual({ side: 0, flipped: 1 });
  });
});

describe("textos del aviso", () => {
  it("giro: distingue de lado y cabeza abajo con plural correcto", () => {
    expect(es.orientationNotice({ side: 2, flipped: 0 })).toBe("Giramos 2 páginas que estaban de lado.");
    expect(es.orientationNotice({ side: 0, flipped: 1 })).toBe("Giramos 1 página que estaba cabeza abajo.");
    expect(es.orientationNotice({ side: 1, flipped: 2 })).toBe("Giramos 3 páginas: 1 de lado y 2 cabeza abajo.");
    expect(en.orientationNotice({ side: 1, flipped: 0 })).toBe("We rotated 1 page that was sideways.");
    expect(en.orientationNotice({ side: 0, flipped: 3 })).toBe("We rotated 3 pages that were upside down.");
    expect(en.orientationNotice({ side: 2, flipped: 1 })).toBe("We rotated 3 pages: 2 sideways and 1 upside down.");
  });

  it("fotos no anadidas: singular y plural", () => {
    expect(es.importProblems.title(1)).toBe("No se pudo añadir 1 foto");
    expect(es.importProblems.title(3)).toBe("No se pudieron añadir 3 fotos");
    expect(en.importProblems.title(1)).toBe("1 photo could not be added");
    expect(en.importProblems.title(2)).toBe("2 photos could not be added");
    expect(es.said.photoFailed("a.heic", "heic")).toContain("a.heic");
  });
});

describe("motor no disponible", () => {
  it("se reconoce por codigo, por nombre y por los errores tipicos de un chunk que no carga", () => {
    expect(isEngineUnavailableError(Object.assign(new Error("x"), { code: "engine-unavailable" }))).toBe(true);
    expect(isEngineUnavailableError(Object.assign(new Error("x"), { name: "ScanEngineUnavailableError" }))).toBe(true);
    expect(isEngineUnavailableError(new Error("Failed to fetch dynamically imported module: /_next/static/x.js"))).toBe(true);
    expect(isEngineUnavailableError(Object.assign(new Error("Loading chunk 12 failed"), { name: "ChunkLoadError" }))).toBe(true);
    expect(isEngineUnavailableError(new Error("no se pudo decodificar"))).toBe(false);
    expect(isEngineUnavailableError(Object.assign(new Error("x"), { name: "ScanDecodeError" }))).toBe(false);
    expect(isEngineUnavailableError(null)).toBe(false);
  });

  it("una foto cuyo fallo es del motor no se clasifica como danada y guarda la foto para reintentar", () => {
    const file = new File(["x"], "a.jpg", { type: "image/jpeg" });
    expect(classifyImportFailure(file, true)).toEqual({ name: "a.jpg", kind: "engine", blob: file, needsReload: false });
    expect(classifyImportFailure(file, true, true).needsReload).toBe(true);
    expect(classifyImportFailure(file, false).kind).toBe("damaged");
  });

  it("`needsReload` del motor", () => {
    expect(engineNeedsReload(Object.assign(new Error("x"), { needsReload: true }))).toBe(true);
    expect(engineNeedsReload(Object.assign(new Error("x"), { needsReload: false }))).toBe(false);
    expect(engineNeedsReload(new Error("x"))).toBe(false);
    expect(engineNeedsReload(null)).toBe(false);
  });

  it("textos ES y EN", () => {
    expect(es.importProblems.engineUnavailable).toBe("No se pudo cargar el escáner. Revisa tu conexión y vuelve a intentarlo.");
    expect(en.importProblems.engineUnavailable).toContain("Check your connection");
  });
});
