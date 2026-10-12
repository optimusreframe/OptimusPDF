import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { es } from "@/lib/locales/es";
import { PdfError } from "@/lib/pdf/core";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { DocumentTab } from "@/app/pdf-pro/tabs/DocumentTab";
import { labelsOf, mountTab } from "@/app/pdf-pro/tabs/docTestUtils";
import { __resetPageInfoCacheForTests } from "@/app/pdf-pro/ops/pageInfo";

/**
 * Comportamiento comun de «Aplicar» (U5) con el motor de OCR controlado a mano: progreso, cancelacion,
 * un solo pulso, errores tipados, resultado tardio descartado y avisos.
 */

const ocr = vi.hoisted(() => ({
  run: vi.fn(),
}));
vi.mock("@/lib/pdf/ocr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/ocr")>();
  return { ...actual, ocrPdf: (...args: unknown[]) => ocr.run(...args) };
});
const reload = vi.hoisted(() => ({ page: vi.fn() }));
vi.mock("@/lib/reloadPage", () => ({ reloadPage: () => reload.page() }));
vi.mock("@/app/pdf-pro/ops/previewRender", () => ({ renderPreviewDataUrl: vi.fn(async () => null) }));

const S = PRO_STRINGS.es;
const T = S.docTools;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  // El foco de los paneles usa `useFocusTarget` (fase de layout): sus candidatos exigen una caja que jsdom no calcula.
  Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 1, height: 1 }] as unknown as DOMRectList;
  };
});
beforeEach(() => {
  ocr.run.mockReset();
  reload.page.mockReset();
  __resetPageInfoCacheForTests();
});
afterEach(() => cleanup());

async function openOcr() {
  const mounted = await mountTab(<DocumentTab />);
  fireEvent.click(screen.getByRole("button", { name: T.launcher.open(T.tools.ocr.title) }));
  await screen.findByRole("heading", { level: 2, name: T.tools.ocr.title });
  return mounted;
}
const apply = () => screen.getByRole("button", { name: /^(Aplicar|Aplicando…)$/ });

function controllable(bytes: Uint8Array) {
  let resolve!: (blob: Blob) => void;
  let reject!: (error: unknown) => void;
  let signal: AbortSignal | undefined;
  let progress: ((value: number) => void) | undefined;
  ocr.run.mockImplementation(
    (_file: File, _options: unknown, onProgress: (value: number) => void, abort: AbortSignal) =>
      new Promise<Blob>((res, rej) => {
        resolve = res;
        reject = rej;
        signal = abort;
        progress = onProgress;
      }),
  );
  return {
    finish: () => resolve(new Blob([bytes as unknown as BlobPart])),
    fail: (error: unknown) => reject(error),
    progress: (value: number) => progress?.(value),
    get signal() {
      return signal;
    },
  };
}

