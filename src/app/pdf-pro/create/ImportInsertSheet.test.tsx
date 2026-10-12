import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PDFDocument } from "@cantoo/pdf-lib";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { PdfError } from "@/lib/pdf/core";
import { es } from "@/lib/locales/es";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { ImportInsertSheet } from "@/app/pdf-pro/create/ImportInsertSheet";
import { getPagesStore } from "@/app/pdf-pro/pages/pagesStore";
import { labelsOf, mountTab } from "@/app/pdf-pro/tabs/docTestUtils";
import { STRINGS as EXCEL_STRINGS } from "@/app/excel-to-pdf/strings";
import { STRINGS as WORD_STRINGS } from "@/app/word-to-pdf/strings";

/** «Insertar desde Word, Excel o HTML» (U8): opciones de la herramienta suelta, posicion, progreso, error y deshacer. */

const converters = vi.hoisted(() => ({ word: vi.fn(), excel: vi.fn(), html: vi.fn() }));
vi.mock("@/lib/pdf/wordToPdf", () => ({ wordToPdf: converters.word }));
vi.mock("@/lib/pdf/excelToPdf", () => ({ excelToPdf: converters.excel }));
vi.mock("@/lib/pdf/htmlToPdf", () => ({ htmlToPdf: converters.html }));

const C = PRO_STRINGS.es.create.insert;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

async function convertedPdf(pages = 2): Promise<Blob> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([200, 200]);
  return new Blob([(await doc.save()) as unknown as BlobPart], { type: "application/pdf" });
}

beforeEach(async () => {
  for (const mock of Object.values(converters)) {
    mock.mockReset();
    mock.mockImplementation(async () => convertedPdf(2));
  }
});
afterEach(() => cleanup());

const file = (name: string) => new File(["x"], name);

async function mountSheet(target: File | null, onClose = vi.fn(), pages = 3) {
  const mounted = await mountTab(<div />, { pages });
  const doc = mounted.doc;
  mounted.unmount();
  const { ProWorkingDocProvider } = await import("@/app/pdf-pro/useProWorkingDoc");
  const utils = render(
    <LanguageProvider>
      <ProWorkingDocProvider doc={doc}>
        <ImportInsertSheet open file={target} onClose={onClose} />
      </ProWorkingDocProvider>
    </LanguageProvider>,
  );
  return { doc, onClose, ...utils };
}

const run = () => screen.getByRole("button", { name: C.insert });

describe("archivo no reconocido", () => {
  it("cualquier otra cosa dice que elijas .docx, .xlsx o .html y no ofrece insertar", async () => {
    await mountSheet(file("datos.csv"));
    expect((await screen.findByRole("alert")).textContent).toBe(C.unsupported);
    expect(screen.queryByRole("button", { name: C.insert })).toBeNull();
  });

  it("un .doc, .xls o .ppt antiguo explica que es el formato antiguo y como pasarlo al nuevo", async () => {
    for (const name of ["viejo.doc", "hoja.XLS", "presentacion.ppt"]) {
      cleanup();
      await mountSheet(file(name));
      expect((await screen.findByRole("alert")).textContent).toBe(es.tool.errors.legacyOfficeFormat);
      expect(screen.queryByRole("button", { name: C.insert })).toBeNull();
    }
  });

  it("sin archivo la hoja no pinta formulario", async () => {
    await mountSheet(null);
    expect(document.querySelector("[data-import-insert]")).toBeNull();
  });
});

describe("opciones segun el tipo", () => {
  it("Word: tamano, orientacion y margen con las etiquetas de «Word a PDF»", async () => {
    await mountSheet(file("a.docx"));
    await screen.findByText(C.kind.word);
    const w = WORD_STRINGS.es;
    for (const label of [w.pageSizeLabel, w.orientationLabel, w.marginLabel]) expect(screen.getByRole("radiogroup", { name: label })).toBeTruthy();
  });

  it("Excel: tamano, orientacion y hojas a convertir", async () => {
    await mountSheet(file("a.xlsx"));
    await screen.findByText(C.kind.excel);
    const e = EXCEL_STRINGS.es;
    for (const label of [e.pageSizeLabel, e.orientationLabel, e.sheetLabel]) expect(screen.getByRole("radiogroup", { name: label })).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: WORD_STRINGS.es.marginLabel })).toBeNull();
  });

  it("HTML: avisa de que sale una imagen de la pagina (el texto no se podra seleccionar)", async () => {
    await mountSheet(file("a.html"));
    await screen.findByText(C.kind.html);
    expect(screen.getByText(C.fidelityHtml)).toBeTruthy();
  });

  it("Word y Excel NO muestran el aviso de HTML", async () => {
    await mountSheet(file("a.docx"));
    await screen.findByText(C.kind.word);
    expect(screen.queryByText(C.fidelityHtml)).toBeNull();
  });

  it("las opciones elegidas llegan al motor", async () => {
    await mountSheet(file("a.xlsx"));
    fireEvent.click(await screen.findByRole("radio", { name: EXCEL_STRINGS.es.sheetFirst }));
    fireEvent.click(screen.getByRole("radio", { name: EXCEL_STRINGS.es.pageSizeLetter }));
    fireEvent.click(run());
    await waitFor(() => expect(converters.excel).toHaveBeenCalledTimes(1));
    expect(converters.excel.mock.calls[0][1]).toMatchObject({ sheet: "first", pageSize: "letter", orientation: "landscape" });
  });
});

