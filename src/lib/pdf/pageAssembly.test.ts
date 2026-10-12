import { describe, expect, it } from "vitest";
import { PDFDocument, degrees } from "@cantoo/pdf-lib";
import {
  PAGE_ASSEMBLY_LIMITS,
  applyPageAssembly,
  countAddedPages,
  entryVisualSize,
  externalPdfIds,
  identityPlan,
  isIdentityPlan,
  preservesPageLabels,
  readPageInfo,
  type PageEntry,
} from "@/lib/pdf/pageAssembly";
import {
  TINY_PNG,
  inspectPdf,
  makeRichPdf,
  marker,
  pageWidthOf,
} from "@/lib/pdf/testing/pageAssemblyFixtures";
import { buildEncryptedPdf } from "@/lib/pdf/testing/inputFixtures";

const existing = (sourceIndex: number, rotation = 0, copy = false): PageEntry => ({
  kind: "existing",
  sourceIndex,
  rotation,
  ...(copy ? { copy: true } : {}),
});

function markersOf(report: Awaited<ReturnType<typeof inspectPdf>>): number[] {
  return report.markers.map((m) => Number(m?.slice(-4)) - 1);
}

describe("applyPageAssembly: plan identidad y orden", () => {
  it("un plan identidad devuelve el mismo numero de paginas, en orden", async () => {
    const bytes = await makeRichPdf({ pages: 5 });
    const result = await applyPageAssembly(bytes, identityPlan(5));
    const report = await inspectPdf(result.bytes);
    expect(result.pageCount).toBe(5);
    expect(markersOf(report)).toEqual([0, 1, 2, 3, 4]);
    expect(result.warnings).toEqual([]);
  });

  it("reordena segun el plan", async () => {
    const bytes = await makeRichPdf({ pages: 5 });
    const plan = [existing(4), existing(2), existing(0), existing(1), existing(3)];
    const report = await inspectPdf((await applyPageAssembly(bytes, plan)).bytes);
    expect(markersOf(report)).toEqual([4, 2, 0, 1, 3]);
    expect(report.widths).toEqual([304, 302, 300, 301, 303]);
  });

  it("invertir el orden de 20 paginas conserva cada una", async () => {
    const bytes = await makeRichPdf({ pages: 20 });
    const plan = identityPlan(20).reverse();
    const report = await inspectPdf((await applyPageAssembly(bytes, plan)).bytes);
    expect(markersOf(report)).toEqual(Array.from({ length: 20 }, (_, i) => 19 - i));
  });

  it("elimina las paginas que no estan en el plan", async () => {
    const bytes = await makeRichPdf({ pages: 6 });
    const plan = [existing(0), existing(3), existing(5)];
    const report = await inspectPdf((await applyPageAssembly(bytes, plan)).bytes);
    expect(markersOf(report)).toEqual([0, 3, 5]);
    expect(report.pageObjects).toBe(3);
  });

  it("un plan vacio es un error `empty`, nunca documento intacto", async () => {
    const bytes = await makeRichPdf({ pages: 3 });
    await expect(applyPageAssembly(bytes, [])).rejects.toMatchObject({ code: "empty" });
  });

  it("una pagina inexistente es un error `invalidConfig` (no se salta en silencio)", async () => {
    const bytes = await makeRichPdf({ pages: 3 });
    await expect(applyPageAssembly(bytes, [existing(0), existing(3)])).rejects.toMatchObject({
      code: "invalidConfig",
    });
    await expect(applyPageAssembly(bytes, [existing(-1)])).rejects.toMatchObject({ code: "invalidConfig" });
    await expect(applyPageAssembly(bytes, [existing(1.5)])).rejects.toMatchObject({ code: "invalidConfig" });
  });

  it("no toca los bytes de entrada", async () => {
    const bytes = await makeRichPdf({ pages: 4 });
    const copy = bytes.slice();
    await applyPageAssembly(bytes, [existing(3), existing(1)]);
    expect(bytes).toEqual(copy);
  });

  it("devuelve un PDF valido que carga de nuevo", async () => {
    const bytes = await makeRichPdf({ pages: 4 });
    const result = await applyPageAssembly(bytes, [existing(2), existing(0)]);
    const loaded = await PDFDocument.load(result.bytes);
    expect(loaded.getPageCount()).toBe(2);
  });
});

