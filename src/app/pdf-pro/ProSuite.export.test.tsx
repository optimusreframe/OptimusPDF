import "fake-indexeddb/auto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProToolClient } from "@/app/pdf-pro/ProToolClient";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { PdfError } from "@/lib/pdf/core";
import { clearHandoff } from "@/app/pdf-pro/proHandoff";
import { __resetProFeatureFlagsCacheForTests } from "@/app/pdf-pro/proFeatureFlags";
import {
  __closeWarmProDraftsConnectionForTests,
  __resetProDraftsMemoryForTests,
  clearAllProDrafts,
} from "@/app/pdf-pro/proDrafts";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { makePdfBytes, pdfFile } from "@/app/pdf-pro/proTestUtils";
import { __clearRegisteredCommandsForTests } from "@/app/pdf-pro/shell/proCommands";
import { __clearProActionsForTests } from "@/app/pdf-pro/shell/proActions";
import { __clearDraftThumbnailCacheForTests } from "@/app/pdf-pro/session/useDraftThumbnails";
import { clearRecentEntries } from "@/lib/recent";
import { es } from "@/lib/locales/es";
import { resetReducedMotionPrefCache } from "@/hooks/useReducedMotionPref";
import { installLayoutEnv, pdfMocks, resetViewerGlobals, settle, type LayoutEnv } from "@/app/pdf-pro/viewer/viewerTestUtils";

/**
 * Wave 9 · exportacion persistente, en la suite COMPLETA (ProToolClient, pdf.js simulado, motor de exportacion
 * simulado): la exportacion sigue corriendo al cambiar de pestaña, el indicador de la barra superior la muestra y la
 * cancela desde cualquier pestaña, y cerrar el documento o abrir otro con una exportacion en curso pide confirmar.
 */

const downloaded = vi.hoisted(() => ({ blobs: [] as { blob: Blob; name: string }[] }));
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  const utils = await import("@/app/pdf-pro/viewer/viewerMocks");
  return {
    ...actual,
    downloadBlob: (blob: Blob, name: string) => downloaded.blobs.push({ blob, name }),
    openPdfDocument: utils.pdfMocks.open,
    closePdfDocument: utils.pdfMocks.close,
    renderPageToDataUrl: utils.pdfMocks.thumb,
  };
});
vi.mock("@/lib/pdf/pageRaster", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/pageRaster")>();
  const utils = await import("@/app/pdf-pro/viewer/viewerMocks");
  return { ...actual, renderPageRaster: utils.pdfMocks.render };
});
vi.mock("@/app/pdf-pro/ops/previewRender", () => ({ renderPreviewDataUrl: vi.fn(async () => "data:image/png;base64,AAAA") }));

const runner = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/app/pdf-pro/export/exportRunners", () => ({ runExportFormat: runner.run }));

const S = PRO_STRINGS.es;
const E = S.export;
let env: LayoutEnv;

type Engine = {
  resolve: (filename?: string) => void;
  reject: (error: unknown) => void;
  progress: (value: number) => void;
  signal: () => AbortSignal;
  inputs: () => Array<{ file: File; name: string; pageCount?: number }>;
};

/** El proximo `runExportFormat` queda pendiente hasta que la prueba lo resuelva (y se entera de la cancelacion). */
function pendingEngine(): Engine {
  let resolve!: (value: { blob: Blob; filename: string }) => void;
  let reject!: (error: unknown) => void;
  let signal!: AbortSignal;
  let progress!: (value: number) => void;
  const inputs: Array<{ file: File; name: string; pageCount?: number }> = [];
  runner.run.mockImplementationOnce(
    (_id: string, input: { signal: AbortSignal; onProgress: (value: number) => void; file: File; name: string; pageCount?: number }) =>
      new Promise((done, fail) => {
        signal = input.signal;
        progress = input.onProgress;
        inputs.push({ file: input.file, name: input.name, pageCount: input.pageCount });
        resolve = done;
        reject = fail;
        input.signal.addEventListener("abort", () => fail(new PdfError("cancelled")));
      }),
  );
  return {
    resolve: (filename = "informe-word.docx") => resolve({ blob: new Blob(["w"]), filename }),
    reject: (error) => reject(error),
    progress: (value) => progress(value),
    signal: () => signal,
    inputs: () => inputs,
  };
}

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

