import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, StandardFonts, type PDFFont } from "@cantoo/pdf-lib";
import { makeEdit } from "@/app/edit-pdf/editTestUtils";
import { EDIT_FLOW_STRINGS } from "@/app/edit-pdf/flowStrings";
import {
  MAX_REMAINS_LISTED,
  buildEditReport,
  describeEditReports,
  editResultText,
  excerptOf,
  type EditReport,
} from "@/app/sign-pdf/editReport";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { applyEditsToFile } from "@/app/sign-pdf/textEdits";
import type { OriginalTextRemainsReason, TextEdit } from "@/lib/pdf/editTypes";
import type { ExportWarningCounts } from "@/app/edit-pdf/editExport";

/**
 * B1: lo que paso con el texto ORIGINAL editado al firmar. Cada caso construye un PDF real, aplica las ediciones con
 * `applyEditsToFile` (el mismo motor que Firmar: F2 quita el original o avisa por que no) y comprueba el informe y su
 * texto en espanol e ingles. Los motivos y los avisos genericos son los de Editar PDF (`EDIT_FLOW_STRINGS`).
 */

const es = SIGN_STRINGS.es;
const en = SIGN_STRINGS.en;
const flowEs = EDIT_FLOW_STRINGS.es;
const flowEn = EDIT_FLOW_STRINGS.en;

/* ------------------------------------------------------------------ *
 * Constructores de PDF (pagina 300x200; `F1` es Helvetica)
 * ------------------------------------------------------------------ */

async function rawPdf(
  content: string[] | string,
  extra?: (doc: PDFDocument, font: PDFFont) => Promise<void> | void,
): Promise<File> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const stream of Array.isArray(content) ? content : [content]) {
    const page = doc.addPage([300, 200]);
    page.node.setFontDictionary(PDFName.of("F1"), font.ref);
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(stream)));
  }
  await extra?.(doc, font);
  return new File([(await doc.save()) as BlobPart], "doc.pdf", { type: "application/pdf" });
}

const PLAIN = "BT /F1 20 Tf 40 100 Td (Original) Tj ET";

/** Texto en un Form XObject que comparten DOS paginas: F2 no lo toca y avisa `shared-xobject`. */
async function sharedXObjectPdf(): Promise<File> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const xobject = doc.context.register(
    doc.context.stream("BT /F1 20 Tf 0 0 Td (Original) Tj ET", {
      Type: "XObject",
      Subtype: "Form",
      BBox: [0, -20, 300, 40],
      Matrix: [1, 0, 0, 1, 40, 100],
      Resources: { Font: { F1: font.ref } },
    }),
  );
  for (let index = 0; index < 2; index += 1) {
    const page = doc.addPage([300, 200]);
    page.node.setXObject(PDFName.of("Fx"), xobject);
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream("q /Fx Do Q")));
  }
  return new File([(await doc.save()) as BlobPart], "compartido.pdf", { type: "application/pdf" });
}

/** Texto con una fuente Type3: F2 no puede reescribirla y avisa `type3`. */
async function type3Pdf(): Promise<File> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const glyph = doc.context.register(doc.context.stream("1000 0 0 0 750 750 d1 0 0 750 750 re f"));
  const type3 = doc.context.register(
    doc.context.obj({
      Type: "Font",
      Subtype: "Type3",
      FontBBox: [0, 0, 750, 750],
      FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      CharProcs: { square: glyph },
      Encoding: { Type: "Encoding", Differences: [97, "square"] },
      FirstChar: 97,
      LastChar: 97,
      Widths: [1000],
      Resources: {},
    }),
  );
  page.node.setFontDictionary(PDFName.of("T3"), type3);
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream("BT /T3 20 Tf 40 100 Td (aaa) Tj ET")));
  return new File([(await doc.save()) as BlobPart], "type3.pdf", { type: "application/pdf" });
}