describe("applyPageAssembly: rotacion aditiva", () => {
  it("suma sobre la rotacion que ya traia la hoja (90 + 90 = 180)", async () => {
    const bytes = await makeRichPdf({ pages: 3, rotations: { 1: 90 } });
    const plan = [existing(0, 90), existing(1, 90), existing(2)];
    const report = await inspectPdf((await applyPageAssembly(bytes, plan)).bytes);
    expect(report.rotations).toEqual([90, 180, 0]);
  });

  it("rotar a la izquierda (-90) desde 0 deja 270", async () => {
    const bytes = await makeRichPdf({ pages: 2 });
    const report = await inspectPdf((await applyPageAssembly(bytes, [existing(0, -90), existing(1, 270)])).bytes);
    expect(report.rotations).toEqual([270, 270]);
  });

  it("una vuelta completa (360) no cambia nada", async () => {
    const bytes = await makeRichPdf({ pages: 2, rotations: { 0: 90 } });
    const report = await inspectPdf((await applyPageAssembly(bytes, [existing(0, 360), existing(1)])).bytes);
    expect(report.rotations).toEqual([90, 0]);
  });

  it("180 sobre una hoja a 270 da 90", async () => {
    const bytes = await makeRichPdf({ pages: 1, rotations: { 0: 270 } });
    const report = await inspectPdf((await applyPageAssembly(bytes, [existing(0, 180)])).bytes);
    expect(report.rotations).toEqual([90]);
  });

  it("la rotacion es por entrada: una pagina duplicada gira distinto que la original", async () => {
    const bytes = await makeRichPdf({ pages: 1 });
    const plan = [existing(0, 90), existing(0, 270, true)];
    const report = await inspectPdf((await applyPageAssembly(bytes, plan)).bytes);
    expect(report.rotations).toEqual([90, 270]);
  });

  it("hereda la rotacion del arbol de paginas y la suma", async () => {
    const bytes = await makeRichPdf({ pages: 3, inheritedBoxes: { rotate: 90 } });
    const before = await inspectPdf(bytes);
    expect(before.rotations).toEqual([90, 90, 90]);
    const plan = [existing(2), existing(0, 90), existing(1)];
    const report = await inspectPdf((await applyPageAssembly(bytes, plan)).bytes);
    expect(report.rotations).toEqual([90, 180, 90]);
  });

  it("conserva el tamano heredado (MediaBox del nodo raiz) al aplanar el arbol", async () => {
    const bytes = await makeRichPdf({ pages: 3, inheritedBoxes: { rotate: 0 } });
    const report = await inspectPdf((await applyPageAssembly(bytes, [existing(2), existing(1)])).bytes);
    expect(report.widths).toEqual([300, 300]);
  });

  it("un arbol de paginas de dos niveles queda con las paginas en el orden pedido", async () => {
    const bytes = await makeRichPdf({ pages: 7, treeGroups: 3 });
    const plan = [existing(6), existing(0), existing(3), existing(4)];
    const report = await inspectPdf((await applyPageAssembly(bytes, plan)).bytes);
    expect(markersOf(report)).toEqual([6, 0, 3, 4]);
    expect(report.pageObjects).toBe(4);
  });

  it("conserva el CropBox de cada pagina", async () => {
    const bytes = await makeRichPdf({ pages: 3, cropBoxes: { 1: [10, 20, 200, 300] } });
    const result = await applyPageAssembly(bytes, [existing(1), existing(0)]);
    const loaded = await PDFDocument.load(result.bytes);
    const crop = loaded.getPage(0).getCropBox();
    expect([crop.x, crop.y, crop.width, crop.height]).toEqual([10, 20, 200, 300]);
  });
});

