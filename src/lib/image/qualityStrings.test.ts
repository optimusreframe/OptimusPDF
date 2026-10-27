import { describe, expect, it } from "vitest";
import {
  IMAGE_QUALITY_STRINGS,
  MEMORY_RISK_BYTES,
  SHARE_LIMIT_HUGE,
  SHARE_LIMIT_MAIL,
  describeResult,
  describeSkipped,
  fillCopy,
  formatSizeRange,
  previewWarnings,
} from "@/lib/image/qualityStrings";
import { formatFileSize } from "@/lib/pdf/core";

const MB = 1024 * 1024;
const es = IMAGE_QUALITY_STRINGS.es;
const en = IMAGE_QUALITY_STRINGS.en;
const fmt = (bytes: number): string => formatFileSize(bytes, "es-ES");
const pct = (value: number): string => `${value} %`;

describe("describeResult · «Antes → Despues» y avisos de peso", () => {
  it("con ahorro real: «Tus fotos: 120 MB → PDF: 4,1 MB (97 % menos)»", () => {
    const out = describeResult(es, { sourceBytes: 120 * MB, pdfBytes: Math.round(4.1 * MB) }, fmt, pct);
    expect(out.summary).toBe("Tus fotos: 120 MB → PDF: 4,1 MB (97 % menos)");
    expect(out.notices).toBeUndefined();
  });

  it("sin ahorro (menos de un 1 %) no se presume ninguno", () => {
    const out = describeResult(es, { sourceBytes: 10 * MB, pdfBytes: Math.round(9.96 * MB) }, fmt, pct);
    expect(out.summary).toBe("Tus fotos: 10,0 MB → PDF: 10,0 MB");
    expect(out.summary).not.toContain("menos");
    expect(describeResult(es, { sourceBytes: 0, pdfBytes: 5 * MB }, fmt, pct).summary).not.toContain("menos");
  });

  it("un ZIP nunca presume ahorro y dice «ZIP»", () => {
    const out = describeResult(es, { sourceBytes: 100 * MB, pdfBytes: 10 * MB, zip: true }, fmt, pct);
    expect(out.summary).toBe("Tus fotos: 100 MB → ZIP: 10,0 MB");
  });

  it("umbrales: 20 MB (correo) y 100 MB (WhatsApp); justo en el umbral no avisa", () => {
    expect(SHARE_LIMIT_MAIL).toBe(20 * MB);
    expect(SHARE_LIMIT_HUGE).toBe(100 * MB);
    expect(describeResult(es, { sourceBytes: 400 * MB, pdfBytes: 19 * MB }, fmt, pct).notices).toBeUndefined();
    expect(describeResult(es, { sourceBytes: 400 * MB, pdfBytes: SHARE_LIMIT_MAIL }, fmt, pct).notices).toBeUndefined();
    expect(describeResult(es, { sourceBytes: 400 * MB, pdfBytes: SHARE_LIMIT_MAIL + 1 }, fmt, pct).notices?.items).toEqual([es.noticeBig]);
    expect(describeResult(es, { sourceBytes: 400 * MB, pdfBytes: 25 * MB }, fmt, pct).notices?.items).toEqual([es.noticeBig]);
    expect(describeResult(es, { sourceBytes: 400 * MB, pdfBytes: SHARE_LIMIT_HUGE }, fmt, pct).notices?.items).toEqual([es.noticeBig]);
    expect(describeResult(es, { sourceBytes: 400 * MB, pdfBytes: SHARE_LIMIT_HUGE + 1 }, fmt, pct).notices?.items).toEqual([es.noticeHuge]);
    expect(describeResult(es, { sourceBytes: 400 * MB, pdfBytes: 300 * MB }, fmt, pct).notices?.title).toBe(es.noticeTitle);
  });

  it("los textos de los avisos hablan de 20 y 100 MB (coherentes con los umbrales y con el aviso previo)", () => {
    expect(es.noticeBig).toContain("20 MB");
    expect(es.noticeHuge).toContain("100 MB");
    expect(es.warnMail).toContain("20 MB");
    expect(es.warnHuge).toContain("100 MB");
    expect(en.noticeBig).toContain("20 MB");
    expect(en.warnMail).toContain("20 MB");
  });

  it("las fotos omitidas se nombran con su motivo, antes del aviso de peso", () => {
    const out = describeResult(
      es,
      {
        sourceBytes: 200 * MB,
        pdfBytes: 30 * MB,
        skipped: [
          { name: "foto-12.jpg", problem: "unreadable" },
          { name: "IMG_5.jpg", problem: "truncated" },
        ],
      },
      fmt,
      pct,
    );
    expect(out.notices?.items).toEqual([
      "Se omitieron 2 fotos y no están en el PDF: foto-12.jpg (no se pudo leer), IMG_5.jpg (incompleta).",
      es.noticeBig,
    ]);
  });
});