function replace(overrides: Partial<TextEdit> = {}): TextEdit {
  return makeEdit({
    id: "e1",
    blockId: "p0-b0",
    pageIndex: 0,
    box: { x: 40, y: 95, width: 100, height: 24 },
    coverBox: { x: 40, y: 95, width: 100, height: 24 },
    text: "Nuevo",
    fontSize: 20,
    color: "#0000ff",
    cover: { color: "#ffffff", padding: 1 },
    ...overrides,
  });
}

async function reportOf(file: File, edits: TextEdit[]): Promise<EditReport> {
  const applied = await applyEditsToFile(file, edits);
  const report = buildEditReport(applied);
  expect(report).not.toBeNull();
  return report!;
}

/* ------------------------------------------------------------------ *
 * excerptOf
 * ------------------------------------------------------------------ */

describe("excerptOf — como se nombra un texto en el aviso", () => {
  it("toma el primer renglon con contenido y junta los espacios", () => {
    expect(excerptOf("  Total   a   pagar \nsegunda linea")).toBe("Total a pagar");
    expect(excerptOf("\n\n  Hola\n")).toBe("Hola");
  });

  it("un texto vacio (se borro el bloque) no tiene extracto", () => {
    expect(excerptOf("")).toBeNull();
    expect(excerptOf(" \n \t ")).toBeNull();
  });

  it("acorta a 40 caracteres con puntos suspensivos y no parte un par sustituto", () => {
    const long = "x".repeat(60);
    const out = excerptOf(long)!;
    expect(Array.from(out)).toHaveLength(40);
    expect(out.endsWith("…")).toBe(true);
    const emoji = excerptOf("😀".repeat(50))!;
    expect(Array.from(emoji)).toHaveLength(40);
    expect(emoji).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(excerptOf("a".repeat(40))).toBe("a".repeat(40));
  });
});

/* ------------------------------------------------------------------ *
 * buildEditReport con el motor real
 * ------------------------------------------------------------------ */