describe("applyPageAssembly: duplicar", () => {
  it("la copia lleva el mismo contenido que la original", async () => {
    const bytes = await makeRichPdf({ pages: 3 });
    const plan = [existing(0), existing(0, 0, true), existing(1)];
    const report = await inspectPdf((await applyPageAssembly(bytes, plan)).bytes);
    expect(markersOf(report)).toEqual([0, 0, 1]);
    expect(report.pageObjects).toBe(3);
  });

  it("duplicar dos veces la misma pagina da tres hojas distintas", async () => {
    const bytes = await makeRichPdf({ pages: 2 });
    const plan = [existing(1), existing(1, 0, true), existing(1, 0, true), existing(0)];
    const result = await applyPageAssembly(bytes, plan);
    const loaded = await PDFDocument.load(result.bytes);
    const refs = new Set(loaded.getPages().map((page) => page.ref.toString()));
    expect(refs.size).toBe(4);
    expect(markersOf(await inspectPdf(result.bytes))).toEqual([1, 1, 1, 0]);
  });

  it("sin marca `copy`, la segunda aparicion de una pagina tambien es una copia", async () => {
    const bytes = await makeRichPdf({ pages: 2 });
    const plan = [existing(0), existing(1), existing(0)];
    const report = await inspectPdf((await applyPageAssembly(bytes, plan)).bytes);
    expect(markersOf(report)).toEqual([0, 1, 0]);
    expect(report.pageObjects).toBe(3);
  });

  it("si solo queda la copia (la original se quita), la copia sigue siendo valida", async () => {
    const bytes = await makeRichPdf({ pages: 3 });
    const plan = [existing(2, 0, true), existing(1)];
    const report = await inspectPdf((await applyPageAssembly(bytes, plan)).bytes);
    expect(markersOf(report)).toEqual([2, 1]);
  });

  it("la copia comparte el contenido (no duplica el flujo de la pagina)", async () => {
    const bytes = await makeRichPdf({ pages: 1 });
    const single = (await applyPageAssembly(bytes, [existing(0)])).bytes;
    const doubled = (await applyPageAssembly(bytes, [existing(0), existing(0, 0, true)])).bytes;
    // Una hoja mas, pero nada de contenido: crece mucho menos que el doble.
    expect(doubled.length).toBeLessThan(single.length * 1.5);
  });
});

describe("applyPageAssembly: paginas en blanco", () => {
  it("inserta una pagina en blanco del tamano pedido", async () => {
    const bytes = await makeRichPdf({ pages: 2 });
    const plan: PageEntry[] = [
      existing(0),
      { kind: "blank", width: 612, height: 792, rotation: 0 },
      existing(1),
    ];
    const result = await applyPageAssembly(bytes, plan);
    const loaded = await PDFDocument.load(result.bytes);
    expect(loaded.getPageCount()).toBe(3);
    expect(loaded.getPage(1).getSize()).toEqual({ width: 612, height: 792 });
    expect((await inspectPdf(result.bytes)).markers[1]).toBeUndefined();
  });

  it("una pagina en blanco puede girar", async () => {
    const bytes = await makeRichPdf({ pages: 1 });
    const plan: PageEntry[] = [existing(0), { kind: "blank", width: 100, height: 200, rotation: 90 }];
    const report = await inspectPdf((await applyPageAssembly(bytes, plan)).bytes);
    expect(report.rotations).toEqual([0, 90]);
  });

  it("un tamano invalido es `invalidConfig`", async () => {
    const bytes = await makeRichPdf({ pages: 1 });
    const bad: PageEntry[] = [{ kind: "blank", width: 0, height: 100, rotation: 0 }];
    await expect(applyPageAssembly(bytes, bad)).rejects.toMatchObject({ code: "invalidConfig" });
    const nan: PageEntry[] = [{ kind: "blank", width: Number.NaN, height: 100, rotation: 0 }];
    await expect(applyPageAssembly(bytes, nan)).rejects.toMatchObject({ code: "invalidConfig" });
  });

  it("un plan de solo paginas en blanco es valido (se borran todas las originales)", async () => {
    const bytes = await makeRichPdf({ pages: 2 });
    const plan: PageEntry[] = [{ kind: "blank", width: 300, height: 300, rotation: 0 }];
    const result = await applyPageAssembly(bytes, plan);
    expect(result.pageCount).toBe(1);
    expect((await inspectPdf(result.bytes)).pageObjects).toBe(1);
  });
});

