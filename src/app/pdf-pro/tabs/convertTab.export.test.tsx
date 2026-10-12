import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { PdfError } from "@/lib/pdf/core";
import { LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { getPagesStore } from "@/app/pdf-pro/pages/pagesStore";
import { ConvertTab } from "@/app/pdf-pro/tabs/ConvertTab";
import { getProExports } from "@/app/pdf-pro/ops/proExports";
import { labelsOf, mountTab } from "@/app/pdf-pro/tabs/docTestUtils";
import { es } from "@/lib/locales/es";

/**
 * «Convertir» (U8): ocho tarjetas con mini-panel de opciones, progreso, cancelacion y error claro. El motor se
 * sustituye (su salida ya se compara con la herramienta suelta en `exportEquivalence.test.ts`).
 */

const downloaded = vi.hoisted(() => ({ items: [] as { blob: Blob; name: string }[] }));
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, downloadBlob: (blob: Blob, name: string) => downloaded.items.push({ blob, name }) };
});

const reload = vi.hoisted(() => ({ page: vi.fn() }));
vi.mock("@/lib/reloadPage", () => ({ reloadPage: () => reload.page() }));

const runner = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/app/pdf-pro/export/exportRunners", () => ({ runExportFormat: runner.run }));

const E = PRO_STRINGS.es.export;
const T = PRO_STRINGS.es.docTools.convert;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
beforeEach(() => {
  downloaded.items.length = 0;
  reload.page.mockReset();
  runner.run.mockReset();
  runner.run.mockImplementation(async (id: string) => ({ blob: new Blob([id]), filename: `salida-${id}.bin` }));
});
afterEach(() => {
  cleanup();
  Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
});

const card = (id: string) => document.querySelector<HTMLElement>(`[data-export="${id}"]`)!;
const exportButton = (id: string) => within(card(id)).getByRole("button", { name: E.formats[id as keyof typeof E.formats].title });

describe("tarjetas", () => {
  it("hay ocho tarjetas con su motor: ninguna es un marcador «Próximamente»", async () => {
    await mountTab(<ConvertTab />);
    const ids = getProExports().map((entry) => entry.id);
    expect(ids).toEqual(["images", "text", "word", "excel", "csv", "markdown", "json", "powerpoint"]);
    expect(screen.queryByText(T.comingSoon)).toBeNull();
    for (const id of ids) {
      expect(card(id)).toBeTruthy();
      expect(exportButton(id)).toBeTruthy();
    }
  });

  it("cada tarjeta muestra titulo y descripcion del formato", async () => {
    await mountTab(<ConvertTab />);
    for (const [id, text] of Object.entries(E.formats)) {
      expect(within(card(id)).getByRole("heading", { name: text.title })).toBeTruthy();
      expect(within(card(id)).getByText(text.body)).toBeTruthy();
    }
  });

  it("todas salvo Word tienen boton «Opciones» plegado", async () => {
    await mountTab(<ConvertTab />);
    for (const id of ["images", "text", "excel", "csv", "markdown", "json", "powerpoint"]) {
      const toggle = within(card(id)).getByRole("button", { name: E.card.showOptions });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
    }
    expect(within(card("word")).queryByRole("button", { name: E.card.showOptions })).toBeNull();
  });

  it("«Opciones» despliega y pliega el panel y enlaza aria-controls", async () => {
    await mountTab(<ConvertTab />);
    const toggle = within(card("text")).getByRole("button", { name: E.card.showOptions });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(panel.hidden).toBe(false);
    expect(within(panel).getAllByRole("checkbox")).toHaveLength(2);
    fireEvent.click(within(card("text")).getByRole("button", { name: E.card.hideOptions }));
    expect(panel.hidden).toBe(true);
  });

  it("cada panel trae los controles de su herramienta suelta", async () => {
    await mountTab(<ConvertTab />);
    const open = (id: string) => fireEvent.click(within(card(id)).getByRole("button", { name: E.card.showOptions }));
    open("images");
    expect(within(card("images")).getByRole("tab", { name: E.images.png })).toBeTruthy();
    expect(within(card("images")).getByRole("slider")).toBeTruthy();
    open("csv");
    expect(within(card("csv")).getAllByRole("tab")).toHaveLength(2);
    open("markdown");
    expect(within(card("markdown")).getAllByRole("checkbox").length).toBeGreaterThanOrEqual(5);
    open("powerpoint");
    expect(within(card("powerpoint")).getByRole("slider")).toBeTruthy();
    open("excel");
    expect(within(card("excel")).getAllByRole("checkbox")).toHaveLength(1);
    open("json");
    expect(within(card("json")).getAllByRole("checkbox")).toHaveLength(1);
  });
});