describe("buildEditReport — con el motor de F2", () => {
  it("un texto quitable: 1 reemplazado, 1 original eliminado, ninguno que quede", async () => {
    const report = await reportOf(await rawPdf(PLAIN), [replace({ text: "Cambiado" })]);
    expect(report).toMatchObject({ replaced: 1, added: 0, removed: 1, remains: [] });
  });

  it("XObject compartido: el original permanece con el motivo shared-xobject y la pagina y el texto nuevo", async () => {
    const report = await reportOf(await sharedXObjectPdf(), [replace({ text: "Importe nuevo" })]);
    expect(report.replaced).toBe(1);
    expect(report.removed).toBe(0);
    expect(report.remains).toEqual([
      { editId: "e1", pageIndex: 0, excerpt: "Importe nuevo", reason: "shared-xobject" },
    ]);
  });

  it("fuente Type3: motivo type3", async () => {
    const report = await reportOf(await type3Pdf(), [replace()]);
    expect(report.remains.map((item) => item.reason)).toEqual(["type3"]);
    expect(report.removed).toBe(0);
  });

  it("texto invisible (capa OCR, Tr 3): motivo invisible", async () => {
    const file = await rawPdf("BT /F1 20 Tf 3 Tr 40 100 Td (Oculto) Tj ET");
    const report = await reportOf(file, [replace()]);
    expect(report.remains.map((item) => item.reason)).toEqual(["invisible"]);
  });

  it("caja sin texto debajo: motivo not-found", async () => {
    const report = await reportOf(await rawPdf(PLAIN), [
      replace({ box: { x: 200, y: 20, width: 60, height: 20 }, coverBox: { x: 200, y: 20, width: 60, height: 20 } }),
    ]);
    expect(report.remains.map((item) => item.reason)).toEqual(["not-found"]);
  });

  it("una pagina con dos ediciones, una quitable y otra no: cuenta cada una donde toca", async () => {
    const file = await rawPdf([
      "BT /F1 20 Tf 40 100 Td (Original) Tj ET",
      "BT /F1 20 Tf 3 Tr 40 100 Td (Oculto) Tj ET",
    ]);
    const report = await reportOf(file, [
      replace({ id: "a", text: "Uno" }),
      replace({ id: "b", pageIndex: 1, text: "Dos" }),
    ]);
    expect(report).toMatchObject({ replaced: 2, removed: 1 });
    expect(report.remains).toEqual([{ editId: "b", pageIndex: 1, excerpt: "Dos", reason: "invisible" }]);
  });

  it("un texto borrado (vacio) cuyo original permanece se nombra sin extracto", async () => {
    const report = await reportOf(await type3Pdf(), [replace({ text: "" })]);
    expect(report.remains[0].excerpt).toBeNull();
  });

  it("un texto propio (sin bloque) es «anadido»: no cuenta como original que quitar", async () => {
    const report = await reportOf(await rawPdf(PLAIN), [
      replace({ id: "own", blockId: undefined, coverBox: undefined, cover: { color: null, padding: 0 }, text: "Mio", box: { x: 150, y: 20, width: 80, height: 20 } }),
    ]);
    expect(report).toMatchObject({ replaced: 0, added: 1, removed: 0, remains: [] });
  });

  it("una edicion en una pagina que no existe se omite: no cuenta como quitada ni como pendiente, y se avisa", async () => {
    const report = await reportOf(await rawPdf(PLAIN), [replace({ pageIndex: 7 })]);
    expect(report).toMatchObject({ replaced: 1, removed: 0, remains: [] });
    expect(report.warnings.skipped).toBe(1);
  });

  it("sin ediciones efectivas no hay informe (la pantalla de resultado es la de siempre)", async () => {
    const applied = await applyEditsToFile(await rawPdf(PLAIN), [replace({ blockId: undefined, text: "  " })]);
    expect(applied.applied).toEqual([]);
    expect(buildEditReport(applied)).toBeNull();
    expect(buildEditReport(await applyEditsToFile(await rawPdf(PLAIN), undefined))).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * describeEditReports: el texto de la pantalla de resultado
 * ------------------------------------------------------------------ */

const ZERO: ExportWarningCounts = {
  fontSubstituted: 0,
  glyphMissing: 0,
  originalRemains: 0,
  originalRemoved: 0,
  backgroundNotUniform: 0,
  overlap: 0,
  mixedStyle: 0,
  coverOverlaps: 0,
  flattenDrops: null,
  skipped: 0,
};

function report(partial: Partial<EditReport> = {}): EditReport {
  return { replaced: 1, added: 0, removed: 1, remains: [], warnings: ZERO, ...partial };
}

const remainEntry = (n: number, reason: OriginalTextRemainsReason | undefined = "shared-xobject") => ({
  editId: `e${n}`,
  pageIndex: n - 1,
  excerpt: `Texto ${n}`,
  reason,
});

describe("describeEditReports — un documento", () => {
  it("todo quitado: «N textos editados: el original se elimino del archivo» y ningun aviso", () => {
    const text = describeEditReports([{ docName: "a.pdf", report: report({ replaced: 3, removed: 3 }) }], es, flowEs)!;
    expect(text.summary).toBe("3 textos editados: el original se eliminó del archivo.");
    expect(text.items).toEqual([]);
    expect(text.title).toBe("Sobre el texto editado");
    const one = describeEditReports([{ docName: "a.pdf", report: report() }], es, flowEs)!;
    expect(one.summary).toBe("1 texto editado: el original se eliminó del archivo.");
  });

  it("en ingles", () => {
    const text = describeEditReports([{ docName: "a.pdf", report: report({ replaced: 2, removed: 2 }) }], en, flowEn)!;
    expect(text.summary).toBe("2 texts edited: the original was removed from the file.");
    expect(text.title).toBe("About the edited text");
  });

  it("uno que no se pudo quitar: el motivo en llano (el de Editar PDF), donde esta y la salida recomendada UNA vez", () => {
    const text = describeEditReports(
      [{ docName: "a.pdf", report: report({ removed: 0, remains: [remainEntry(2, "type3")] }) }],
      es,
      flowEs,
    )!;
    expect(text.summary).toBe("1 texto editado: no se pudo quitar el original (más abajo, por qué).");
    expect(text.items).toEqual([
      `Página 2, «Texto 2»: el original sigue bajo la edición. ${flowEs.remainsReason("type3")}`,
      es.editRemainsAdvice("Aplanar página"),
    ]);
    expect(text.items[0]).toContain("Type 3");
    expect(text.items[1]).toContain("«Aplanar página»");
    expect(text.items[1]).toContain("Editar PDF");
  });

  it("mezcla: 2 quitados y 1 no", () => {
    const text = describeEditReports(
      [{ docName: "a.pdf", report: report({ replaced: 3, removed: 2, remains: [remainEntry(1, "invisible")] }) }],
      es,
      flowEs,
    )!;
    expect(text.summary).toBe(
      "3 textos editados: el original se eliminó de 2 y no se pudo quitar de 1 (más abajo, por qué).",
    );
    expect(text.items[0]).toContain("Página 1, «Texto 1»");
    expect(text.items[0]).toContain("invisible");
  });

  it("mezcla en ingles, con el motivo en ingles", () => {
    const text = describeEditReports(
      [{ docName: "a.pdf", report: report({ replaced: 3, removed: 1, remains: [remainEntry(1, "shared-xobject"), remainEntry(2, "not-found")] }) }],
      en,
      flowEn,
    )!;
    expect(text.summary).toBe(
      "3 texts edited: the original was removed from 1 and could not be removed from 2 (see why below).",
    );
    expect(text.items[0]).toBe(
      `Page 1, “Texto 1”: the original is still under the edit. ${flowEn.remainsReason("shared-xobject")}`,
    );
    expect(text.items[2]).toBe(en.editRemainsAdvice("Flatten page"));
  });

  it("un texto borrado sin extracto dice «un texto borrado»", () => {
    const text = describeEditReports(
      [{ docName: "a.pdf", report: report({ removed: 0, remains: [{ ...remainEntry(1), excerpt: null }] }) }],
      es,
      flowEs,
    )!;
    expect(text.items[0]).toContain("Página 1, un texto borrado:");
  });

  it("muchos sin quitar: lista los primeros y resume el resto", () => {
    const remains = Array.from({ length: MAX_REMAINS_LISTED + 3 }, (_, index) => remainEntry(index + 1));
    const text = describeEditReports(
      [{ docName: "a.pdf", report: report({ replaced: remains.length, removed: 0, remains }) }],
      es,
      flowEs,
    )!;
    // N listados + «Y 3 textos mas» + la salida.
    expect(text.items).toHaveLength(MAX_REMAINS_LISTED + 2);
    expect(text.items[MAX_REMAINS_LISTED]).toBe("Y 3 textos más con el original sin quitar.");
    expect(text.items.at(-1)).toBe(es.editRemainsAdvice("Aplanar página"));
    const one = describeEditReports(
      [{ docName: "a.pdf", report: report({ replaced: 7, removed: 0, remains: Array.from({ length: 7 }, (_, index) => remainEntry(index + 1)) }) }],
      es,
      flowEs,
    )!;
    expect(one.items[MAX_REMAINS_LISTED]).toBe("Y 1 texto más con el original sin quitar.");
  });

  it("los avisos genericos de la exportacion (fuente, caracteres, fondo, solapes, omitidos) salen con los textos de Editar PDF", () => {
    const text = describeEditReports(
      [
        {
          docName: "a.pdf",
          report: report({
            warnings: { ...ZERO, fontSubstituted: 2, glyphMissing: 1, backgroundNotUniform: 1, overlap: 1, coverOverlaps: 1, mixedStyle: 1, skipped: 1 },
          }),
        },
      ],
      es,
      flowEs,
    )!;
    expect(text.items).toEqual([
      flowEs.noticeFont(2),
      flowEs.noticeGlyph(1),
      flowEs.noticeBackground(1),
      flowEs.noticeMixed(1),
      flowEs.noticeOverlap(1),
      flowEs.noticeCoverOverlap(1),
      flowEs.noticeSkipped(1),
    ]);
    // Lo de «quitado/permanece» NO se repite aqui: lo cuenta el resumen y la lista por bloque.
    expect(text.items.join(" ")).not.toContain(flowEs.noticeRemoved(1));
  });

  it("D4 · una edicion que reemplaza un bloque pero se omite (ni quitada ni pendiente): el resumen NO dice que el original se elimino ni que permanece", () => {
    const skipped = report({ replaced: 1, removed: 0, remains: [], warnings: { ...ZERO, skipped: 1 } });
    const text = describeEditReports([{ docName: "a.pdf", report: skipped }], es, flowEs)!;
    expect(text.summary).toBe("1 texto editado.");
    expect(text.summary).not.toContain("original");
    // Lo unico que se avisa es la omision, con el texto de Editar PDF; no hay lista de bloques ni salida recomendada.
    expect(text.items).toEqual([flowEs.noticeSkipped(1)]);
    const english = describeEditReports([{ docName: "a.pdf", report: skipped }], en, flowEn)!;
    expect(english.summary).toBe("1 text edited.");
    expect(english.summary).not.toContain("original");
    // Con dos reemplazos y ninguno quitado ni pendiente: igual (la cuenta es de los reemplazados, no de los quitados).
    const two = describeEditReports([{ docName: "a.pdf", report: report({ replaced: 2, removed: 0, remains: [] }) }], es, flowEs)!;
    expect(two.summary).toBe("2 textos editados.");
  });

  it("D4 · con el motor real: la edicion en una pagina que no existe se omite y el resumen no afirma nada del original", async () => {
    const built = await reportOf(await rawPdf(PLAIN), [replace({ pageIndex: 7 })]);
    const text = describeEditReports([{ docName: "doc.pdf", report: built }], es, flowEs)!;
    expect(text.summary).toBe("1 texto editado.");
    expect(text.items).toEqual([flowEs.noticeSkipped(1)]);
  });

  it("D4 · si ninguno se quito pero hay uno omitido y otro que permanece, se cuentan los pendientes (no se dice «eliminado»)", () => {
    const text = describeEditReports(
      [{ docName: "a.pdf", report: report({ replaced: 2, removed: 0, remains: [remainEntry(1)] }) }],
      es,
      flowEs,
    )!;
    expect(text.summary).toBe(`2 textos editados: ${es.editTailNoneRemoved(1)}.`);
    expect(text.summary).not.toContain("eliminó");
  });

  it("solo textos anadidos: sin cuenta de originales ni salida recomendada", () => {
    const text = describeEditReports([{ docName: "a.pdf", report: report({ replaced: 0, added: 2, removed: 0 }) }], es, flowEs)!;
    expect(text.summary).toBe("2 textos añadidos.");
    expect(text.items).toEqual([]);
  });

  it("editados y anadidos: las dos cuentas", () => {
    const text = describeEditReports([{ docName: "a.pdf", report: report({ replaced: 1, added: 1, removed: 1 }) }], es, flowEs)!;
    expect(text.summary).toBe("1 texto editado: el original se eliminó del archivo. 1 texto añadido.");
  });

  it("sin entradas no hay texto", () => {
    expect(describeEditReports([], es, flowEs)).toBeNull();
  });
});

describe("describeEditReports — varios documentos (ZIP)", () => {
  const entries = [
    { docName: "Contrato A.pdf", report: report({ replaced: 2, removed: 2 }) },
    { docName: "Anexo.pdf", report: report({ replaced: 2, removed: 1, remains: [remainEntry(1, "shared-xobject")] }) },
  ];

  it("suma los textos de todos y nombra el documento de cada bloque sin limpiar", () => {
    const text = describeEditReports(entries, es, flowEs)!;
    expect(text.summary).toBe(
      "4 textos editados en 2 documentos: el original se eliminó de 3 y no se pudo quitar de 1 (más abajo, por qué).",
    );
    expect(text.items[0]).toBe(
      `Anexo.pdf, página 1, «Texto 1»: el original sigue bajo la edición. ${flowEs.remainsReason("shared-xobject")}`,
    );
    expect(text.items).toHaveLength(2);
  });

  it("todo quitado en varios documentos: «de los archivos»", () => {
    const text = describeEditReports(
      [
        { docName: "A.pdf", report: report() },
        { docName: "B.pdf", report: report({ replaced: 2, removed: 2 }) },
      ],
      es,
      flowEs,
    )!;
    expect(text.summary).toBe("3 textos editados en 2 documentos: el original se eliminó de los archivos.");
  });

  it("en ingles", () => {
    const text = describeEditReports(entries, en, flowEn)!;
    expect(text.summary).toBe(
      "4 texts edited in 2 documents: the original was removed from 3 and could not be removed from 1 (see why below).",
    );
    expect(text.items[0].startsWith("Anexo.pdf, page 1, “Texto 1”")).toBe(true);
  });

  it("`named` fuerza el nombre del documento aunque solo uno traiga ediciones (el ZIP lleva otros)", () => {
    const one = [{ docName: "Solo.pdf", report: report({ removed: 0, remains: [remainEntry(1)] }) }];
    expect(describeEditReports(one, es, flowEs)!.items[0].startsWith("Página 1")).toBe(true);
    expect(describeEditReports(one, es, flowEs, { named: true })!.items[0].startsWith("Solo.pdf, página 1")).toBe(true);
  });

  it("los avisos genericos se suman entre documentos", () => {
    const text = describeEditReports(
      [
        { docName: "A.pdf", report: report({ warnings: { ...ZERO, fontSubstituted: 1 } }) },
        { docName: "B.pdf", report: report({ warnings: { ...ZERO, fontSubstituted: 2, skipped: 1 } }) },
      ],
      es,
      flowEs,
    )!;
    expect(text.items).toEqual([flowEs.noticeFont(3), flowEs.noticeSkipped(1)]);
  });
});

describe("editResultText — lo que recibe ProcessResult", () => {
  it("sin ediciones es vacio: la pantalla de descarga no cambia", () => {
    expect(editResultText([], "es", es)).toEqual({});
  });

  it("con todo quitado solo hay resumen (sin lista de avisos)", () => {
    const out = editResultText([{ docName: "a.pdf", report: report() }], "es", es);
    expect(out.summary).toBe("1 texto editado: el original se eliminó del archivo.");
    expect(out.notices).toBeUndefined();
  });

  it("con avisos hay titulo e items", () => {
    const out = editResultText([{ docName: "a.pdf", report: report({ removed: 0, remains: [remainEntry(1)] }) }], "en", en);
    expect(out.notices?.title).toBe("About the edited text");
    expect(out.notices?.items).toHaveLength(2);
    expect(out.summary).toMatch(/could not be removed/);
  });
});

/* ------------------------------------------------------------------ *
 * Textos: es/en completos, sin claves crudas
 * ------------------------------------------------------------------ */

const REASONS: Record<OriginalTextRemainsReason, true> = {
  type3: true,
  vertical: true,
  encoding: true,
  widths: true,
  invisible: true,
  clip: true,
  "shared-xobject": true,
  unreadable: true,
  "not-found": true,
  ambiguous: true,
};

const BROKEN = /undefined|NaN|\[object|\{\w+\}|\bnull\b/;
const KEY_LIKE = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+){1,}$/;

describe("textos del resumen del texto editado", () => {
  it("cada motivo de F2 tiene frase en espanol e ingles, distinta entre idiomas y sin restos", () => {
    for (const reason of Object.keys(REASONS) as OriginalTextRemainsReason[]) {
      const a = flowEs.remainsReason(reason);
      const b = flowEn.remainsReason(reason);
      for (const text of [a, b]) {
        expect(text.trim().length, reason).toBeGreaterThan(20);
        expect(text, reason).not.toMatch(BROKEN);
        expect(KEY_LIKE.test(text), reason).toBe(false);
        expect(text.endsWith("."), reason).toBe(true);
      }
      expect(a, reason).not.toBe(b);
    }
    // Todos distintos entre si: cada motivo se explica con su propia frase.
    const all = Object.keys(REASONS).map((reason) => flowEs.remainsReason(reason as OriginalTextRemainsReason));
    expect(new Set(all).size).toBe(all.length);
  });

  it("un motivo desconocido o ausente da una frase generica, no «undefined»", () => {
    expect(flowEs.remainsReason(undefined)).toMatch(/No se pudo quitar/);
    expect(flowEn.remainsReason(undefined)).toMatch(/could not be removed/);
    expect(flowEs.remainsReason("otro" as OriginalTextRemainsReason)).toBe(flowEs.remainsReason(undefined));
  });

  it("todas las cadenas nuevas de Firmar existen en las dos lenguas, sin vacios ni marcadores", () => {
    const samples = (strings: typeof es): string[] => [
      strings.editReportTitle,
      strings.editTextNote,
      strings.editInDocs(3),
      strings.editTailAllRemoved(false),
      strings.editTailAllRemoved(true),
      strings.editTailSomeRemoved(2, 1),
      strings.editTailNoneRemoved(1),
      strings.editTailNoneRemoved(4),
      strings.editRemainsItem(null, 2, "Texto", "Motivo."),
      strings.editRemainsItem("Doc.pdf", 2, null, "Motivo."),
      strings.editRemainsMore(1),
      strings.editRemainsMore(5),
      strings.editRemainsAdvice("Aplanar"),
    ];
    const a = samples(es);
    const b = samples(en);
    expect(a).toHaveLength(b.length);
    a.forEach((text, index) => {
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text).not.toMatch(BROKEN);
      expect(b[index]).not.toMatch(BROKEN);
      expect(b[index], text).not.toBe(text);
    });
    // Plurales: 1 y varios no se pintan igual.
    expect(es.editRemainsMore(1)).not.toBe(es.editRemainsMore(2));
    expect(en.editRemainsMore(1)).not.toBe(en.editRemainsMore(2));
    expect(es.editTailNoneRemoved(1)).not.toBe(es.editTailNoneRemoved(2));
  });

  it("la nota permanente dice lo que de verdad ocurre y apunta al resumen, sin alarmas", () => {
    expect(es.editTextNote).toMatch(/se elimina del archivo/);
    expect(es.editTextNote).toMatch(/resumen/);
    expect(es.editTextNote).toMatch(/casos especiales/);
    expect(es.editTextNote).toMatch(/cuál y por qué/);
    expect(es.editTextNote).toMatch(/«Aplanar página» en Editar PDF/);
    expect(es.editTextNote).not.toMatch(/puede seguir existiendo|se dibuja sobre el original|peligro|cuidado|atención/i);
    expect(en.editTextNote).toMatch(/is removed from the file/);
    expect(en.editTextNote).toMatch(/summary/);
    expect(en.editTextNote).toMatch(/special cases/);
    expect(en.editTextNote).toMatch(/which one and why/);
    expect(en.editTextNote).toMatch(/“Flatten page” in Edit PDF/);
  });
});