describe("applyPageAssembly: paginas de otro PDF", () => {
  it("inserta un rango de paginas de otro documento en medio", async () => {
    const base = await makeRichPdf({ pages: 3 });
    const other = await makeRichPdf({ pages: 4, baseWidth: 500 });
    const plan: PageEntry[] = [
      existing(0),
      { kind: "external", sourceId: "x", sourceIndex: 1, rotation: 0 },
      { kind: "external", sourceId: "x", sourceIndex: 2, rotation: 0 },
      existing(1),
      existing(2),
    ];
    const report = await inspectPdf((await applyPageAssembly(base, plan, { x: other })).bytes);
    expect(report.widths).toEqual([300, 501, 502, 301, 302]);
    expect(report.markers.slice(1, 3)).toEqual([marker(1), marker(2)]);
    expect(report.pageObjects).toBe(5);
  });

  it("acepta un File o un Blob como documento externo", async () => {
    const base = await makeRichPdf({ pages: 1 });
    const other = await makeRichPdf({ pages: 2 });
    const file = new File([other as unknown as BlobPart], "otro.pdf", { type: "application/pdf" });
    const plan: PageEntry[] = [existing(0), { kind: "external", sourceId: "f", sourceIndex: 1, rotation: 0 }];
    const report = await inspectPdf((await applyPageAssembly(base, plan, { f: file })).bytes);
    expect(report.pageCount).toBe(2);
  });

  it("las paginas externas pueden girar y repetirse", async () => {
    const base = await makeRichPdf({ pages: 1 });
    const other = await makeRichPdf({ pages: 2, baseWidth: 700 });
    const plan: PageEntry[] = [
      { kind: "external", sourceId: "x", sourceIndex: 0, rotation: 90 },
      { kind: "external", sourceId: "x", sourceIndex: 0, rotation: 0 },
      existing(0),
    ];
    const report = await inspectPdf((await applyPageAssembly(base, plan, { x: other })).bytes);
    expect(report.rotations).toEqual([90, 0, 0]);
    expect(report.widths).toEqual([700, 700, 300]);
    expect(report.pageObjects).toBe(3);
  });

  it("une varios documentos externos en una sola operacion", async () => {
    const base = await makeRichPdf({ pages: 1 });
    const a = await makeRichPdf({ pages: 2, baseWidth: 400 });
    const b = await makeRichPdf({ pages: 2, baseWidth: 800 });
    const plan: PageEntry[] = [
      existing(0),
      { kind: "external", sourceId: "a", sourceIndex: 0, rotation: 0 },
      { kind: "external", sourceId: "b", sourceIndex: 1, rotation: 0 },
      { kind: "external", sourceId: "a", sourceIndex: 1, rotation: 0 },
    ];
    const report = await inspectPdf((await applyPageAssembly(base, plan, { a, b })).bytes);
    expect(report.widths).toEqual([300, 400, 801, 401]);
  });

  it("una pagina externa fuera de rango es `invalidConfig`", async () => {
    const base = await makeRichPdf({ pages: 1 });
    const other = await makeRichPdf({ pages: 2 });
    const plan: PageEntry[] = [{ kind: "external", sourceId: "x", sourceIndex: 2, rotation: 0 }];
    await expect(applyPageAssembly(base, plan, { x: other })).rejects.toMatchObject({ code: "invalidConfig" });
  });

  it("un documento externo que falta es `invalidConfig`", async () => {
    const base = await makeRichPdf({ pages: 1 });
    const plan: PageEntry[] = [{ kind: "external", sourceId: "falta", sourceIndex: 0, rotation: 0 }];
    await expect(applyPageAssembly(base, plan, {})).rejects.toMatchObject({ code: "invalidConfig" });
  });

  it("un documento externo cifrado lanza `encrypted`", async () => {
    const base = await makeRichPdf({ pages: 1 });
    const encrypted = await buildEncryptedPdf("secreto");
    const plan: PageEntry[] = [existing(0), { kind: "external", sourceId: "x", sourceIndex: 0, rotation: 0 }];
    await expect(applyPageAssembly(base, plan, { x: encrypted })).rejects.toMatchObject({ code: "encrypted" });
  });

  it("un documento externo danado lanza `corrupt`", async () => {
    const base = await makeRichPdf({ pages: 1 });
    const garbage = new TextEncoder().encode("esto no es un pdf");
    const plan: PageEntry[] = [{ kind: "external", sourceId: "x", sourceIndex: 0, rotation: 0 }];
    await expect(applyPageAssembly(base, plan, { x: garbage })).rejects.toMatchObject({ code: "corrupt" });
  });

  it("el documento actual cifrado lanza `encrypted`", async () => {
    const encrypted = await buildEncryptedPdf("secreto");
    await expect(applyPageAssembly(encrypted, [existing(0)])).rejects.toMatchObject({ code: "encrypted" });
  });

  it("la pagina externa hereda el tamano del arbol del otro documento", async () => {
    const base = await makeRichPdf({ pages: 1 });
    const other = await makeRichPdf({ pages: 2, baseWidth: 450, inheritedBoxes: { rotate: 90 } });
    const plan: PageEntry[] = [existing(0), { kind: "external", sourceId: "x", sourceIndex: 1, rotation: 0 }];
    const report = await inspectPdf((await applyPageAssembly(base, plan, { x: other })).bytes);
    expect(report.widths).toEqual([300, 450]);
    expect(report.rotations).toEqual([0, 90]);
  });
});

