import { describe, expect, it } from "vitest";
import { DOC_TOOLS, getDocTool } from "@/app/pdf-pro/tabs/docToolDefinitions";
import { DOC_TOOL_IDS, DOC_TOOLS_STRINGS } from "@/app/pdf-pro/tabs/docToolsStrings";
import type { DocToolContext } from "@/app/pdf-pro/tabs/docToolTypes";
import { EMPTY_METADATA_FORM } from "@/app/pdf-pro/ops/metadataForm";
import { PRO_OPERATIONS } from "@/app/pdf-pro/proOperations";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { makePdfBytes } from "@/app/pdf-pro/proTestUtils";
import type { ProMetadataOptions, ProRotateOptions, ProCropOptions, ProUnlockOptions } from "@/app/pdf-pro/ops/docOperations";
import type { WatermarkOptions } from "@/lib/pdf/watermark";
import type { HeaderFooterOptions } from "@/lib/pdf/headerFooter";
import type { PageNumbersToolOptions } from "@/app/add-page-numbers/PageNumbersOptionsPanel";
import type { OcrOptions } from "@/lib/pdf/ocr";
import type { CompressOptions } from "@/lib/pdf/compress";
import type { PdfMetadataInfo } from "@/lib/pdf/metadata";

/** Registro de herramientas de documento: defaults, `canRun` con motivo, etiquetas del snapshot y vista previa. */

let bytes: Uint8Array;

async function ctx(patch: Partial<DocToolContext> = {}): Promise<DocToolContext> {
  bytes ??= await makePdfBytes(3);
  return {
    language: "es",
    fileName: "informe.pdf",
    pageCount: 3,
    byteLength: bytes.byteLength,
    bytes,
    snapshotId: "snap-1",
    signatures: "none",
    wasEncrypted: false,
    firstPage: { width: 105.83, height: 141.11 },
    ...patch,
  };
}

const tool = <T,>(id: Parameters<typeof getDocTool>[0]) => getDocTool(id) as unknown as import("@/app/pdf-pro/tabs/docToolTypes").DocToolDefinition<T>;

describe("registro", () => {
  it("hay una herramienta por id, en el orden de la interfaz, y cada una con operacion registrada", () => {
    expect(DOC_TOOLS.map((t) => t.id)).toEqual([
      "watermark", "page-numbers", "header-footer", "compress", "crop", "rotate", "metadata", "repair", "ocr", "unlock",
    ]);
    expect([...DOC_TOOL_IDS].sort()).toEqual(DOC_TOOLS.map((t) => t.id).sort());
    for (const t of DOC_TOOLS) expect(PRO_OPERATIONS).toContain(t.operation);
  });

  it("Quitar proteccion va en la pestaña Proteger; las demas en Inicio", () => {
    expect(DOC_TOOLS.filter((t) => t.tab === "protect").map((t) => t.id)).toEqual(["unlock"]);
    expect(DOC_TOOLS.filter((t) => t.tab === "home")).toHaveLength(9);
  });

  it("solo OCR necesita red", () => {
    expect(DOC_TOOLS.filter((t) => t.needsNetwork).map((t) => t.id)).toEqual(["ocr"]);
  });

  it("getDocTool lanza con una id desconocida", () => {
    expect(() => getDocTool("nada" as never)).toThrow();
  });

  it("cada herramienta tiene titulo y descripcion en es y en", () => {
    for (const id of DOC_TOOL_IDS) {
      for (const language of ["es", "en"] as const) {
        const text = DOC_TOOLS_STRINGS[language].tools[id];
        expect(text.title.length).toBeGreaterThan(2);
        expect(text.description.length).toBeGreaterThan(10);
      }
      expect(DOC_TOOLS_STRINGS.es.tools[id].title).not.toBe(DOC_TOOLS_STRINGS.en.tools[id].title);
    }
  });
});