describe("exportar", () => {
  it("descarga lo que devuelve el motor, anuncia el nombre y NO toca el historial ni el estado guardado", async () => {
    const { doc } = await mountTab(<ConvertTab />, { name: "acta.pdf" });
    fireEvent.click(exportButton("text"));
    await waitFor(() => expect(downloaded.items).toHaveLength(1));
    expect(downloaded.items[0].name).toBe("salida-text.bin");
    expect(doc.getState().announcement?.text).toBe(E.card.done("salida-text.bin"));
    expect(labelsOf(doc)).toEqual(["Original"]);
    expect(doc.getState().dirty).toBe(false);
  });

  it("pasa al motor el documento, el idioma, las opciones por defecto y el numero de paginas", async () => {
    await mountTab(<ConvertTab />, { name: "acta.pdf", pages: 4 });
    fireEvent.click(exportButton("markdown"));
    await waitFor(() => expect(runner.run).toHaveBeenCalledTimes(1));
    const [id, input] = runner.run.mock.calls[0];
    expect(id).toBe("markdown");
    expect(input).toMatchObject({ name: "acta.pdf", language: "es", pageCount: 4 });
    expect(input.file).toBeInstanceOf(File);
    expect(input.options).toMatchObject({ detectHeadings: true, ocrFallback: true, ocrLanguage: "spa" });
  });

  it("las opciones elegidas en el panel llegan al motor", async () => {
    await mountTab(<ConvertTab />);
    fireEvent.click(within(card("text")).getByRole("button", { name: E.card.showOptions }));
    fireEvent.click(within(card("text")).getAllByRole("checkbox")[1]); // separadores
    fireEvent.click(exportButton("text"));
    await waitFor(() => expect(runner.run).toHaveBeenCalledTimes(1));
    expect(runner.run.mock.calls[0][1].options).toEqual({ ocrFallback: true, pageSeparators: true });
  });

  it("imagenes: PNG + rango se pasan al motor", async () => {
    await mountTab(<ConvertTab />, { pages: 5 });
    fireEvent.click(within(card("images")).getByRole("button", { name: E.card.showOptions }));
    fireEvent.click(within(card("images")).getByRole("tab", { name: E.images.png }));
    fireEvent.click(within(card("images")).getByRole("tab", { name: E.images.scopeRange }));
    fireEvent.change(within(card("images")).getByLabelText(E.images.rangeLabel), { target: { value: "2-3" } });
    fireEvent.click(exportButton("images"));
    await waitFor(() => expect(runner.run).toHaveBeenCalledTimes(1));
    expect(runner.run.mock.calls[0][1].options).toMatchObject({ format: "png", scope: "range", range: "2-3" });
  });

  it("imagenes: un rango fuera del documento explica el motivo y bloquea el boton", async () => {
    await mountTab(<ConvertTab />, { pages: 3 });
    fireEvent.click(within(card("images")).getByRole("button", { name: E.card.showOptions }));
    fireEvent.click(within(card("images")).getByRole("tab", { name: E.images.scopeRange }));
    fireEvent.change(within(card("images")).getByLabelText(E.images.rangeLabel), { target: { value: "9" } });
    expect(card("images").querySelector("[data-export-problem]")?.textContent).toBe(E.images.rangeInvalid(3));
    expect(exportButton("images").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(exportButton("images"));
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("imagenes: sin paginas seleccionadas, «Seleccionadas» se explica y bloquea", async () => {
    await mountTab(<ConvertTab />);
    fireEvent.click(within(card("images")).getByRole("button", { name: E.card.showOptions }));
    fireEvent.click(within(card("images")).getByRole("tab", { name: E.images.scopeSelected }));
    expect(card("images").querySelector("[data-export-problem]")?.textContent).toBe(E.images.selectionEmpty);
    expect(exportButton("images").getAttribute("aria-disabled")).toBe("true");
  });

  it("imagenes: las paginas seleccionadas en el organizador llegan al motor (solo las del documento)", async () => {
    const { doc } = await mountTab(<ConvertTab />, { pages: 4 });
    const store = getPagesStore(doc);
    const snapshot = doc.currentSnapshot()!;
    store.syncBase(snapshot.id, snapshot.pageCount);
    const ids = store.getState().plan.map((entry) => entry.id as string);
    act(() => store.setSelection([ids[1], ids[3]]));
    fireEvent.click(within(card("images")).getByRole("button", { name: E.card.showOptions }));
    fireEvent.click(within(card("images")).getByRole("tab", { name: E.images.scopeSelected }));
    expect(within(card("images")).getByText(E.images.selectedHint(2))).toBeTruthy();
    fireEvent.click(exportButton("images"));
    await waitFor(() => expect(runner.run).toHaveBeenCalledTimes(1));
    expect(runner.run.mock.calls[0][1].selectedPages).toEqual([1, 3]);
  });

  it("un error del motor se explica con el mensaje tipado y no descarga", async () => {
    runner.run.mockRejectedValueOnce(new PdfError("noTablesFound"));
    await mountTab(<ConvertTab />);
    fireEvent.click(exportButton("excel"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(es.tool.errors.noTablesFound);
    expect(downloaded.items).toHaveLength(0);
  });

  it("sin conexion (`offline`): el aviso dice que hay que recargar y el boton «Recargar la página» recarga", async () => {
    runner.run.mockRejectedValueOnce(new PdfError("offline"));
    await mountTab(<ConvertTab />);
    fireEvent.click(exportButton("word"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(es.tool.errors.offline);
    const button = within(alert).getByRole("button", { name: es.tool.errors.reloadAction });
    expect(reload.page).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(reload.page).toHaveBeenCalledTimes(1);
  });

  it("un error que no es de red no ofrece «Recargar la página»", async () => {
    runner.run.mockRejectedValueOnce(new PdfError("noTablesFound"));
    await mountTab(<ConvertTab />);
    fireEvent.click(exportButton("excel"));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: es.tool.errors.reloadAction })).toBeNull();
  });

  it("tras un error se puede volver a exportar", async () => {
    runner.run.mockRejectedValueOnce(new PdfError("corrupt"));
    await mountTab(<ConvertTab />);
    fireEvent.click(exportButton("json"));
    await screen.findByRole("alert");
    fireEvent.click(exportButton("json"));
    await waitFor(() => expect(downloaded.items).toHaveLength(1));
  });

  it("una exportacion cancelada por el motor no muestra error", async () => {
    runner.run.mockRejectedValueOnce(new PdfError("cancelled"));
    await mountTab(<ConvertTab />);
    fireEvent.click(exportButton("word"));
    await waitFor(() => expect(screen.getByText(E.card.cancelled)).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("progreso y cancelacion", () => {
  function pending() {
    let resolve!: (value: { blob: Blob; filename: string }) => void;
    let signal!: AbortSignal;
    let onProgress!: (value: number) => void;
    runner.run.mockImplementationOnce(
      (_id: string, input: { signal: AbortSignal; onProgress: (value: number) => void }) =>
        new Promise((done, fail) => {
          signal = input.signal;
          onProgress = input.onProgress;
          resolve = done;
          input.signal.addEventListener("abort", () => fail(new PdfError("cancelled")));
        }),
    );
    return { resolve: (value: { blob: Blob; filename: string }) => resolve(value), signal: () => signal, progress: (value: number) => onProgress(value) };
  }

  it("mientras exporta muestra progreso y «Cancelar»; el boton no se desactiva con foco (aria-disabled)", async () => {
    const control = pending();
    await mountTab(<ConvertTab />);
    const button = exportButton("powerpoint");
    button.focus();
    fireEvent.click(button);
    await within(card("powerpoint")).findByRole("progressbar");
    act(() => control.progress(0.4));
    expect(within(card("powerpoint")).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40");
    expect(within(card("powerpoint")).getByRole("button", { name: E.card.cancel })).toBeTruthy();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    await act(async () => control.resolve({ blob: new Blob(["x"]), filename: "a.pptx" }));
    await waitFor(() => expect(downloaded.items).toHaveLength(1));
    expect(within(card("powerpoint")).queryByRole("progressbar")).toBeNull();
  });

  it("«Cancelar» aborta la señal, avisa y devuelve el foco al boton de exportar (nunca a <body>)", async () => {
    const control = pending();
    const { doc } = await mountTab(<ConvertTab />);
    fireEvent.click(exportButton("excel"));
    const cancel = await within(card("excel")).findByRole("button", { name: E.card.cancel });
    cancel.focus();
    fireEvent.click(cancel);
    expect(control.signal().aborted).toBe(true);
    await waitFor(() => expect(within(card("excel")).queryByRole("button", { name: E.card.cancel })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(exportButton("excel")));
    expect(doc.getState().announcement?.text).toBe(E.card.cancelled);
    expect(downloaded.items).toHaveLength(0);
  });

  it("un resultado tardio de una exportacion cancelada no se descarga", async () => {
    let finish!: (value: { blob: Blob; filename: string }) => void;
    runner.run.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await mountTab(<ConvertTab />);
    fireEvent.click(exportButton("csv"));
    fireEvent.click(await within(card("csv")).findByRole("button", { name: E.card.cancel }));
    await act(async () => finish({ blob: new Blob(["tarde"]), filename: "tarde.csv" }));
    expect(downloaded.items).toHaveLength(0);
  });

  it("solo una exportacion a la vez: las demas tarjetas esperan y lo dicen", async () => {
    pending();
    await mountTab(<ConvertTab />);
    fireEvent.click(exportButton("markdown"));
    await within(card("markdown")).findByRole("progressbar");
    expect(exportButton("text").getAttribute("aria-disabled")).toBe("true");
    expect(within(card("text")).getByText(E.card.inProgressOther)).toBeTruthy();
    fireEvent.click(exportButton("text"));
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("cambiar de pestaña (desmontar) cancela la exportacion en curso", async () => {
    const control = pending();
    const view = await mountTab(<ConvertTab />);
    fireEvent.click(exportButton("json"));
    await within(card("json")).findByRole("progressbar");
    view.unmount();
    expect(control.signal().aborted).toBe(true);
  });
});

describe("red (OCR de respaldo)", () => {
  it("con OCR activo la tarjeta avisa de que puede requerir conexion", async () => {
    await mountTab(<ConvertTab />);
    expect(within(card("text")).getByText(E.card.mayNeedNetwork)).toBeTruthy();
    expect(within(card("text")).getByText(E.card.ocrNetwork)).toBeTruthy();
    expect(within(card("word")).getByText(E.card.mayNeedNetwork)).toBeTruthy();
  });

  it("sin OCR (casilla apagada) vuelve a decir «Solo en tu dispositivo»", async () => {
    await mountTab(<ConvertTab />);
    fireEvent.click(within(card("json")).getByRole("button", { name: E.card.showOptions }));
    fireEvent.click(within(card("json")).getByRole("checkbox"));
    expect(within(card("json")).getByText(E.card.localOnly)).toBeTruthy();
    expect(card("json").querySelector("[data-export-network]")).toBeNull();
  });

  it("imagenes, Excel, CSV y PowerPoint nunca hablan de red", async () => {
    await mountTab(<ConvertTab />);
    for (const id of ["images", "excel", "csv", "powerpoint"]) {
      expect(within(card(id)).getByText(E.card.localOnly)).toBeTruthy();
      expect(card(id).querySelector("[data-export-network]")).toBeNull();
    }
  });

  it("sin conexion y con OCR: avisa de que las paginas escaneadas no se podran reconocer", async () => {
    Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
    await mountTab(<ConvertTab />);
    expect(within(card("markdown")).getByText(E.card.ocrOffline)).toBeTruthy();
    expect(within(card("markdown")).queryByText(E.card.ocrNetwork)).toBeNull();
  });

  it("al volver la conexion el aviso cambia en caliente", async () => {
    Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
    await mountTab(<ConvertTab />);
    expect(within(card("text")).getByText(E.card.ocrOffline)).toBeTruthy();
    Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(within(card("text")).getByText(E.card.ocrNetwork)).toBeTruthy();
  });
});

describe("documento grande", () => {
  it("un snapshot de mas de 50 MB avisa de que exportar puede tardar", async () => {
    const { doc } = await mountTab(<ConvertTab />);
    await act(async () => {
      await doc.commit(new Uint8Array(51 * 1024 * 1024), "Grande", "operation", { pageCount: 3 });
    });
    expect(within(card("text")).getByText(E.card.largeDocument)).toBeTruthy();
  });

  it("uno pequeno no avisa", async () => {
    await mountTab(<ConvertTab />);
    expect(screen.queryByText(E.card.largeDocument)).toBeNull();
  });
});
