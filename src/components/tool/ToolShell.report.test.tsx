import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import type { BatchReport } from "@/lib/pdf/batchReport";
import { getTool } from "@/lib/tools-registry";

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

/**
 * `ProcessResult.report` (opcional): ToolShell lo reenvia a `DownloadScreen`
 * y a `renderDone`. Las herramientas que no lo devuelven no ven ningun cambio
 * (cubierto por `ToolShell.test.tsx`, sin tocar).
 */

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

describe("ToolShell — ProcessResult.report", () => {
  it("con fallos parciales muestra el aviso y lo pasa a renderDone", async () => {
    const report: BatchReport = {
      ok: [{ id: "a", name: "A.pdf", filename: "A-firmado.pdf" }],
      failed: [{ id: "b", name: "B.pdf", code: "corrupt" }],
    };
    const renderDone = vi.fn(({ result }: { result: ProcessResult }) => (
      <p>informe: {result.report?.failed.length}</p>
    ));
    const { container } = render(
      <LanguageProvider>
        <ToolShell<Options>
          tool={TOOL}
          defaultOptions={{ note: "" }}
          process={async () => ({ blob: new Blob(["x"]), filename: "Firmados - 1 documento.zip", report })}
          renderDone={renderDone}
        />
      </LanguageProvider>,
    );

    await uploadAndRun(container);

    await waitFor(() =>
      expect(screen.getByText("1 de 2 documentos firmados")).toBeTruthy(),
    );
    expect(screen.getByTestId("partial-failure-report").getAttribute("role")).toBe("status");
    expect(screen.getByText("informe: 1")).toBeTruthy();
    expect(renderDone).toHaveBeenCalled();
  });

  it("sin `report`: pantalla de descarga sin aviso", async () => {
    const { container } = render(
      <LanguageProvider>
        <ToolShell<Options>
          tool={TOOL}
          defaultOptions={{ note: "" }}
          process={async () => ({ blob: new Blob(["x"]), filename: "salida.pdf" })}
        />
      </LanguageProvider>,
    );

    await uploadAndRun(container);

    await waitFor(() => expect(screen.getByText("salida.pdf")).toBeTruthy());
    expect(screen.queryByTestId("partial-failure-report")).toBeNull();
  });
});