describe("opciones iniciales", () => {
  it("marca de agua arranca con un texto real (sin estado vacio) segun el idioma", async () => {
    expect(tool<WatermarkOptions>("watermark").defaults(await ctx()).text).toBe("CONFIDENCIAL");
    expect(tool<WatermarkOptions>("watermark").defaults(await ctx({ language: "en" })).text).toBe("CONFIDENTIAL");
  });

  it("encabezado y pie arranca con «Página n de p» al pie y el nombre del archivo", async () => {
    const options = tool<HeaderFooterOptions>("header-footer").defaults(await ctx());
    expect(options.footer.center).toBe("Página {n} de {p}");
    expect(options.documentName).toBe("informe.pdf");
    expect(options.header).toEqual({ left: "", center: "", right: "" });
    expect(tool<HeaderFooterOptions>("header-footer").defaults(await ctx({ language: "en" })).footer.center).toBe("Page {n} of {p}");
  });

  it("OCR elige el idioma de la interfaz; las demas tienen valores seguros", async () => {
    expect(tool<OcrOptions>("ocr").defaults(await ctx()).language).toBe("spa");
    expect(tool<OcrOptions>("ocr").defaults(await ctx({ language: "en" })).language).toBe("eng");
    expect(tool<CompressOptions>("compress").defaults(await ctx())).toEqual({ level: "recommended", mode: "recompress" });
    expect(tool<ProCropOptions>("crop").defaults(await ctx())).toMatchObject({ linked: true, scope: "all", margins: { top: 10, left: 10 } });
    expect(tool<ProRotateOptions>("rotate").defaults(await ctx())).toMatchObject({ angle: 90, scope: "all" });
  });

  it("las opciones por defecto de recorte no comparten el objeto de margenes entre usos", async () => {
    const a = tool<ProCropOptions>("crop").defaults(await ctx());
    const b = tool<ProCropOptions>("crop").defaults(await ctx());
    expect(a.margins).not.toBe(b.margins);
  });
});

describe("canRun con motivo", () => {
  it("marca de agua: texto vacio y rango fuera del documento", async () => {
    const t = tool<WatermarkOptions>("watermark");
    const c = await ctx();
    const base = t.defaults(c);
    expect(t.canRun(base, c)).toEqual({ ok: true });
    expect(t.canRun({ ...base, text: "" }, c)).toMatchObject({ ok: false });
    expect(t.canRun({ ...base, fromPage: 9 }, c)).toEqual({ ok: false, reason: PRO_STRINGS.es.docTools.runner.rangeBeyond });
  });

  it("el rango fuera del documento se explica tambien en ingles", async () => {
    const t = tool<PageNumbersToolOptions>("page-numbers");
    const c = await ctx({ language: "en" });
    expect(t.canRun({ ...t.defaults(c), fromPage: 40 }, c)).toEqual({ ok: false, reason: PRO_STRINGS.en.docTools.runner.rangeBeyond });
  });

  it("encabezado y pie: sin texto, motivo", async () => {
    const t = tool<HeaderFooterOptions>("header-footer");
    const c = await ctx();
    const base = t.defaults(c);
    expect(t.canRun(base, c)).toEqual({ ok: true });
    expect(t.canRun({ ...base, footer: { left: "", center: "", right: "" } }, c)).toEqual({
      ok: false,
      reason: PRO_STRINGS.es.docTools.headerFooter.nothingToStamp,
    });
  });

  it("recortar: sin margenes, margenes que dejan < 3 % y rango fuera", async () => {
    const t = tool<ProCropOptions>("crop");
    const c = await ctx();
    const base = t.defaults(c);
    const s = PRO_STRINGS.es.docTools.crop;
    expect(t.canRun(base, c)).toEqual({ ok: true });
    expect(t.canRun({ ...base, margins: { top: 0, right: 0, bottom: 0, left: 0 } }, c)).toEqual({ ok: false, reason: s.nothingToCrop });
    expect(t.canRun({ ...base, margins: { top: 0, right: 0, bottom: 0, left: 104 } }, c)).toEqual({ ok: false, reason: s.tooSmall });
    expect(t.canRun({ ...base, scope: "range", fromPage: 7 }, c)).toMatchObject({ ok: false });
  });

  it("recortar sin medidas conocidas todavia no inventa el limite del 3 %", async () => {
    const t = tool<ProCropOptions>("crop");
    const c = await ctx({ firstPage: null });
    expect(t.canRun({ ...t.defaults(c), margins: { top: 0, right: 0, bottom: 0, left: 9999 } }, c)).toEqual({ ok: true });
  });

  it("rotar: un rango sin paginas seleccionadas (paridad) se explica", async () => {
    const t = tool<ProRotateOptions>("rotate");
    const c = await ctx();
    const base = t.defaults(c);
    expect(t.canRun(base, c)).toEqual({ ok: true });
    expect(t.canRun({ ...base, scope: "range", fromPage: 2, toPage: 2, parity: "odd" }, c)).toEqual({
      ok: false,
      reason: PRO_STRINGS.es.docTools.rotate.nothingSelected,
    });
    expect(t.canRun({ ...base, scope: "range", fromPage: 1, toPage: 3, parity: "odd" }, c)).toEqual({ ok: true });
  });

  it("metadatos: sin leer, sin cambios, con cambio y «eliminar» sobre un PDF sin datos", async () => {
    const t = tool<ProMetadataOptions>("metadata");
    const c = await ctx();
    const s = PRO_STRINGS.es.docTools.metadata;
    const info: PdfMetadataInfo = { ...EMPTY_METADATA_FORM, creationDate: null, modificationDate: null, hasXmp: false, customKeys: [] };
    const base = t.defaults(c);
    expect(t.canRun(base, c)).toEqual({ ok: false, reason: s.loading });
    expect(t.canRun({ ...base, original: info }, c)).toEqual({ ok: false, reason: s.nothingChanged });
    expect(t.canRun({ ...base, original: info, form: { ...base.form, title: "x" } }, c)).toEqual({ ok: true });
    expect(t.canRun({ ...base, original: info, mode: "strip" }, c)).toEqual({ ok: false, reason: s.stripNothing });
    expect(t.canRun({ ...base, original: { ...info, author: "A" }, mode: "strip" }, c)).toEqual({ ok: true });
  });

  it("reparar: un PDF sano no tiene nada que reparar; uno cortado si", async () => {
    const t = tool<undefined>("repair");
    const c = await ctx();
    expect(t.canRun(undefined, c)).toEqual({ ok: false, reason: PRO_STRINGS.es.docTools.repair.nothingToRepair });
    const cut = (await makePdfBytes(2)).slice(0, -30);
    expect(t.canRun(undefined, await ctx({ bytes: cut }))).toEqual({ ok: true });
  });

  it("quitar proteccion: comprobando, fallo, sin restricciones, con restricciones sin y con consentimiento", async () => {
    const t = tool<ProUnlockOptions>("unlock");
    const c = await ctx();
    const s = PRO_STRINGS.es.docTools.unlock;
    const base = t.defaults(c);
    expect(t.canRun(base, c)).toEqual({ ok: false, reason: s.checking });
    expect(t.canRun({ ...base, inspected: "failed" }, c)).toEqual({ ok: false, reason: s.inspectFailed });
    expect(t.canRun({ ...base, inspected: "none" }, c)).toEqual({ ok: false, reason: s.noRestrictions });
    expect(t.canRun({ ...base, inspected: "restricted" }, c)).toEqual({ ok: false, reason: s.consentRequired });
    expect(t.canRun({ ...base, inspected: "restricted", acknowledgeSignatureInvalidation: true }, c)).toEqual({ ok: true });
  });

  it("comprimir y OCR siempre se pueden aplicar", async () => {
    const c = await ctx();
    expect(tool<CompressOptions>("compress").canRun({ level: "low", mode: "flatten" }, c)).toEqual({ ok: true });
    expect(tool<OcrOptions>("ocr").canRun({ language: "fra" }, c)).toEqual({ ok: true });
  });
});

