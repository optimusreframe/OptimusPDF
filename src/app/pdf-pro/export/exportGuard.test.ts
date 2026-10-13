import { describe, expect, it, vi } from "vitest";
import { PdfError } from "@/lib/pdf/core";
import { discardExportBeforeLeaving, leaveConfirmation } from "@/app/pdf-pro/export/exportGuard";
import { getExportStore } from "@/app/pdf-pro/export/exportStore";
import { getExportStrings } from "@/app/pdf-pro/export/exportStrings";
import type { ProExport, ProExportResult } from "@/app/pdf-pro/ops/proExports";
import { fakeBytes, fakeDoc, fakeFile } from "@/app/pdf-pro/proTestUtils";

/**
 * Cerrar el documento o abrir otro con una exportacion EN CURSO cuenta como razon para confirmar (Wave 9), con un
 * texto que lo dice; al confirmar, la exportacion se cancela y se limpia.
 */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, downloadBlob: vi.fn() };
});

const ES = getExportStrings("es");
const EN = getExportStrings("en");
const BASE = "Tienes cambios sin descargar.";

async function openedDoc() {
  const doc = fakeDoc();
  await doc.open(fakeFile(120), { pageCount: 3 });
  return doc;
}

function runningExport(id = "word") {
  let reject!: (error: unknown) => void;
  let resolve!: (result: ProExportResult) => void;
  let signal!: AbortSignal;
  const entry: ProExport = {
    id,
    title: () => id,
    body: () => id,
    slug: "pdf-to-word",
    requiresNetwork: false,
    run: (_bytes, context) => {
      signal = context.signal;
      return new Promise<ProExportResult>((done, fail) => {
        resolve = done;
        reject = fail;
        context.signal.addEventListener("abort", () => fail(new PdfError("cancelled")));
      });
    },
  };
  return { entry, signal: () => signal, resolve: () => resolve({ blob: new Blob(["x"]), filename: "a.docx" }), reject: (e: unknown) => reject(e) };
}

const begin = (doc: Awaited<ReturnType<typeof openedDoc>>, entry: ProExport) =>
  getExportStore(doc).start({ entry, options: {}, selectedPages: [], language: "es" });

describe("leaveConfirmation", () => {
  it("sin cambios y sin exportacion no hace falta confirmar (y devuelve el texto habitual)", async () => {
    const doc = await openedDoc();
    expect(leaveConfirmation(doc, "es", "close", BASE)).toEqual({ needed: false, body: BASE });
    expect(leaveConfirmation(doc, "es", "replace", BASE)).toEqual({ needed: false, body: BASE });
  });

  it("con cambios sin descargar y sin exportacion: confirma con el texto habitual (como antes)", async () => {
    const doc = await openedDoc();
    await doc.commit(fakeBytes(200, 3), "Girar", "operation", { pageCount: 3 });
    expect(leaveConfirmation(doc, "es", "close", BASE)).toEqual({ needed: true, body: BASE });
  });

  it("un paso en vuelo sigue contando como cambios (D7)", async () => {
    const doc = await openedDoc();
    let finish!: () => void;
    void doc.trackStep(new Promise<void>((resolve) => (finish = resolve)));
    expect(leaveConfirmation(doc, "es", "replace", BASE)).toEqual({ needed: true, body: BASE });
    finish();
  });

  it("SOLO una exportacion en curso: hay que confirmar, con un texto propio para cerrar y otro para cambiar de documento", async () => {
    const doc = await openedDoc();
    begin(doc, runningExport("word").entry);
    expect(leaveConfirmation(doc, "es", "close", BASE)).toEqual({ needed: true, body: ES.notices.closeOnly("Word") });
    expect(leaveConfirmation(doc, "es", "replace", BASE)).toEqual({ needed: true, body: ES.notices.replaceOnly("Word") });
    expect(ES.notices.closeOnly("Word")).toContain("Word");
    expect(ES.notices.closeOnly("Word")).not.toContain(BASE);
  });

  it("exportacion + cambios sin descargar: el texto habitual y, ademas, el aviso de la exportacion", async () => {
    const doc = await openedDoc();
    await doc.commit(fakeBytes(200, 3), "Girar", "operation", { pageCount: 3 });
    begin(doc, runningExport("excel").entry);
    const decision = leaveConfirmation(doc, "es", "close", BASE);
    expect(decision.needed).toBe(true);
    expect(decision.body).toBe(`${BASE} ${ES.notices.also("Excel")}`);
  });

  it("habla ingles", async () => {
    const doc = await openedDoc();
    begin(doc, runningExport("powerpoint").entry);
    expect(leaveConfirmation(doc, "en", "close", "x").body).toBe(EN.notices.closeOnly("PowerPoint"));
    expect(leaveConfirmation(doc, "en", "replace", "x").body).toBe(EN.notices.replaceOnly("PowerPoint"));
  });

  it("una exportacion ya terminada, cancelada o con error NO obliga a confirmar", async () => {
    const doc = await openedDoc();
    const done = runningExport("word");
    begin(doc, done.entry);
    done.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(leaveConfirmation(doc, "es", "close", BASE).needed).toBe(false);
    const failing = runningExport("csv");
    begin(doc, failing.entry);
    failing.reject(new PdfError("corrupt"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(leaveConfirmation(doc, "es", "close", BASE).needed).toBe(false);
    const cancelled = runningExport("json");
    begin(doc, cancelled.entry);
    getExportStore(doc).cancel();
    expect(leaveConfirmation(doc, "es", "replace", BASE).needed).toBe(false);
  });
});

describe("discardExportBeforeLeaving", () => {
  it("aborta el motor y borra el estado sin anunciar nada", async () => {
    const doc = await openedDoc();
    const control = runningExport("word");
    begin(doc, control.entry);
    const announced = doc.getState().announcement!.id;
    discardExportBeforeLeaving(doc);
    expect(control.signal().aborted).toBe(true);
    expect(getExportStore(doc).getState().job).toBeNull();
    expect(doc.getState().announcement!.id).toBe(announced);
    // Sin nada en curso es inocuo.
    discardExportBeforeLeaving(doc);
  });
});
