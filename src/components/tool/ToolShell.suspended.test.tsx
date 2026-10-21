import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToolShell } from "@/components/tool/ToolShell";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { getTool } from "@/lib/tools-registry";

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
afterEach(() => vi.unstubAllGlobals());

/** Un telefono: la hoja «Opciones» es un `Sheet` (dialogo), no el panel lateral de escritorio. */
function stubPhone() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: /max-width/.test(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));
}

/**
 * `suspended` (integracion movil/iPad M4): otra pantalla (el editor de plantillas de Firmar) tapa la herramienta, que sigue
 * montada. La hoja «Opciones» del movil, si estaba abierta, se cierra en vez de quedarse encima del editor.
 */
const TOOL = getTool("merge-pdf");
type Options = { note: string };

function Harness({ suspended }: { suspended: boolean }) {
  return (
    <LanguageProvider>
      <ToolShell<Options>
        tool={TOOL}
        defaultOptions={{ note: "" }}
        process={async () => ({ blob: new Blob(["x"]), filename: "salida.pdf" })}
        suspended={suspended}
        renderOptions={() => <p>contenido de las opciones</p>}
      />
    </LanguageProvider>
  );
}

function pdfFile(): File {
  return new File([new Uint8Array([1, 2, 3])], "a.pdf", { type: "application/pdf" });
}

describe("ToolShell — suspended", () => {
  it("cierra el panel «Opciones» abierto cuando otra pantalla pasa a primer plano", async () => {
    stubPhone();
    const { container, rerender } = render(<Harness suspended={false} />);
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [pdfFile()] } });
    fireEvent.click(await screen.findByRole("button", { name: "Opciones" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    rerender(<Harness suspended />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("sin `suspended` el panel abierto se queda abierto", async () => {
    stubPhone();
    const { container, rerender } = render(<Harness suspended={false} />);
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [pdfFile()] } });
    fireEvent.click(await screen.findByRole("button", { name: "Opciones" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    rerender(<Harness suspended={false} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