beforeEach(async () => {
  env = installLayoutEnv({ width: 1100, height: 700 });
  resetViewerGlobals();
  downloaded.blobs.length = 0;
  runner.run.mockReset();
  clearHandoff();
  clearRecentEntries();
  window.localStorage.removeItem("optimuspdf.pro.featureFlags");
  __resetProFeatureFlagsCacheForTests();
  __resetProDraftsMemoryForTests();
  __closeWarmProDraftsConnectionForTests();
  __clearDraftThumbnailCacheForTests();
  await clearAllProDrafts();
  __clearRegisteredCommandsForTests();
  __clearProActionsForTests();
});

afterEach(() => {
  cleanup();
  env.restore();
  vi.unstubAllGlobals();
  resetReducedMotionPrefCache();
  document.documentElement.removeAttribute("data-pro-suite");
});

const dropzoneInput = (container: HTMLElement) => container.querySelector('input[type="file"]') as HTMLInputElement;

async function openPro(pages = 3, name = "informe.pdf") {
  pdfMocks.state.defaultPages = pages;
  const utils = render(
    <LanguageProvider>
      <ProToolClient />
    </LanguageProvider>,
  );
  const bytes = await makePdfBytes(pages);
  fireEvent.change(dropzoneInput(utils.container), { target: { files: [pdfFile(bytes, name)] } });
  await screen.findByRole("heading", { level: 1, name: new RegExp(name.replace(".", "\\.")) });
  await settle();
  return Object.assign(utils, { bytes });
}

const goTo = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));
const indicator = () => document.querySelector<HTMLElement>("[data-export-indicator]");
const card = (id: string) => document.querySelector<HTMLElement>(`[data-export="${id}"]`)!;

async function startExport(id = "word") {
  goTo("Convertir");
  const button = await within(card(id)).findByRole("button", { name: E.formats[id as keyof typeof E.formats].title });
  fireEvent.click(button);
  await within(card(id)).findByRole("progressbar");
}

describe("la exportacion sigue al cambiar de pestaña", () => {
  it("se ve en la barra superior desde Inicio y Paginas, sin cancelarse; al volver, la tarjeta muestra el progreso", async () => {
    const engine = pendingEngine();
    await openPro();
    await startExport("word");
    act(() => engine.progress(0.4));
    const top = document.querySelector<HTMLElement>('[data-pro-region="top"]')!;
    expect(top.contains(indicator())).toBe(true);
    expect(within(indicator()!).getByText(E.indicator.running("Word"))).toBeTruthy();
    expect(within(indicator()!).getByText(E.indicator.percent(40))).toBeTruthy();

    for (const name of ["Inicio", "Páginas", "Proteger"]) {
      goTo(name);
      await settle();
      expect(engine.signal().aborted).toBe(false);
      expect(top.contains(indicator())).toBe(true);
    }
    act(() => engine.progress(0.75));
    expect(within(indicator()!).getByText(E.indicator.percent(75))).toBeTruthy();

    goTo("Convertir");
    const bar = await within(card("word")).findByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("75");
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(downloaded.blobs).toEqual([]);
  });

  it("terminar en otra pestaña: UNA descarga, se anuncia, el indicador se va y la tarjeta guarda el resultado", async () => {
    const engine = pendingEngine();
    await openPro();
    await startExport("word");
    goTo("Páginas");
    await settle();
    await act(async () => engine.resolve("informe-word.docx"));
    expect(downloaded.blobs.map((item) => item.name)).toEqual(["informe-word.docx"]);
    expect(indicator()).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(E.card.done("informe-word.docx"));
    goTo("Convertir");
    expect(await within(card("word")).findByText(E.card.result("informe-word.docx", "Original"))).toBeTruthy();
    expect(downloaded.blobs).toHaveLength(1);
  });

  it("«Cancelar» del indicador funciona desde otra pestaña: aborta, anuncia una vez y el foco queda en el titulo", async () => {
    const engine = pendingEngine();
    await openPro();
    await startExport("excel");
    goTo("Inicio");
    await settle();
    const cancel = within(indicator()!).getByRole("button", { name: E.indicator.cancelLabel("Excel") });
    cancel.focus();
    fireEvent.click(cancel);
    expect(engine.signal().aborted).toBe(true);
    expect(indicator()).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(E.card.cancelled);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
    goTo("Convertir");
    expect(await within(card("excel")).findByText(E.card.cancelled)).toBeTruthy();
    expect(downloaded.blobs).toEqual([]);
  });

  it("sigue habiendo UNA sola region viva (el indicador no suma otra) y un error lejos de «Convertir» se anuncia ahi", async () => {
    const engine = pendingEngine();
    await openPro();
    await startExport("powerpoint");
    goTo("Inicio");
    await settle();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    await act(async () => engine.reject(new PdfError("offline")));
    expect(indicator()).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(E.notices.failedAway("PowerPoint"));
    goTo("Convertir");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(es.tool.errors.offline);
  });

  it("aplicar una operacion DURANTE la exportacion: el motor recibio el documento de inicio y el resultado dice de que version es", async () => {
    const engine = pendingEngine();
    const { bytes } = await openPro(3);
    const originalSize = bytes.byteLength;
    await startExport("word");
    goTo("Inicio");
    fireEvent.click(await screen.findByRole("button", { name: S.operations.rotateAll90 }));
    await screen.findByText(S.suite.unsaved);
    // El motor ya habia recibido el PDF original (no el girado) y el indicador sigue.
    expect(engine.inputs()[0].file.size).toBe(originalSize);
    expect(indicator()).not.toBeNull();
    await act(async () => engine.resolve("informe-word.docx"));
    goTo("Convertir");
    const result = await within(card("word")).findByText(E.card.result("informe-word.docx", "Original"), { exact: false });
    expect(result.textContent).toContain(E.card.versionChanged);
  });
});