describe("applyPageAssembly: imagenes como paginas", () => {
  it("inserta una pagina por imagen", async () => {
    const base = await makeRichPdf({ pages: 2 });
    const plan: PageEntry[] = [
      existing(0),
      { kind: "image", sourceId: "img1", rotation: 0 },
      existing(1),
      { kind: "image", sourceId: "img2", rotation: 90 },
    ];
    const result = await applyPageAssembly(base, plan, { img1: TINY_PNG, img2: TINY_PNG });
    const report = await inspectPdf(result.bytes);
    expect(report.pageCount).toBe(4);
    expect(report.rotations).toEqual([0, 0, 0, 90]);
    expect(report.markers[1]).toBeUndefined();
    expect(report.widths[1]).toBeCloseTo(595.28, 1);
  });

  it("respeta el tamano de pagina pedido (Carta)", async () => {
    const base = await makeRichPdf({ pages: 1 });
    const plan: PageEntry[] = [
      existing(0),
      { kind: "image", sourceId: "i", rotation: 0, layout: { pageSize: "letter" } },
    ];
    const loaded = await PDFDocument.load((await applyPageAssembly(base, plan, { i: TINY_PNG })).bytes);
    expect(loaded.getPage(1).getSize()).toEqual({ width: 612, height: 792 });
  });

  it("un archivo que no es imagen lanza `invalidType`", async () => {
    const base = await makeRichPdf({ pages: 1 });
    const plan: PageEntry[] = [{ kind: "image", sourceId: "i", rotation: 0 }];
    await expect(applyPageAssembly(base, plan, { i: new TextEncoder().encode("hola") })).rejects.toMatchObject({
      code: "invalidType",
    });
  });

  it("acepta un Blob de imagen", async () => {
    const base = await makeRichPdf({ pages: 1 });
    const blob = new Blob([TINY_PNG as unknown as BlobPart], { type: "image/png" });
    const plan: PageEntry[] = [existing(0), { kind: "image", sourceId: "i", rotation: 0 }];
    expect((await applyPageAssembly(base, plan, { i: blob })).pageCount).toBe(2);
  });
});

