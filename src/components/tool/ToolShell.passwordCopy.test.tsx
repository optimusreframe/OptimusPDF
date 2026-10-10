import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { InputGuardContext } from "@/components/tool/InputGuardContext";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { es } from "@/lib/locales/es";
import { loadPdf } from "@/lib/pdf/core";
import { createInputGuard } from "@/lib/pdf/inputGuard";
import { buildEncryptedPdf, pdfFile } from "@/lib/pdf/testing/inputFixtures";
import { getTool } from "@/lib/tools-registry";

/**
 * `InputPolicy.passwordCopy`: Proteger PDF abre la hoja de contrasena de un PDF cifrado y vuelve a
 * cifrar la copia con la contrasena NUEVA, asi que ni la hoja ni el aviso pueden decir «saldra sin cifrar».
 */

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  window.requestAnimationFrame = (callback) => {
    queueMicrotask(() => callback(performance.now()));
    return 1;
  };
  window.cancelAnimationFrame = () => {};
  Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 1, height: 1 }] as unknown as DOMRectList;
  };
});

const guard = createInputGuard({ open: async (file) => void (await loadPdf(file)).getPageCount() });

async function mountWith(policy: Parameters<typeof ToolShell>[0]["inputPolicy"]) {
  const process = vi.fn(async (): Promise<ProcessResult> => ({ blob: new Blob(["x"]), filename: "s.pdf" }));
  const { container } = render(
    <LanguageProvider>
      <InputGuardContext.Provider value={guard}>
        <ToolShell<{ note: string }> tool={getTool("protect-pdf")} defaultOptions={{ note: "" }} process={process} inputPolicy={policy} />
      </InputGuardContext.Provider>
    </LanguageProvider>,
  );
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [pdfFile(await buildEncryptedPdf("secreta"), "cerrado.pdf")] } });
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText(es.tool.password.label), { target: { value: "secreta" } });
  fireEvent.click(within(dialog).getByRole("button", { name: es.tool.password.submit }));
  return dialog;
}

describe("InputPolicy.passwordCopy", () => {
  it("sin textos propios: la frase generica («el resultado saldra sin cifrar»)", async () => {
    const dialog = await mountWith(undefined);
    expect(within(dialog).getByText(es.tool.password.body)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("status").textContent).toContain("sin cifrar");
  });

  it("con textos propios: la hoja y el aviso dicen lo que de verdad pasa", async () => {
    const dialog = await mountWith({
      passwordCopy: { sheetBody: "SE-PROTEGERA-DE-NUEVO", notice: "{name}: COPIA-QUE-SE-VUELVE-A-CIFRAR" },
    });
    expect(within(dialog).getByText("SE-PROTEGERA-DE-NUEVO")).toBeTruthy();
    expect(within(dialog).queryByText(es.tool.password.body)).toBeNull();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("cerrado.pdf: COPIA-QUE-SE-VUELVE-A-CIFRAR");
    expect(status.textContent).not.toContain("sin cifrar");
  });
});
