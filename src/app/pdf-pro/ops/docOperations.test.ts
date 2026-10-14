import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, PDFName, degrees } from "@cantoo/pdf-lib";
import { createProRunner, runOperation } from "@/app/pdf-pro/proAdapter";
import { PRO_OPERATIONS } from "@/app/pdf-pro/proOperations";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import {
  DEFAULT_PRO_CROP_OPTIONS,
  DEFAULT_PRO_ROTATE_OPTIONS,
  DOCUMENT_OPERATIONS,
  compressOperation,
  cropOperation,
  headerFooterOperation,
  metadataOperation,
  ocrOperation,
  pageNumbersOperation,
  referencePageMm,
  repairOperation,
  rotateOperation,
  unlockOperation,
  watermarkOperation,
  type ProCompressReport,
  type ProMetadataOptions,
} from "@/app/pdf-pro/ops/docOperations";
import { EMPTY_METADATA_FORM, formFromInfo } from "@/app/pdf-pro/ops/metadataForm";
import { sameBytes } from "@/app/pdf-pro/ops/opUtils";
import { cropBoxes, infoOf, pageTexts, rotations } from "@/app/pdf-pro/tabs/docTestUtils";
import { DEFAULT_HEADER_FOOTER_OPTIONS } from "@/lib/pdf/headerFooter";
import { DEFAULT_PAGE_NUMBERS_OPTIONS } from "@/lib/pdf/pageNumbers";
import { DEFAULT_WATERMARK_OPTIONS } from "@/lib/pdf/watermark";
import { readMetadata } from "@/lib/pdf/metadata";
import { makePdfBytes } from "@/app/pdf-pro/proTestUtils";

/**
 * Operaciones de documento de PDF Pro con motores REALES: opciones → bytes de salida verificados con
 * pdf-lib y pdf.js. (OCR y la rama de restricciones de firma se prueban con el motor sustituido.)
 */

const ocrMock = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/lib/pdf/ocr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/ocr")>();
  // (Wave 10) la operacion pide los BYTES al motor (`ocrPdfToBytes`), no un Blob: el motor sustituido devuelve `Uint8Array`.
  return { ...actual, ocrPdfToBytes: (...args: unknown[]) => ocrMock.run(...args) };
});

beforeEach(() => {
  ocrMock.run.mockReset();
});

const wm = (text: string) => ({ ...DEFAULT_WATERMARK_OPTIONS, text });
const noMeta = (patch: Partial<ProMetadataOptions>): ProMetadataOptions => ({
  mode: "set",
  form: { ...EMPTY_METADATA_FORM },
  original: null,
  keepXmp: false,
  ...patch,
});

describe("registro", () => {
  it("las nueve operaciones de la U5 estan en PRO_OPERATIONS, con id unico y etiqueta es/en", () => {
    const ids = PRO_OPERATIONS.map((operation) => operation.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const operation of DOCUMENT_OPERATIONS) {
      expect(ids).toContain(operation.id);
      expect(operation.kind).toBe("document");
      for (const language of ["es", "en"] as const) {
        expect(PRO_STRINGS[language].operations[operation.labelKey], `${operation.id}/${language}`).toBeTruthy();
      }
    }
    expect(DOCUMENT_OPERATIONS.map((o) => o.id)).toEqual([
      "watermark", "page-numbers", "header-footer", "crop", "rotate", "metadata", "repair", "ocr", "unlock",
    ]);
  });

  it("todas conservan el numero de paginas salvo reparar", () => {
    for (const operation of [...DOCUMENT_OPERATIONS, compressOperation as never]) {
      expect(Boolean((operation as { preservesPageCount?: boolean }).preservesPageCount), operation.id).toBe(operation.id !== "repair");
    }
  });
});

