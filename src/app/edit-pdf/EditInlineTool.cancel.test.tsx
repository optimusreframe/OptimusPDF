import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PDFDocument } from "@cantoo/pdf-lib";
import { EditToolClient } from "@/app/edit-pdf/EditToolClient";
import { __resetEditPdfFeatureFlagsCacheForTests } from "@/app/edit-pdf/editFeatureFlags";
import { __resetEditDraftsMemoryForTests, clearAllEditDrafts } from "@/app/edit-pdf/editDrafts";
import { newTextEdit, textItem } from "@/app/edit-pdf/editSession";
import type { EditWorkspaceProps } from "@/app/edit-pdf/EditWorkspace";
import { EDIT_FLOW_STRINGS } from "@/app/edit-pdf/flowStrings";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { PdfError } from "@/lib/pdf/core";

/**
 * Progreso y cancelacion de la exportacion (W5-U5): la `AbortSignal` del shell
 * llega al motor, la cancelacion no pierde las ediciones y el progreso se ve.
 */

const mocks = vi.hoisted(() => ({
  calls: [] as { signal: AbortSignal | undefined }[],
  report: null as null | ((value: number) => void),
}));

vi.mock("@/app/edit-pdf/editExport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/edit-pdf/editExport")>();
  return {
    ...actual,
    exportEditedPdf: (_file: File, _session: unknown, options: { signal?: AbortSignal; onProgress?: (v: number) => void }) => {
      mocks.calls.push({ signal: options.signal });
      mocks.report = options.onProgress ?? null;
      options.onProgress?.(0.42);
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new PdfError("cancelled")));
      });
    },
  };
});

vi.mock("@/app/edit-pdf/EditWorkspace", () => ({
  EditWorkspace: ({ session }: EditWorkspaceProps) => (
    <div data-testid="inline-workspace">
      <output data-testid="count">{session.items.length}</output>
      <button
        type="button"
        onClick={() =>
          session.dispatch({
            type: "add",
            item: textItem(newTextEdit({ pageIndex: 0, fontKey: "helvetica", box: { x: 5, y: 5, width: 100, height: 20 }, text: "Hola" })),
          })
        }
      >
        anadir-texto
      </button>
    </div>
  ),
}));

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
beforeEach(async () => {
  mocks.calls.length = 0;
  window.localStorage.removeItem("optimuspdf.editPdf.featureFlags");
  __resetEditPdfFeatureFlagsCacheForTests();
  __resetEditDraftsMemoryForTests();
  await clearAllEditDrafts();
});
afterEach(cleanup);

async function openWithEdit() {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  const file = new File([(await doc.save()) as BlobPart], "doc.pdf", { type: "application/pdf" });
  const view = render(
    <LanguageProvider>
      <EditToolClient />
    </LanguageProvider>,
  );
  fireEvent.change(view.container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
  await screen.findByTestId("inline-workspace");
  fireEvent.click(screen.getByRole("button", { name: "anadir-texto" }));
}

describe("exportar: progreso y cancelacion", () => {
  it("el overlay muestra el progreso real que reporta el motor", async () => {
    await openWithEdit();
    fireEvent.click((await screen.findAllByRole("button", { name: "Procesar" }))[0]);
    const bar = await screen.findByRole("progressbar");
    await waitFor(() => expect(bar.getAttribute("aria-valuenow")).toBe("42"));
  });

  it("Cancelar aborta la senal del motor, avisa «Proceso cancelado.» y conserva las ediciones", async () => {
    await openWithEdit();
    fireEvent.click((await screen.findAllByRole("button", { name: "Procesar" }))[0]);
    await screen.findByRole("progressbar");
    expect(mocks.calls[0].signal!.aborted).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(mocks.calls[0].signal!.aborted).toBe(true);
    // Cancelar NO es un fallo: aviso neutro (role=status), sin pantalla de error ni «No se pudo completar».
    await waitFor(() => expect(document.body.textContent).toContain(EDIT_FLOW_STRINGS.es.exportCancelled));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toContain("No se pudo completar");
    expect(screen.getByText(EDIT_FLOW_STRINGS.es.exportCancelled).closest('[role="status"]')).not.toBeNull();
    await screen.findByTestId("inline-workspace");
    expect(screen.getByTestId("count").textContent).toBe("1");
    // Volver NO es «recuperar un borrador»: el trabajo estaba intacto en memoria.
    expect(document.body.textContent).not.toContain("Recuperamos tu trabajo anterior");
    expect(document.querySelector("[data-notice='restored']")).toBeNull();
    // Se puede volver a exportar.
    expect((screen.getAllByRole("button", { name: "Procesar" })[0] as HTMLButtonElement).disabled).toBe(false);
  });

  it("tras cancelar, un PDF con contrasena NO la vuelve a pedir (el documento preparado se recuerda)", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    doc.encrypt({ userPassword: "secreto", ownerPassword: "owner" });
    const file = new File([(await doc.save()) as BlobPart], "cifrado.pdf", { type: "application/pdf" });
    const view = render(
      <LanguageProvider>
        <EditToolClient />
      </LanguageProvider>,
    );
    fireEvent.change(view.container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
    fireEvent.change(await screen.findByLabelText("Contraseña"), { target: { value: "secreto" } });
    fireEvent.click(screen.getByRole("button", { name: EDIT_FLOW_STRINGS.es.passwordSubmit }));
    await screen.findByTestId("inline-workspace");
    fireEvent.click(screen.getByRole("button", { name: "anadir-texto" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "Procesar" }))[0]);
    await screen.findByRole("progressbar");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await screen.findByTestId("inline-workspace");
    expect(screen.queryByLabelText("Contraseña")).toBeNull();
    expect(screen.getByTestId("count").textContent).toBe("1");
  });
});