describe("insertar", () => {
  it("al final por defecto: crea UN snapshot con etiqueta propia, anuncia y cierra", async () => {
    const { doc, onClose } = await mountSheet(file("contrato.docx"));
    fireEvent.click(await screen.findByRole("button", { name: C.insert }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(labelsOf(doc)).toEqual(["Original", C.label("contrato.docx")]);
    expect(doc.getState().pageCount).toBe(5);
    expect(doc.getState().announcement?.text).toContain(C.done(2));
    expect(doc.getState().dirty).toBe(true);
  });

  it("«Al principio» y «Despues de la pagina N» (la del visor, 1 sin visor)", async () => {
    const { doc } = await mountSheet(file("a.docx"));
    await screen.findByText(C.kind.word);
    fireEvent.click(screen.getByRole("radio", { name: C.start }));
    fireEvent.click(run());
    await waitFor(() => expect(doc.getState().pageCount).toBe(5));
    const bytes = doc.current()!;
    const sizes = (await PDFDocument.load(bytes)).getPages().map((page) => Math.round(page.getWidth()));
    expect(sizes.slice(0, 2)).toEqual([200, 200]);
  });

  it("ofrece «Despues de la pagina 1» cuando no hay visor", async () => {
    await mountSheet(file("a.docx"));
    expect(await screen.findByRole("radio", { name: C.afterCurrent(1) })).toBeTruthy();
  });

  it("deshacer (historial) quita lo insertado", async () => {
    const { doc } = await mountSheet(file("a.docx"));
    fireEvent.click(await screen.findByRole("button", { name: C.insert }));
    await waitFor(() => expect(doc.getState().pageCount).toBe(5));
    act(() => {
      doc.undo();
    });
    expect(doc.getState().pageCount).toBe(3);
  });

  it("cambios sin aplicar en Paginas: bloquea y lo explica (no se descartan en silencio)", async () => {
    const { doc } = await mountSheet(file("a.docx"));
    const store = getPagesStore(doc);
    const snapshot = doc.currentSnapshot()!;
    store.syncBase(snapshot.id, snapshot.pageCount);
    const plan = store.getState().plan;
    act(() => {
      store.commit(plan.slice(1), "Quitar", "clear");
    });
    expect(await screen.findByText(C.pendingOrganizer)).toBeTruthy();
    expect(run().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(run());
    expect(converters.word).not.toHaveBeenCalled();
  });

  it("un error del motor (formato antiguo, cifrado...) se explica y el documento no cambia", async () => {
    converters.word.mockRejectedValueOnce(new PdfError("legacyOfficeFormat"));
    const { doc, onClose } = await mountSheet(file("a.docx"));
    fireEvent.click(await screen.findByRole("button", { name: C.insert }));
    expect((await screen.findByRole("alert")).textContent).toContain(es.tool.errors.legacyOfficeFormat);
    expect(labelsOf(doc)).toEqual(["Original"]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("mientras convierte muestra progreso, el boton queda inactivo y «Cancelar» cierra y aborta", async () => {
    let signal!: AbortSignal;
    converters.word.mockImplementationOnce(
      (_file: File, _options: unknown, _progress: unknown, abort: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal = abort;
          abort.addEventListener("abort", () => reject(new PdfError("cancelled")));
        }),
    );
    const { doc, onClose } = await mountSheet(file("a.docx"));
    fireEvent.click(await screen.findByRole("button", { name: C.insert }));
    await screen.findByRole("progressbar");
    expect(screen.getByRole("button", { name: C.inserting }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(within(document.querySelector("[data-import-insert]") as HTMLElement).getByRole("button", { name: C.cancel }));
    expect(signal.aborted).toBe(true);
    expect(onClose).toHaveBeenCalled();
    expect(labelsOf(doc)).toEqual(["Original"]);
  });
});