describe("marca de agua", () => {
  it("estampa el texto en todas las paginas y conserva el recuento", async () => {
    const input = await makePdfBytes(3);
    const outcome = await runOperation(watermarkOperation, input, wm("CONFIDENCIAL"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect((await pageTexts(outcome.bytes)).every((text) => text.includes("CONFIDENCIAL"))).toBe(true);
    expect((await PDFDocument.load(outcome.bytes)).getPageCount()).toBe(3);
  });

  it("respeta el rango y la capa «debajo»", async () => {
    const outcome = await runOperation(watermarkOperation, await makePdfBytes(3), { ...wm("X"), fromPage: 2, toPage: 2, layer: "under" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect((await pageTexts(outcome.bytes)).map((t) => t.includes("X"))).toEqual([false, true, false]);
  });

  it("una marca de imagen sin imagen falla con un error tipado, sin snapshot", async () => {
    const outcome = await runOperation(watermarkOperation, await makePdfBytes(1), { ...DEFAULT_WATERMARK_OPTIONS, kind: "image", image: null });
    expect(outcome.ok).toBe(false);
  });

  it("informa del progreso hasta 1 sin retroceder", async () => {
    const seen: number[] = [];
    await runOperation(watermarkOperation, await makePdfBytes(4), wm("X"), { onProgress: (v) => seen.push(v) });
    expect(seen.at(-1)).toBe(1);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });
});

describe("numerar paginas", () => {
  it("aplica la plantilla, el primer numero y el rango", async () => {
    const outcome = await runOperation(pageNumbersOperation, await makePdfBytes(4), {
      ...DEFAULT_PAGE_NUMBERS_OPTIONS,
      preset: "custom",
      template: "p.{n}/{p}",
      firstNumber: 5,
      fromPage: 2,
      toPage: 3,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const texts = await pageTexts(outcome.bytes);
    expect(texts[0]).not.toContain("p.");
    expect(texts[1]).toContain("p.5/6");
    expect(texts[2]).toContain("p.6/6");
    expect(texts[3]).not.toContain("p.");
  });

  it("el preset de interfaz no llega al PDF", async () => {
    const outcome = await runOperation(pageNumbersOperation, await makePdfBytes(1), { ...DEFAULT_PAGE_NUMBERS_OPTIONS, preset: "pageNofP" });
    expect(outcome.ok).toBe(true);
  });
});

describe("encabezado y pie", () => {
  it("estampa los seis textos y Bates", async () => {
    const outcome = await runOperation(headerFooterOperation, await makePdfBytes(2), {
      ...DEFAULT_HEADER_FOOTER_OPTIONS,
      header: { left: "A", center: "B", right: "C" },
      footer: { left: "{n}", center: "", right: "{bates}" },
      documentName: "d.pdf",
      bates: { prefix: "Z-", start: 9, digits: 3 },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const texts = await pageTexts(outcome.bytes);
    expect(texts[0]).toContain("Z-009");
    expect(texts[1]).toContain("Z-010");
  });

  it("sin texto devuelve «nothingSelected»", async () => {
    const outcome = await runOperation(headerFooterOperation, await makePdfBytes(1), DEFAULT_HEADER_FOOTER_OPTIONS);
    expect(outcome).toMatchObject({ ok: false, code: "nothingSelected" });
  });
});

describe("comprimir (informe medido)", () => {
  it("un PDF sin imagenes no mejora: devuelve los MISMOS bytes, `unchanged` y pesos iguales", async () => {
    const input = await makePdfBytes(2);
    const outcome = await runOperation(compressOperation, input, undefined);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.warnings).toEqual([{ code: "unchanged" }]);
    expect(outcome.bytes).toBe(input);
    const report = outcome.report as ProCompressReport;
    expect(report).toMatchObject({ alreadyOptimized: true, mode: "recompress", originalSize: input.byteLength, compressedSize: input.byteLength });
  });

  it("acepta `undefined` como opciones por defecto (accion rapida)", async () => {
    expect((await runOperation(compressOperation, await makePdfBytes(1), undefined)).ok).toBe(true);
  });
});

describe("recortar", () => {
  it("referencePageMm lee la primera pagina del rango en mm", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 400]);
    doc.addPage([600, 800]);
    const bytes = await doc.save();
    const first = await referencePageMm(bytes, { scope: "all", fromPage: 1, toPage: 0 });
    const second = await referencePageMm(bytes, { scope: "range", fromPage: 2, toPage: 0 });
    expect(first.width).toBeCloseTo((300 * 25.4) / 72, 6);
    expect(second.height).toBeCloseTo((800 * 25.4) / 72, 6);
  });

  it("referencePageMm de una pagina girada usa el tamano VISIBLE", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 400]).setRotation(degrees(90));
    const mm = await referencePageMm(await doc.save(), { scope: "all", fromPage: 1, toPage: 0 });
    expect(mm.width).toBeCloseTo((400 * 25.4) / 72, 6);
  });

  it("25,4 mm en todos los lados quita 72 pt de cada borde", async () => {
    const outcome = await runOperation(cropOperation, await makePdfBytes(2), {
      ...DEFAULT_PRO_CROP_OPTIONS,
      margins: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    for (const box of await cropBoxes(outcome.bytes)) {
      expect(box).toMatchObject({ x: expect.closeTo(72, 3), y: expect.closeTo(72, 3), width: expect.closeTo(156, 3), height: expect.closeTo(256, 3) });
    }
  });

  it("un rango solo recorta esas paginas, proporcionalmente", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 400]);
    doc.addPage([600, 800]);
    const outcome = await runOperation(cropOperation, await doc.save(), {
      ...DEFAULT_PRO_CROP_OPTIONS,
      scope: "range",
      fromPage: 2,
      toPage: 2,
      margins: { top: 0, right: 0, bottom: 0, left: 25.4 },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const [a, b] = await cropBoxes(outcome.bytes);
    expect(a.width).toBeCloseTo(300, 3);
    expect(b.x).toBeCloseTo(72, 3);
    expect(b.width).toBeCloseTo(528, 3);
  });

  it("unos margenes que se comen la pagina fallan con error tipado", async () => {
    const outcome = await runOperation(cropOperation, await makePdfBytes(1), {
      ...DEFAULT_PRO_CROP_OPTIONS,
      margins: { top: 0, right: 0, bottom: 0, left: 300 },
    });
    expect(outcome.ok).toBe(false);
  });

  it("reporta progreso entre 0 y 1", async () => {
    const seen: number[] = [];
    await runOperation(cropOperation, await makePdfBytes(3), DEFAULT_PRO_CROP_OPTIONS, { onProgress: (v) => seen.push(v) });
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(0);
    expect(seen.at(-1)).toBe(1);
  });
});

describe("rotar", () => {
  it("todas: suma sobre la rotacion que ya tenia cada pagina", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 400]);
    doc.addPage([300, 400]).setRotation(degrees(90));
    const outcome = await runOperation(rotateOperation, await doc.save(), { ...DEFAULT_PRO_ROTATE_OPTIONS, angle: 90 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(await rotations(outcome.bytes)).toEqual([90, 180]);
  });

  it("rango + impares + 270°", async () => {
    const outcome = await runOperation(rotateOperation, await makePdfBytes(5), {
      angle: 270,
      scope: "range",
      fromPage: 2,
      toPage: 5,
      parity: "odd",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(await rotations(outcome.bytes)).toEqual([0, 0, 270, 0, 270]);
  });

  it("rango que empieza tras el final se acota a la ultima pagina", async () => {
    const outcome = await runOperation(rotateOperation, await makePdfBytes(3), { angle: 90, scope: "range", fromPage: 9, toPage: 9, parity: "all" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(await rotations(outcome.bytes)).toEqual([0, 0, 90]);
  });
});

describe("reparar", () => {
  it("un PDF sano: mismos bytes y `unchanged`", async () => {
    const input = await makePdfBytes(2);
    const outcome = await runOperation(repairOperation, input, undefined);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.warnings).toEqual([{ code: "unchanged" }]);
    expect(sameBytes(outcome.bytes, input)).toBe(true);
    expect(outcome.pageCount).toBe(2);
  });

  it("un PDF cortado se reconstruye, informa y trae las paginas recuperadas", async () => {
    const input = await makePdfBytes(3);
    const cut = input.slice(0, input.byteLength - 40);
    const outcome = await runOperation(repairOperation, cut, undefined);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.warnings).toEqual([]);
    expect(outcome.pageCount).toBe(3);
    expect((outcome.report as { damage: string[] }).damage.length).toBeGreaterThan(0);
    expect((await PDFDocument.load(outcome.bytes)).getPageCount()).toBe(3);
  });

  it("bytes que no son un PDF fallan con error tipado", async () => {
    const outcome = await runOperation(repairOperation, new TextEncoder().encode("esto no es un pdf"), undefined);
    expect(outcome.ok).toBe(false);
  });
});

describe("OCR (motor sustituido)", () => {
  it("pasa idioma, progreso y senal de cancelacion al motor", async () => {
    const input = await makePdfBytes(1);
    ocrMock.run.mockImplementation(async (_file: File, _options: unknown, onProgress: (v: number) => void) => {
      onProgress(0.5);
      return input;
    });
    const seen: number[] = [];
    const outcome = await runOperation(ocrOperation, input, { language: "eng" }, { onProgress: (v) => seen.push(v) });
    expect(outcome.ok).toBe(true);
    expect(ocrMock.run.mock.calls[0][1]).toEqual({ language: "eng" });
    expect(ocrMock.run.mock.calls[0][3]).toBeInstanceOf(AbortSignal);
    expect(seen).toContain(0.5);
  });

  it("sin opciones usa el espanol por defecto", async () => {
    const input = await makePdfBytes(1);
    ocrMock.run.mockResolvedValue(input);
    await runOperation(ocrOperation, input, undefined);
    expect(ocrMock.run.mock.calls[0][1]).toEqual({ language: "spa" });
  });

  it("cancelar aborta la senal que ve el motor y el resultado tardio se ignora", async () => {
    const input = await makePdfBytes(1);
    let aborted = false;
    ocrMock.run.mockImplementation(
      (_file: File, _options: unknown, _progress: unknown, signal: AbortSignal) =>
        new Promise<Uint8Array>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            setTimeout(() => resolve(input), 10);
          });
        }),
    );
    const runner = createProRunner();
    const pending = runner.run(ocrOperation, input, { language: "spa" });
    await Promise.resolve();
    runner.cancel();
    const outcome = await pending;
    expect(aborted).toBe(true);
    expect(outcome).toMatchObject({ ok: false, cancelled: true, stale: true });
  });

  it("los errores de red del OCR llegan con su codigo claro", async () => {
    const { PdfError } = await import("@/lib/pdf/core");
    ocrMock.run.mockRejectedValue(new PdfError("ocrNetworkFailure"));
    const outcome = await runOperation(ocrOperation, await makePdfBytes(1), { language: "spa" });
    expect(outcome).toMatchObject({ ok: false, code: "ocrNetworkFailure" });
  });
});