describe("etiqueta del snapshot (es y en)", () => {
  it("marca de agua con el texto entre comillas", async () => {
    const t = tool<WatermarkOptions>("watermark");
    expect(t.describe({ ...t.defaults(await ctx()), text: "  SECRETO " }, await ctx())).toBe("Marca de agua “SECRETO”");
    const en = await ctx({ language: "en" });
    expect(t.describe({ ...t.defaults(en), text: "SECRET" }, en)).toBe("Watermark “SECRET”");
  });

  it("marca de agua de imagen", async () => {
    const t = tool<WatermarkOptions>("watermark");
    const c = await ctx();
    expect(t.describe({ ...t.defaults(c), kind: "image" }, c)).toBe("Marca de agua (imagen)");
  });

  it("numerar, encabezado, Bates, recortar, reparar, desbloquear y metadatos", async () => {
    const c = await ctx();
    expect(tool<PageNumbersToolOptions>("page-numbers").describe(tool<PageNumbersToolOptions>("page-numbers").defaults(c), c)).toBe("Numerar páginas");
    const hf = tool<HeaderFooterOptions>("header-footer");
    expect(hf.describe(hf.defaults(c), c)).toBe("Encabezado y pie");
    expect(hf.describe({ ...hf.defaults(c), footer: { left: "", center: "{bates}", right: "" }, bates: { prefix: "A", start: 1, digits: 4 } }, c)).toBe("Numeración Bates");
    expect(tool<ProCropOptions>("crop").describe(tool<ProCropOptions>("crop").defaults(c), c)).toBe("Recortar márgenes");
    expect(tool<undefined>("repair").describe(undefined, c)).toBe("Reparar el PDF");
    expect(tool<ProUnlockOptions>("unlock").describe(tool<ProUnlockOptions>("unlock").defaults(c), c)).toBe("Quitar restricciones de firma");
    const md = tool<ProMetadataOptions>("metadata");
    expect(md.describe(md.defaults(c), c)).toBe("Editar metadatos");
    expect(md.describe({ ...md.defaults(c), mode: "strip" }, c)).toBe("Eliminar metadatos");
  });

  it("comprimir menciona el nivel y el aplanado", async () => {
    const t = tool<CompressOptions>("compress");
    const c = await ctx();
    expect(t.describe({ level: "recommended", mode: "recompress" }, c)).toBe("Comprimir (recomendada)");
    expect(t.describe({ level: "extreme", mode: "flatten" }, c)).toBe("Comprimir (extrema, aplanado)");
    const en = await ctx({ language: "en" });
    expect(t.describe({ level: "low", mode: "recompress" }, en)).toBe("Compress (low)");
  });

  it("rotar describe angulo y alcance (todo / pagina / paginas)", async () => {
    const t = tool<ProRotateOptions>("rotate");
    const c = await ctx();
    const base = t.defaults(c);
    expect(t.describe(base, c)).toBe("Rotar 90° (todas las páginas)");
    expect(t.describe({ ...base, angle: 180, scope: "range", fromPage: 2, toPage: 3 }, c)).toBe("Rotar 180° (páginas 2–3)");
    expect(t.describe({ ...base, scope: "range", fromPage: 2, toPage: 2 }, c)).toBe("Rotar 90° (página 2)");
    expect(t.describe({ ...base, scope: "range", fromPage: 2, toPage: 0 }, c)).toBe("Rotar 90° (páginas 2–3)");
    const en = await ctx({ language: "en" });
    expect(t.describe({ ...base, scope: "range", fromPage: 1, toPage: 1 }, en)).toBe("Rotate 90° (page 1)");
  });

  it("OCR menciona el idioma con su nombre", async () => {
    const t = tool<OcrOptions>("ocr");
    expect(t.describe({ language: "fra" }, await ctx())).toBe("Reconocer texto (Francés)");
    expect(t.describe({ language: "eng" }, await ctx({ language: "en" }))).toBe("Recognise text (English)");
  });
});