describe("cerrar el documento o abrir otro con una exportacion en curso", () => {
  it("cerrar pide confirmar con el texto de la exportacion; «Cancelar» la deja correr", async () => {
    const engine = pendingEngine();
    await openPro();
    await startExport("word");
    fireEvent.click(screen.getByRole("button", { name: S.suite.close }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(E.notices.closeOnly("Word"))).toBeTruthy();
    expect(within(dialog).queryByText(S.suite.closeConfirmBody)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: S.suite.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(engine.signal().aborted).toBe(false);
    expect(screen.getByRole("tablist")).toBeTruthy();
    expect(indicator()).not.toBeNull();
  });

  it("confirmar cierra el documento, cancela la exportacion y NO descarga nada aunque el motor termine tarde", async () => {
    const engine = pendingEngine();
    await openPro();
    await startExport("word");
    fireEvent.click(screen.getByRole("button", { name: S.suite.close }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: S.suite.close }));
    expect(await screen.findByText(es.tool.dropTitle)).toBeTruthy();
    expect(engine.signal().aborted).toBe(true);
    expect(indicator()).toBeNull();
    await act(async () => engine.resolve("tarde.docx"));
    expect(downloaded.blobs).toEqual([]);
  });

  it("exportacion + cambios sin descargar: la hoja de cierre dice las dos cosas", async () => {
    pendingEngine();
    await openPro();
    fireEvent.click(screen.getByRole("button", { name: S.operations.rotateAll90 }));
    await screen.findByText(S.suite.unsaved);
    await startExport("csv");
    fireEvent.click(screen.getByRole("button", { name: S.suite.close }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(`${S.suite.closeConfirmBody} ${E.notices.also("CSV")}`)).toBeTruthy();
  });

  it("sin exportacion el cierre sin cambios sigue siendo inmediato (y con exportacion terminada tambien)", async () => {
    const engine = pendingEngine();
    await openPro(1);
    await startExport("json");
    await act(async () => engine.resolve("datos.json"));
    fireEvent.click(screen.getByRole("button", { name: S.suite.close }));
    expect(await screen.findByText(es.tool.dropTitle)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("«Abrir otro PDF» pide confirmar; confirmar cancela la exportacion y abre el otro sin descarga del anterior", async () => {
    const engine = pendingEngine();
    await openPro(3, "uno.pdf");
    await startExport("word");
    const input = document.querySelector<HTMLInputElement>("[data-pro-open-input]")!;
    fireEvent.change(input, { target: { files: [pdfFile(await makePdfBytes(2), "dos.pdf")] } });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(E.notices.replaceOnly("Word"))).toBeTruthy();
    expect(engine.signal().aborted).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: S.session.replaceConfirm }));
    await screen.findByRole("heading", { level: 1, name: /dos\.pdf/ });
    expect(engine.signal().aborted).toBe(true);
    expect(indicator()).toBeNull();
    await act(async () => engine.resolve("tarde.docx"));
    expect(downloaded.blobs).toEqual([]);
    // La tarjeta del documento nuevo esta limpia.
    goTo("Convertir");
    expect(within(card("word")).queryByRole("progressbar")).toBeNull();
    expect(within(card("word")).queryByText(E.card.cancelled)).toBeNull();
  });
});

/**
 * Wave 10 · C-B2: cerrar o recargar el NAVEGADOR (no el documento) con una exportacion en curso pide confirmacion, igual
 * que con cambios sin guardar o un paso en vuelo: el archivo que se iba a descargar vive solo en esta pestaña. Se retira
 * en cuanto la exportacion termina, se cancela, falla o el documento se cierra.
 */
describe("cerrar o recargar el navegador con una exportacion en curso", () => {
  /** Dispara `beforeunload` como lo haria el navegador y dice si se pidio confirmacion (`preventDefault`). */
  function beforeUnloadPrevented(): boolean {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it("sin exportacion y sin cambios, no pide confirmacion; con una exportacion en curso, si", async () => {
    pendingEngine();
    await openPro();
    expect(beforeUnloadPrevented()).toBe(false);
    await startExport("word");
    expect(beforeUnloadPrevented()).toBe(true);
    // En cualquier pestaña: el aviso es de la pagina, no de la tarjeta.
    goTo("Inicio");
    await settle();
    expect(beforeUnloadPrevented()).toBe(true);
  });

  it("al terminar la exportacion el aviso se retira", async () => {
    const engine = pendingEngine();
    await openPro();
    await startExport("word");
    expect(beforeUnloadPrevented()).toBe(true);
    await act(async () => engine.resolve("informe-word.docx"));
    expect(downloaded.blobs).toHaveLength(1);
    expect(beforeUnloadPrevented()).toBe(false);
  });

  it("al cancelarla desde el indicador el aviso se retira", async () => {
    const engine = pendingEngine();
    await openPro();
    await startExport("excel");
    goTo("Inicio");
    await settle();
    expect(beforeUnloadPrevented()).toBe(true);
    fireEvent.click(within(indicator()!).getByRole("button", { name: E.indicator.cancelLabel("Excel") }));
    expect(engine.signal().aborted).toBe(true);
    expect(beforeUnloadPrevented()).toBe(false);
  });

  it("si la exportacion falla el aviso se retira", async () => {
    const engine = pendingEngine();
    await openPro();
    await startExport("json");
    expect(beforeUnloadPrevented()).toBe(true);
    await act(async () => engine.reject(new PdfError("offline")));
    expect(beforeUnloadPrevented()).toBe(false);
  });

  it("al cerrar el documento (confirmando) el aviso se retira junto con la exportacion", async () => {
    const engine = pendingEngine();
    await openPro();
    await startExport("word");
    fireEvent.click(screen.getByRole("button", { name: S.suite.close }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: S.suite.close }));
    expect(await screen.findByText(es.tool.dropTitle)).toBeTruthy();
    expect(engine.signal().aborted).toBe(true);
    expect(beforeUnloadPrevented()).toBe(false);
  });

  it("una exportacion ya terminada no deja el aviso puesto aunque su resultado siga en la tarjeta", async () => {
    const engine = pendingEngine();
    await openPro();
    await startExport("csv");
    await act(async () => engine.resolve("datos.csv"));
    goTo("Convertir");
    expect(await within(card("csv")).findByText(E.card.result("datos.csv", "Original"))).toBeTruthy();
    expect(beforeUnloadPrevented()).toBe(false);
  });
});