describe("metadatos", () => {
  it("editar: solo cambia lo que difiere del documento", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    doc.setTitle("Viejo");
    doc.setAuthor("Autor");
    const input = await doc.save();
    const original = await readMetadata(input);
    const outcome = await runOperation(metadataOperation, input, noMeta({ original, form: { ...formFromInfo(original), title: "Nuevo" } }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const info = await infoOf(outcome.bytes);
    expect(info.Title).toBe("Nuevo");
    expect(info.Author).toBe("Autor");
    expect(outcome.report).toMatchObject({ changed: ["title"], xmpRemoved: false });
  });

  it("sin cambios devuelve `unchanged` y los mismos bytes", async () => {
    const input = await makePdfBytes(1);
    const original = await readMetadata(input);
    const outcome = await runOperation(metadataOperation, input, noMeta({ original, form: formFromInfo(original) }));
    expect(outcome.ok && outcome.warnings).toEqual([{ code: "unchanged" }]);
    expect(outcome.ok && outcome.bytes).toBe(input);
  });

  it("lee el original si el panel no lo trajo", async () => {
    const input = await makePdfBytes(1);
    const outcome = await runOperation(metadataOperation, input, noMeta({ original: null, form: { ...EMPTY_METADATA_FORM, title: "T" } }));
    expect(outcome.ok).toBe(true);
  });

  it("eliminar todos: vacia el Info y avisa del XMP", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    doc.setTitle("Secreto");
    const xmp = doc.context.stream("<x:xmpmeta/>", { Type: "Metadata", Subtype: "XML" });
    doc.catalog.set(PDFName.of("Metadata"), doc.context.register(xmp));
    const outcome = await runOperation(metadataOperation, await doc.save(), noMeta({ mode: "strip" }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report).toMatchObject({ xmpRemoved: true });
    expect(await infoOf(outcome.bytes)).not.toHaveProperty("Title");
  });

  it("eliminar todos sobre un PDF sin metadatos es `unchanged`", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    doc.context.trailerInfo.Info = undefined;
    const input = await doc.save();
    const outcome = await runOperation(metadataOperation, input, noMeta({ mode: "strip" }));
    expect(outcome.ok && outcome.warnings).toEqual([{ code: "unchanged" }]);
  });

  it("conservar el XMP no lo toca", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const xmp = doc.context.stream("<x:xmpmeta/>", { Type: "Metadata", Subtype: "XML" });
    doc.catalog.set(PDFName.of("Metadata"), doc.context.register(xmp));
    const outcome = await runOperation(metadataOperation, await doc.save(), noMeta({ keepXmp: true, form: { ...EMPTY_METADATA_FORM, title: "Nuevo" } }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report).toMatchObject({ xmpRemoved: false });
    expect((await readMetadata(outcome.bytes)).hasXmp).toBe(true);
  });
});

describe("quitar restricciones de firma", () => {
  it("un PDF sin proteccion falla con `notProtected` (nunca un snapshot igual)", async () => {
    const outcome = await runOperation(unlockOperation, await makePdfBytes(1), { password: "", acknowledgeSignatureInvalidation: true, inspected: "restricted" });
    expect(outcome).toMatchObject({ ok: false, code: "notProtected" });
  });
});
