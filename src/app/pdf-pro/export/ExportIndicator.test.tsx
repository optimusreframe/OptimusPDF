import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { PdfError } from "@/lib/pdf/core";
import { ExportIndicator } from "@/app/pdf-pro/export/ExportIndicator";
import { getExportStore } from "@/app/pdf-pro/export/exportStore";
import { getExportStrings } from "@/app/pdf-pro/export/exportStrings";
import type { ProExport, ProExportContext, ProExportResult } from "@/app/pdf-pro/ops/proExports";
import { mountTab } from "@/app/pdf-pro/tabs/docTestUtils";

/**
 * Indicador global de la exportacion en curso (Wave 9): se ve y se cancela desde cualquier pestaña, no es una region
 * viva, mide 44 px y devuelve el foco al titulo del documento sin pasar por <body>.
 */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, downloadBlob: vi.fn() };
});

const ES = getExportStrings("es");

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
afterEach(() => cleanup());

function Bar() {
  // La barra superior real: region «top» con el titulo enfocable (tabIndex -1) y el indicador a su lado.
  return (
    <div data-pro-region="top">
      <h1 tabIndex={-1}>Documento</h1>
      <ExportIndicator />
      <button type="button">Descargar</button>
    </div>
  );
}

function engine(id = "word") {
  const calls: ProExportContext[] = [];
  let resolve!: (result: ProExportResult) => void;
  let reject!: (error: unknown) => void;
  const entry: ProExport = {
    id,
    title: () => id,
    body: () => id,
    slug: "pdf-to-word",
    requiresNetwork: false,
    run: (_bytes, context) => {
      calls.push(context);
      return new Promise<ProExportResult>((done, fail) => {
        resolve = done;
        reject = fail;
        context.signal.addEventListener("abort", () => fail(new PdfError("cancelled")));
      });
    },
  };
  return {
    entry,
    calls,
    progress: (value: number) => calls[0].onProgress(value),
    resolve: () => resolve({ blob: new Blob(["x"]), filename: "a.docx" }),
    reject: (error: unknown) => reject(error),
  };
}

const start = (doc: Parameters<typeof getExportStore>[0], entry: ProExport, language: "es" | "en" = "es") =>
  getExportStore(doc).start({ entry, options: {}, selectedPages: [], language });

const indicator = () => document.querySelector<HTMLElement>("[data-export-indicator]");

describe("ExportIndicator", () => {
  it("en reposo no pinta nada (ni region vacia)", async () => {
    await mountTab(<Bar />);
    expect(indicator()).toBeNull();
    expect(screen.queryByRole("group", { name: ES.indicator.group })).toBeNull();
  });

  it("mientras exporta: grupo con nombre, «Exportando a Word… 0 %», barra de progreso y «Cancelar»", async () => {
    const { doc } = await mountTab(<Bar />);
    const control = engine("word");
    act(() => void start(doc, control.entry));
    const group = screen.getByRole("group", { name: ES.indicator.group });
    expect(group).toBe(indicator());
    expect(within(group).getByText(ES.indicator.running(ES.formatsShort.word))).toBeTruthy();
    expect(within(group).getByText(ES.indicator.percent(0))).toBeTruthy();
    const bar = within(group).getByRole("progressbar", { name: ES.indicator.progressLabel("Word") });
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    const cancel = within(group).getByRole("button", { name: ES.indicator.cancelLabel("Word") });
    // La etiqueta visible «Cancelar» esta en el nombre accesible (WCAG 2.5.3) y el boton mide 44 px (h-11).
    expect(cancel.textContent).toBe(ES.indicator.cancel);
    expect(cancel.getAttribute("aria-label")).toContain(ES.indicator.cancel);
    expect(cancel.className).toContain("h-11");
  });

  it("el porcentaje se actualiza en el texto y en la barra (la ultima version de la copia fija)", async () => {
    const { doc } = await mountTab(<Bar />);
    const control = engine("excel");
    act(() => void start(doc, control.entry));
    act(() => control.progress(0.42));
    expect(screen.getByText(ES.indicator.running("Excel"))).toBeTruthy();
    expect(screen.getByText(ES.indicator.percent(42))).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");
    expect((screen.getByRole("progressbar").firstElementChild as HTMLElement).style.transform).toBe("scaleX(0.42)");
  });

  it("NO es una region viva ni anuncia el progreso: la unica region de PDF Pro lleva los avisos", async () => {
    const { doc } = await mountTab(<Bar />);
    const control = engine("word");
    act(() => void start(doc, control.entry));
    const group = indicator()!;
    expect(group.querySelector('[role="status"], [role="alert"], [aria-live]')).toBeNull();
    expect(group.getAttribute("aria-live")).toBeNull();
    const announced = doc.getState().announcement!.id;
    act(() => control.progress(0.2));
    act(() => control.progress(0.8));
    expect(doc.getState().announcement!.id).toBe(announced);
  });

  it("«Cancelar» cancela, anuncia una vez, quita el indicador y deja el foco en el titulo (nunca <body>)", async () => {
    const { doc } = await mountTab(<Bar />);
    const control = engine("word");
    act(() => void start(doc, control.entry));
    const cancel = screen.getByRole("button", { name: ES.indicator.cancelLabel("Word") });
    cancel.focus();
    fireEvent.click(cancel);
    expect(control.calls[0].signal.aborted).toBe(true);
    expect(indicator()).toBeNull();
    expect(doc.getState().announcement?.text).toBe(ES.card.cancelled);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
  });

  it("si la exportacion TERMINA sola con el foco en «Cancelar», el foco pasa al titulo (nunca <body>)", async () => {
    const { doc } = await mountTab(<Bar />);
    const control = engine("word");
    act(() => void start(doc, control.entry));
    screen.getByRole("button", { name: ES.indicator.cancelLabel("Word") }).focus();
    await act(async () => control.resolve());
    expect(indicator()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
  });

  it("un foco que estaba en OTRO control no se mueve cuando el indicador desaparece", async () => {
    const { doc } = await mountTab(<Bar />);
    const control = engine("word");
    act(() => void start(doc, control.entry));
    const download = screen.getByRole("button", { name: "Descargar" });
    download.focus();
    await act(async () => control.resolve());
    expect(document.activeElement).toBe(download);
  });

  it("desaparece al terminar con error, al cerrar el documento y al descartar", async () => {
    const { doc } = await mountTab(<Bar />);
    const failing = engine("word");
    act(() => void start(doc, failing.entry));
    await act(async () => failing.reject(new PdfError("offline")));
    expect(indicator()).toBeNull();
    const again = engine("excel");
    act(() => void start(doc, again.entry));
    expect(indicator()).not.toBeNull();
    act(() => doc.close());
    expect(indicator()).toBeNull();
  });

  it("el indicador ocupa su PROPIA fila de la barra (order-last + basis-full) en cualquier ancho", async () => {
    const { doc } = await mountTab(<Bar />);
    act(() => void start(doc, engine("word").entry));
    const row = indicator()!.parentElement!;
    expect(row.className).toContain("order-last");
    expect(row.className).toContain("basis-full");
    // La pildora esta dentro de esa fila (hijo directo de la barra) y el porcentaje no se recorta (shrink-0).
    expect(row.parentElement?.getAttribute("data-pro-region")).toBe("top");
    expect(screen.getByText(ES.indicator.percent(0)).className).toContain("shrink-0");
  });
});