describe("applyPageAssembly: limites", () => {
  it("mas de 10 documentos externos distintos es `tooLarge`", async () => {
    const base = await makeRichPdf({ pages: 1 });
    const other = await makeRichPdf({ pages: 1 });
    const externals: Record<string, Uint8Array> = {};
    const plan: PageEntry[] = [existing(0)];
    for (let i = 0; i < PAGE_ASSEMBLY_LIMITS.maxExternalDocuments + 1; i += 1) {
      externals[`d${i}`] = other;
      plan.push({ kind: "external", sourceId: `d${i}`, sourceIndex: 0, rotation: 0 });
    }
    await expect(applyPageAssembly(base, plan, externals)).rejects.toMatchObject({ code: "tooLarge" });
  });

  it("exactamente 10 documentos externos es valido", async () => {
    const base = await makeRichPdf({ pages: 1 });
    const other = await makeRichPdf({ pages: 1 });
    const externals: Record<string, Uint8Array> = {};
    const plan: PageEntry[] = [existing(0)];
    for (let i = 0; i < PAGE_ASSEMBLY_LIMITS.maxExternalDocuments; i += 1) {
      externals[`d${i}`] = other;
      plan.push({ kind: "external", sourceId: `d${i}`, sourceIndex: 0, rotation: 0 });
    }
    const result = await applyPageAssembly(base, plan, externals);
    expect(result.pageCount).toBe(11);
  });

  it("un documento externo de mas de 100 MB es `tooLarge` (sin leerlo entero)", async () => {
    const base = await makeRichPdf({ pages: 1 });
    const huge = { size: PAGE_ASSEMBLY_LIMITS.maxExternalBytes + 1 } as unknown as Blob;
    const plan: PageEntry[] = [{ kind: "external", sourceId: "x", sourceIndex: 0, rotation: 0 }];
    await expect(applyPageAssembly(base, plan, { x: huge })).rejects.toMatchObject({ code: "tooLarge" });
  });

  it("una imagen de mas de 100 MB es `tooLarge`", async () => {
    const base = await makeRichPdf({ pages: 1 });
    const huge = { size: PAGE_ASSEMBLY_LIMITS.maxExternalBytes + 1 } as unknown as Blob;
    const plan: PageEntry[] = [{ kind: "image", sourceId: "i", rotation: 0 }];
    await expect(applyPageAssembly(base, plan, { i: huge })).rejects.toMatchObject({ code: "tooLarge" });
  });

  it("anadir mas de 500 paginas avisa (`largeInsert`) pero no pierde ninguna", async () => {
    const base = await makeRichPdf({ pages: 1 });
    const plan: PageEntry[] = [existing(0)];
    for (let i = 0; i < PAGE_ASSEMBLY_LIMITS.warnAddedPages + 5; i += 1) {
      plan.push({ kind: "blank", width: 200, height: 200, rotation: 0 });
    }
    const result = await applyPageAssembly(base, plan);
    expect(result.pageCount).toBe(PAGE_ASSEMBLY_LIMITS.warnAddedPages + 6);
    expect(result.warnings).toContainEqual({ code: "largeInsert", count: PAGE_ASSEMBLY_LIMITS.warnAddedPages + 5 });
  });

  it("exactamente 500 paginas anadidas no avisa", async () => {
    const base = await makeRichPdf({ pages: 1 });
    const plan: PageEntry[] = [existing(0)];
    for (let i = 0; i < PAGE_ASSEMBLY_LIMITS.warnAddedPages; i += 1) {
      plan.push({ kind: "blank", width: 200, height: 200, rotation: 0 });
    }
    const result = await applyPageAssembly(base, plan);
    expect(result.warnings.some((w) => w.code === "largeInsert")).toBe(false);
  });

  it("una rotacion no finita es `invalidConfig`", async () => {
    const base = await makeRichPdf({ pages: 1 });
    await expect(applyPageAssembly(base, [existing(0, Number.NaN)])).rejects.toMatchObject({
      code: "invalidConfig",
    });
  });
});