describe("vista previa", () => {
  it("solo marca de agua, numerar, encabezado, recortar y rotar la ofrecen", () => {
    expect(DOC_TOOLS.filter((t) => t.previewOptions).map((t) => t.id)).toEqual(["watermark", "page-numbers", "header-footer", "crop", "rotate"]);
  });

  it("marca de agua: la pagina 1 sale con rango 1..1; fuera del rango no hay vista", async () => {
    const t = tool<WatermarkOptions>("watermark");
    const c = await ctx();
    const base = t.defaults(c);
    expect(t.previewOptions!({ ...base, fromPage: 1, toPage: 3 }, c)).toMatchObject({ fromPage: 1, toPage: 1 });
    expect(t.previewOptions!({ ...base, fromPage: 2 }, c)).toBeNull();
  });

  it("numerar sustituye {p} por el total REAL del rango (no por 1)", async () => {
    const t = tool<PageNumbersToolOptions>("page-numbers");
    const c = await ctx({ pageCount: 10 });
    const preview = t.previewOptions!({ ...t.defaults(c), template: "{n} de {p}", firstNumber: 1 }, c)!;
    expect(preview.template).toBe("{n} de 10");
    const partial = t.previewOptions!({ ...t.defaults(c), template: "{n}/{p}", firstNumber: 5, fromPage: 1, toPage: 4 }, c)!;
    expect(partial.template).toBe("{n}/8");
  });

  it("encabezado y pie sustituye {p} en las seis zonas", async () => {
    const t = tool<HeaderFooterOptions>("header-footer");
    const c = await ctx({ pageCount: 6 });
    const preview = t.previewOptions!(
      { ...t.defaults(c), header: { left: "{p}", center: "x{p}", right: "" }, footer: { left: "", center: "{n}/{p}", right: "{p}" } },
      c,
    )!;
    expect(preview.header).toEqual({ left: "6", center: "x6", right: "" });
    expect(preview.footer).toEqual({ left: "", center: "{n}/6", right: "6" });
  });

  it("recortar: rango que no incluye la 1 no tiene vista; con ella se previsualiza como «todas»", async () => {
    const t = tool<ProCropOptions>("crop");
    const c = await ctx();
    expect(t.previewOptions!({ ...t.defaults(c), scope: "range", fromPage: 2 }, c)).toBeNull();
    expect(t.previewOptions!({ ...t.defaults(c), scope: "range", fromPage: 1, toPage: 2 }, c)).toMatchObject({ scope: "all" });
  });

  it("rotar: con paridad par la pagina 1 no cambia (sin vista)", async () => {
    const t = tool<ProRotateOptions>("rotate");
    const c = await ctx();
    expect(t.previewOptions!({ ...t.defaults(c), scope: "range", fromPage: 1, toPage: 3, parity: "even" }, c)).toBeNull();
    expect(t.previewOptions!({ ...t.defaults(c), scope: "range", fromPage: 1, toPage: 3, parity: "odd" }, c)).toMatchObject({ scope: "all", angle: 90 });
  });
});
