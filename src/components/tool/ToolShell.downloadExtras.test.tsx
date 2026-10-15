import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { downloadBlob } from "@/lib/pdf/core";
import { getTool } from "@/lib/tools-registry";

/**
 * `renderDownloadExtras` y `onDownloaded` (F0 · U0.4 / U0.7): Firmar PDF pone dentro de la tarjeta de descarga la casilla
 * «Borrar el borrador de esta firma» y la opcion «E-sign», y borra el borrador SOLO cuando se pulsa «Descargar».
 */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, downloadBlob: vi.fn() };
});

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
afterEach(() => {
  cleanup();
  vi.mocked(downloadBlob).mockClear();
});

const TOOL = getTool("merge-pdf");
type Options = { note: string };

function pdfFile(name = "a.pdf"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "application/pdf" });
}

async function uploadAndRun(container: HTMLElement): Promise<void> {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [pdfFile()] } });
  const buttons = await screen.findAllByRole("button", { name: "Procesar" });
  fireEvent.click(buttons[0]);
}

function renderShell(props: Partial<React.ComponentProps<typeof ToolShell<Options>>> = {}) {
  const result: ProcessResult = {
    blob: new Blob(["x"]),
    filename: "salida.pdf",
    secondaryDownload: { label: "Descargar registro (.json)", blob: new Blob(["{}"]), filename: "registro.json" },
  };
  return render(
    <LanguageProvider>
      <ToolShell<Options> tool={TOOL} defaultOptions={{ note: "n" }} process={async () => result} {...props} />
    </LanguageProvider>,
  );
}

describe("ToolShell — renderDownloadExtras / onDownloaded", () => {
  it("las opciones salen DENTRO de la tarjeta de descarga, justo bajo «Descargar», con el resultado y las opciones", async () => {
    const renderDownloadExtras = vi.fn(({ result, options }: { result: ProcessResult; options: Options }) => (
      <label>
        <input type="checkbox" defaultChecked /> opcion de {result.filename} ({options.note})
      </label>
    ));
    const { container } = renderShell({ renderDownloadExtras });
    await uploadAndRun(container);
    const card = (await screen.findByRole("heading", { name: /Listo/ })).closest("section") as HTMLElement;
    const extras = card.querySelector("[data-download-extras]") as HTMLElement;
    expect(extras).toBeTruthy();
    expect(within(extras).getByRole("checkbox", { name: "opcion de salida.pdf (n)" })).toBeTruthy();
    const download = within(card).getByRole("button", { name: "Descargar" });
    expect(download.compareDocumentPosition(extras) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("sin `renderDownloadExtras` la tarjeta es exactamente la de siempre", async () => {
    const { container } = renderShell();
    await uploadAndRun(container);
    await screen.findByRole("button", { name: "Descargar" });
    expect(container.querySelector("[data-download-extras]")).toBeNull();
  });

  it("`onDownloaded` se llama al pulsar «Descargar», despues de lanzar la descarga, con el resultado y las opciones", async () => {
    const onDownloaded = vi.fn();
    const { container } = renderShell({ onDownloaded });
    await uploadAndRun(container);
    await screen.findByRole("button", { name: "Descargar" });
    expect(onDownloaded).not.toHaveBeenCalled();
    expect(downloadBlob).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Descargar" }));
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    expect(onDownloaded).toHaveBeenCalledTimes(1);
    const [context] = onDownloaded.mock.calls[0];
    expect(context.result.filename).toBe("salida.pdf");
    expect(context.options).toEqual({ note: "n" });
    expect(vi.mocked(downloadBlob).mock.invocationCallOrder[0]).toBeLessThan(onDownloaded.mock.invocationCallOrder[0]);
  });

  it("la descarga SECUNDARIA (el registro .json) y «Empezar de nuevo» NO cuentan como descargar", async () => {
    const onDownloaded = vi.fn();
    const { container } = renderShell({ onDownloaded });
    await uploadAndRun(container);
    fireEvent.click(await screen.findByRole("button", { name: "Descargar registro (.json)" }));
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    expect(onDownloaded).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Empezar de nuevo" }));
    expect(onDownloaded).not.toHaveBeenCalled();
  });

  it("nada de esto aparece fuera de la pantalla de resultado", async () => {
    const renderDownloadExtras = vi.fn(() => <p>extras</p>);
    renderShell({ renderDownloadExtras });
    await waitFor(() => expect(screen.queryByText("extras")).toBeNull());
    expect(renderDownloadExtras).not.toHaveBeenCalled();
  });
});