describe("applyPageAssembly: cancelacion y progreso", () => {
  it("una senal ya abortada lanza `cancelled` antes de empezar", async () => {
    const bytes = await makeRichPdf({ pages: 2 });
    const controller = new AbortController();
    controller.abort();
    await expect(
      applyPageAssembly(bytes, identityPlan(2), {}, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("cancelar durante la lectura de un documento externo corta la operacion", async () => {
    const base = await makeRichPdf({ pages: 1 });
    const other = await makeRichPdf({ pages: 1 });
    const controller = new AbortController();
    const slow = {
      size: other.byteLength,
      arrayBuffer: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.abort();
        return other.buffer.slice(other.byteOffset, other.byteOffset + other.byteLength);
      },
    } as unknown as Blob;
    const plan: PageEntry[] = [existing(0), { kind: "external", sourceId: "x", sourceIndex: 0, rotation: 0 }];
    await expect(
      applyPageAssembly(base, plan, { x: slow }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("el progreso crece de forma monotona y termina en 1", async () => {
    const base = await makeRichPdf({ pages: 3 });
    const other = await makeRichPdf({ pages: 2 });
    const values: number[] = [];
    const plan: PageEntry[] = [
      existing(2),
      { kind: "external", sourceId: "x", sourceIndex: 0, rotation: 0 },
      { kind: "image", sourceId: "i", rotation: 0 },
      existing(0),
    ];
    await applyPageAssembly(base, plan, { x: other, i: TINY_PNG }, { onProgress: (v) => values.push(v) });
    expect(values.length).toBeGreaterThan(2);
    for (let i = 1; i < values.length; i += 1) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    expect(values[values.length - 1]).toBe(1);
    expect(values.every((v) => v >= 0 && v <= 1)).toBe(true);
  });
});

describe("applyPageAssembly: nunca perder paginas en silencio (lectura lenta)", () => {
  it("el plan se cumple entero aunque el documento externo se lea despacio", async () => {
    const base = await makeRichPdf({ pages: 3 });
    const other = await makeRichPdf({ pages: 5, baseWidth: 600 });
    const slow = {
      size: other.byteLength,
      arrayBuffer: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return other.buffer.slice(other.byteOffset, other.byteOffset + other.byteLength);
      },
    } as unknown as Blob;
    const plan: PageEntry[] = [
      existing(0),
      ...[0, 1, 2, 3, 4].map((sourceIndex) => ({
        kind: "external" as const,
        sourceId: "lento",
        sourceIndex,
        rotation: 0,
      })),
      existing(2),
    ];
    const result = await applyPageAssembly(base, plan, { lento: slow });
    expect(result.pageCount).toBe(7);
    const report = await inspectPdf(result.bytes);
    expect(report.widths).toEqual([300, 600, 601, 602, 603, 604, 302]);
  });

  it("el recuento de salida siempre coincide con el plan (verificacion de guardado)", async () => {
    const base = await makeRichPdf({ pages: 4, form: true, outline: true, links: true });
    const plans: PageEntry[][] = [
      [existing(3), existing(3, 0, true), existing(0)],
      identityPlan(4),
      [existing(1)],
      [existing(0), { kind: "blank", width: 100, height: 100, rotation: 0 }, existing(3)],
    ];
    for (const plan of plans) {
      const result = await applyPageAssembly(base, plan);
      expect((await PDFDocument.load(result.bytes)).getPageCount()).toBe(plan.length);
      expect(result.pageCount).toBe(plan.length);
    }
  });

  it("con `verify: false` no vuelve a leer el archivo y aun asi es correcto", async () => {
    const base = await makeRichPdf({ pages: 3 });
    const result = await applyPageAssembly(base, [existing(2), existing(0)], {}, { verify: false });
    expect((await PDFDocument.load(result.bytes)).getPageCount()).toBe(2);
  });
});

describe("applyPageAssembly: 500 paginas", () => {
  it("reordena 500 paginas (invertir) y elimina cada 3.ª sin perder ninguna", async () => {
    const base = await makeRichPdf({ pages: 500 });
    const kept = identityPlan(500).filter((_, index) => index % 3 !== 0).reverse();
    const started = performance.now();
    const result = await applyPageAssembly(base, kept);
    const elapsed = performance.now() - started;
    const report = await inspectPdf(result.bytes);
    expect(report.pageCount).toBe(kept.length);
    expect(markersOf(report)).toEqual(kept.map((entry) => (entry.kind === "existing" ? entry.sourceIndex : -1)));
    expect(report.pageObjects).toBe(kept.length);
    expect(elapsed).toBeLessThan(15_000);
  });

  it("duplica y gira en un documento de 500 paginas", async () => {
    const base = await makeRichPdf({ pages: 500 });
    const plan: PageEntry[] = [];
    for (let i = 0; i < 500; i += 1) {
      plan.push(existing(i, i % 4 === 0 ? 90 : 0));
      if (i % 50 === 0) plan.push(existing(i, 0, true));
    }
    const result = await applyPageAssembly(base, plan);
    expect(result.pageCount).toBe(510);
  });
});

describe("lectura de paginas y utilidades de plan", () => {
  it("readPageInfo da tamano visible con la rotacion aplicada", async () => {
    const bytes = await makeRichPdf({ pages: 3, rotations: { 1: 90, 2: 180 } });
    const info = await readPageInfo(bytes);
    expect(info[0]).toEqual({ width: 300, height: 400, rotation: 0 });
    expect(info[1]).toEqual({ width: 400, height: 301, rotation: 90 });
    expect(info[2]).toEqual({ width: 302, height: 400, rotation: 180 });
  });

  it("readPageInfo usa el CropBox si cabe en la hoja, y la hoja si se sale", async () => {
    const bytes = await makeRichPdf({
      pages: 2,
      cropBoxes: { 0: [10, 10, 110, 210], 1: [-50, -50, 5000, 5000] },
    });
    const info = await readPageInfo(bytes);
    expect(info[0]).toEqual({ width: 110, height: 210, rotation: 0 });
    expect(info[1].width).toBe(301);
  });

  it("isIdentityPlan distingue los planes que no cambian nada", () => {
    expect(isIdentityPlan(identityPlan(3), 3)).toBe(true);
    expect(isIdentityPlan(identityPlan(3), 4)).toBe(false);
    expect(isIdentityPlan([existing(1), existing(0)], 2)).toBe(false);
    expect(isIdentityPlan([existing(0, 90), existing(1)], 2)).toBe(false);
    expect(isIdentityPlan([existing(0, 360), existing(1)], 2)).toBe(true);
    expect(isIdentityPlan([existing(0), existing(1, 0, true)], 2)).toBe(false);
  });

  it("countAddedPages cuenta lo que entra de fuera y las copias", () => {
    const plan: PageEntry[] = [
      existing(0),
      existing(0, 0, true),
      existing(1),
      existing(1),
      { kind: "blank", width: 1, height: 1, rotation: 0 },
      { kind: "external", sourceId: "a", sourceIndex: 0, rotation: 0 },
      { kind: "image", sourceId: "i", rotation: 0 },
    ];
    expect(countAddedPages(plan)).toBe(5);
  });

  it("externalPdfIds devuelve los documentos externos en orden de primer uso", () => {
    const plan: PageEntry[] = [
      { kind: "external", sourceId: "b", sourceIndex: 0, rotation: 0 },
      { kind: "image", sourceId: "i", rotation: 0 },
      { kind: "external", sourceId: "a", sourceIndex: 0, rotation: 0 },
      { kind: "external", sourceId: "b", sourceIndex: 1, rotation: 0 },
    ];
    expect(externalPdfIds(plan)).toEqual(["b", "a"]);
  });

  it("preservesPageLabels solo si las primeras paginas siguen en su sitio", () => {
    expect(preservesPageLabels(identityPlan(3), 3)).toBe(true);
    expect(preservesPageLabels([...identityPlan(3), { kind: "blank", width: 1, height: 1, rotation: 0 }], 3)).toBe(true);
    expect(preservesPageLabels([existing(0), existing(1)], 3)).toBe(true);
    expect(preservesPageLabels([existing(1), existing(0)], 2)).toBe(false);
    expect(preservesPageLabels([existing(0), { kind: "blank", width: 1, height: 1, rotation: 0 }, existing(1)], 2)).toBe(false);
  });

  it("entryVisualSize intercambia ancho y alto con 90/270", () => {
    const sizeOf = () => ({ width: 100, height: 200 });
    expect(entryVisualSize(existing(0, 90), sizeOf)).toEqual({ width: 200, height: 100 });
    expect(entryVisualSize(existing(0, 180), sizeOf)).toEqual({ width: 100, height: 200 });
    expect(entryVisualSize({ kind: "blank", width: 10, height: 20, rotation: 270 }, () => null)).toEqual({
      width: 20,
      height: 10,
    });
    expect(entryVisualSize(existing(0), () => null)).toBeNull();
  });

  it("pageWidthOf es la identidad usada por los fixtures", () => {
    expect(pageWidthOf(3)).toBe(303);
    void degrees;
  });
});