describe("Aplicar", () => {
  it("aplica con el idioma elegido, crea un snapshot con etiqueta descriptiva y vuelve a quedar libre", async () => {
    const { doc } = await openOcr();
    const control = controllable(doc.current()!.slice());
    fireEvent.click(apply());
    await waitFor(() => expect(ocr.run).toHaveBeenCalledTimes(1));
    expect(ocr.run.mock.calls[0][1]).toEqual({ language: "spa" });
    await act(async () => control.finish());
    await waitFor(() => expect(labelsOf(doc)).toEqual(["Original", "Reconocer texto (Español)"]));
    expect(apply().textContent).toBe(T.runner.apply);
    expect(apply().getAttribute("aria-disabled")).toBeNull();
  });

  it("durante la ejecucion muestra progreso real, «Cancelar» y deja «Aplicando…» inactivo (y conserva el foco)", async () => {
    const { doc } = await openOcr();
    const control = controllable(doc.current()!.slice());
    // El panel enfoca su titulo al abrirse (rAF): se espera a eso antes de dar el foco al boton.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: T.tools.ocr.title })));
    apply().focus();
    fireEvent.click(apply());
    const bar = await screen.findByRole("progressbar");
    await act(async () => control.progress(0.4));
    await waitFor(() => expect(Number(bar.getAttribute("aria-valuenow"))).toBeCloseTo(40, 0));
    expect(apply().textContent).toBe(T.runner.applying);
    expect(apply().getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(apply());
    expect(screen.getByRole("button", { name: T.runner.cancel })).toBeTruthy();
    await act(async () => control.finish());
  });

  it("pulsar «Aplicar» dos veces seguidas lanza el motor UNA vez", async () => {
    const { doc } = await openOcr();
    const control = controllable(doc.current()!.slice());
    fireEvent.click(apply());
    fireEvent.click(apply());
    fireEvent.click(apply());
    await act(async () => {});
    expect(ocr.run).toHaveBeenCalledTimes(1);
    await act(async () => control.finish());
    await waitFor(() => expect(labelsOf(doc)).toHaveLength(2));
  });

  it("«Cancelar» aborta la senal del motor, no crea snapshot y lo dice", async () => {
    const { doc } = await openOcr();
    const control = controllable(doc.current()!.slice());
    fireEvent.click(apply());
    await screen.findByRole("progressbar");
    fireEvent.click(screen.getByRole("button", { name: T.runner.cancel }));
    expect(control.signal?.aborted).toBe(true);
    await screen.findByText(S.suite.cancelled);
    // El resultado tardio del motor se ignora.
    await act(async () => control.finish());
    expect(labelsOf(doc)).toEqual(["Original"]);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(apply().getAttribute("aria-disabled")).toBeNull();
  });

  it("tras cancelar se puede volver a aplicar", async () => {
    const { doc } = await openOcr();
    let control = controllable(doc.current()!.slice());
    fireEvent.click(apply());
    await screen.findByRole("progressbar");
    fireEvent.click(screen.getByRole("button", { name: T.runner.cancel }));
    await screen.findByText(S.suite.cancelled);
    control = controllable(doc.current()!.slice());
    fireEvent.click(apply());
    await waitFor(() => expect(ocr.run).toHaveBeenCalledTimes(2));
    await act(async () => control.finish());
    await waitFor(() => expect(labelsOf(doc)).toHaveLength(2));
  });

  it("un fallo de red del OCR se explica con el mensaje claro y no crea snapshot", async () => {
    const { doc } = await openOcr();
    const control = controllable(doc.current()!.slice());
    fireEvent.click(apply());
    await act(async () => control.fail(new PdfError("ocrNetworkFailure")));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(es.tool.errors.ocrNetworkFailure);
    expect(labelsOf(doc)).toEqual(["Original"]);
    expect(apply().getAttribute("aria-disabled")).toBeNull();
  });

  it("sin conexion (`offline`): el aviso lo explica, ofrece «Recargar la página» y el boton recarga de verdad", async () => {
    const { doc } = await openOcr();
    const control = controllable(doc.current()!.slice());
    fireEvent.click(apply());
    await act(async () => control.fail(new PdfError("offline")));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(es.tool.errors.offline);
    expect(es.tool.errors.offline).toMatch(/recarga/i);
    const button = screen.getByRole("button", { name: es.tool.errors.reloadAction });
    expect(reload.page).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(reload.page).toHaveBeenCalledTimes(1);
    expect(labelsOf(doc)).toEqual(["Original"]);
  });

  it("los demas errores no ofrecen «Recargar la página» (no prometen lo que no hacen)", async () => {
    const { doc } = await openOcr();
    const control = controllable(doc.current()!.slice());
    fireEvent.click(apply());
    await act(async () => control.fail(new PdfError("ocrNetworkFailure")));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: es.tool.errors.reloadAction })).toBeNull();
  });

  it("un error inesperado cae a «unknown» sin romper el panel", async () => {
    const { doc } = await openOcr();
    const control = controllable(doc.current()!.slice());
    fireEvent.click(apply());
    await act(async () => control.fail(new Error("algo raro")));
    expect((await screen.findByRole("alert")).textContent).toContain(es.tool.errors.unknown);
    expect(labelsOf(doc)).toEqual(["Original"]);
  });

  it("si mientras corre se cambia de snapshot (deshacer), el resultado ya no aplica", async () => {
    const { doc } = await openOcr();
    await doc.commit(doc.current()!.slice(), "Previo", "operation", { pageCount: 3 });
    const control = controllable(doc.current()!.slice());
    fireEvent.click(apply());
    await screen.findByRole("progressbar");
    act(() => {
      doc.undo();
    });
    await act(async () => control.finish());
    await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
    expect(labelsOf(doc)).toEqual(["Original"]);
    expect(doc.getState().canRedo).toBe(true);
  });

  it("el resultado `unchanged` no crea snapshot y se explica", async () => {
    const { doc } = await openOcr();
    controllable(doc.current()!.slice());
    // Compresion sin ganancia: pasa por la rama `unchanged` del hook.
    cleanup();
    const mounted = await mountTab(<DocumentTab />);
    fireEvent.click(screen.getByRole("button", { name: T.launcher.open(T.tools.compress.title) }));
    await screen.findByRole("heading", { level: 2, name: T.tools.compress.title });
    fireEvent.click(screen.getByRole("button", { name: T.runner.apply }));
    expect(await screen.findByText(S.warnings.unchanged)).toBeTruthy();
    expect(labelsOf(mounted.doc)).toEqual(["Original"]);
    expect(mounted.doc.getState().announcement?.text).toBe(S.warnings.unchanged);
  });

  it("OCR: cada panel de OCR muestra el aviso «Requiere conexión» antes de aplicar", async () => {
    await openOcr();
    expect(screen.getAllByText(T.runner.networkBadge).length).toBeGreaterThan(0);
  });

  it("al desmontar con una ejecucion en curso se cancela (no queda trabajo huerfano)", async () => {
    const { doc, unmount } = await openOcr();
    const control = controllable(doc.current()!.slice());
    fireEvent.click(apply());
    await screen.findByRole("progressbar");
    unmount();
    expect(control.signal?.aborted).toBe(true);
  });
});