describe("describeSkipped", () => {
  it("una sola foto en singular; ninguna, nada", () => {
    expect(describeSkipped(es, [])).toBeNull();
    expect(describeSkipped(es, [{ name: "a.jpg", problem: "notImage" }])).toBe("Se omitió 1 foto y no está en el PDF: a.jpg (no es una imagen).");
    expect(describeSkipped(en, [{ name: "a.jpg", problem: "empty" }])).toBe("1 photo was skipped and is not in the PDF: a.jpg (empty).");
  });

  it("con muchas, lista las primeras y cuenta el resto", () => {
    const many = Array.from({ length: 8 }, (_, index) => ({ name: `f${index + 1}.jpg`, problem: "corrupt" as const }));
    const text = describeSkipped(es, many) as string;
    expect(text).toContain("Se omitieron 8 fotos");
    expect(text).toContain("f5.jpg (dañada)");
    expect(text).not.toContain("f6.jpg");
    expect(text).toContain("y 3 más");
  });

  it("cada motivo tiene texto corto y frase completa en los dos idiomas", () => {
    for (const strings of [es, en]) {
      for (const problem of ["empty", "notImage", "truncated", "corrupt", "heic", "unreadable"] as const) {
        expect(strings.problemShort[problem].length).toBeGreaterThan(2);
        expect(strings.problemLine[problem].length).toBeGreaterThan(5);
      }
    }
    expect(es.problemLine.heic).toContain("«Más compatible»");
    expect(es.problemLine.heic).toContain("JPEG");
  });
});

describe("previewWarnings · avisos ANTES de generar", () => {
  const warn = (optimizedMb: number, sourceMb: number, preset: "original" | "balanced", ios: boolean) =>
    previewWarnings({ optimizedBytes: optimizedMb * MB, sourceBytes: sourceMb * MB }, preset, ios);

  it("20 MB: correo; 100 MB: WhatsApp (solo el mas grave)", () => {
    expect(warn(15, 100, "balanced", false)).toEqual([]);
    expect(warn(20, 100, "balanced", false)).toEqual([]);
    expect(warn(21, 100, "balanced", false)).toEqual(["mail"]);
    expect(warn(99, 400, "balanced", false)).toEqual(["mail"]);
    expect(warn(101, 400, "balanced", false)).toEqual(["huge"]);
  });

  it("«Original» con mas de 120 MB de fotos en iPhone/iPad avisa de memoria; en otros navegadores o con menos, no", () => {
    expect(MEMORY_RISK_BYTES).toBe(120 * MB);
    expect(warn(348, 348, "original", true)).toEqual(["huge", "memory"]);
    expect(warn(348, 348, "original", false)).toEqual(["huge"]);
    expect(warn(100, 100, "original", true)).toEqual(["mail"]);
    expect(warn(60, 120, "original", true)).toEqual(["mail"]); // justo 120 MB: aun no
    expect(warn(60, 121, "original", true)).toEqual(["mail", "memory"]);
    expect(warn(348, 348, "balanced", true)).toEqual(["huge"]);
  });
});

describe("formatSizeRange · «35-45 MB»", () => {
  it("una sola unidad cuando es la misma; las dos si cambia; un solo valor si coinciden", () => {
    expect(formatSizeRange(35 * MB, 45 * MB, fmt)).toBe("35,0-45,0 MB");
    expect(formatSizeRange(900 * 1024, 1.5 * MB, fmt)).toBe("900 KB-1,5 MB");
    expect(formatSizeRange(40 * MB, 40 * MB, fmt)).toBe("40,0 MB");
  });
});

describe("fillCopy", () => {
  it("sustituye {marcadores} y deja los desconocidos", () => {
    expect(fillCopy("a {x} b {y}", { x: 1 })).toBe("a 1 b {y}");
  });
});

describe("textos de las calidades", () => {
  it("«Alta» es para expediente/peritaje y «Compacta» no sirve como evidencia", () => {
    expect(es.preset.high.description).toContain("expediente");
    expect(es.preset.high.description).toContain("peritaje");
    expect(es.preset.high.description).toContain("detalle al ampliar");
    expect(es.preset.compact.description).toContain("Solo para correo");
    expect(es.preset.compact.description.toLowerCase()).toContain("no sirve como evidencia");
    expect(es.preset.balanced.description).toContain("enviar");
    expect(en.preset.compact.description.toLowerCase()).toContain("not suitable as evidence");
  });
});
