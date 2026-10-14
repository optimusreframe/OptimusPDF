import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { EditToolClient } from "@/app/edit-pdf/EditToolClient";
import { __resetEditPdfFeatureFlagsCacheForTests } from "@/app/edit-pdf/editFeatureFlags";
import {
  __resetEditDraftsMemoryForTests,
  clearAllEditDrafts,
  fingerprintPdfBytes,
  saveEditDraft,
} from "@/app/edit-pdf/editDrafts";
import { applyOp, createEditSession, newTextEdit, textItem } from "@/app/edit-pdf/editSession";
import type { EditWorkspaceProps } from "@/app/edit-pdf/EditWorkspace";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { es } from "@/lib/locales/es";

/**
 * `/edit-pdf?resume=edit:<huella>` (Recientes -> Continuar, U0.6): abre el borrador pedido y el editor lo restaura por su
 * huella; si ya no existe, avisa; y un valor manipulado no hace nada. El lienzo real necesita pdf.js: se sustituye por un
 * cuadro que dice que documento y cuantas ediciones recibio (la sesion y los borradores son reales, con fake-indexeddb).
 */

vi.mock("@/app/edit-pdf/EditWorkspace", () => ({
  EditWorkspace: ({ session, file }: EditWorkspaceProps) => (
    <div data-testid="inline-workspace" data-file={file.name}>
      <output data-testid="count">{session.items.length}</output>
    </div>
  ),
}));

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
beforeEach(async () => {
  window.localStorage.removeItem("optimuspdf.editPdf.featureFlags");
  __resetEditPdfFeatureFlagsCacheForTests();
  __resetEditDraftsMemoryForTests();
  await clearAllEditDrafts();
  setUrl("/edit-pdf");
});
afterEach(() => {
  cleanup();
  setUrl("/");
});

const setUrl = (path: string) => window.history.replaceState(null, "", path);

async function pdfBytes(label: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText(label, { x: 50, y: 700, size: 12, font });
  return new Uint8Array(await doc.save());
}

async function seedDraft(label: string, fileName: string, texts: number): Promise<string> {
  const bytes = await pdfBytes(label);
  const id = (await fingerprintPdfBytes(bytes))!;
  let session = createEditSession();
  for (let i = 0; i < texts; i += 1) {
    session = applyOp(
      session,
      {
        type: "add",
        item: textItem(newTextEdit({ id: `t${i}`, pageIndex: 0, box: { x: 10, y: 10, width: 100, height: 20 }, fontKey: "helvetica", text: `Texto ${i}` })),
      },
      i,
    );
  }
  const saved = await saveEditDraft({ id, fileName, fileBytes: bytes, session, pageCount: 1, currentPage: 0 });
  expect(saved.ok).toBe(true);
  return id;
}

function renderTool() {
  return render(
    <LanguageProvider>
      <EditToolClient />
    </LanguageProvider>,
  );
}

describe("?resume=edit:<id>", () => {
  it("abre el borrador pedido (no otro), el editor restaura sus ediciones y la URL se limpia sin anadir historial", async () => {
    await seedDraft("uno", "uno.pdf", 1);
    const id = await seedDraft("dos", "dos.pdf", 2);
    setUrl(`/edit-pdf?resume=edit:${id}`);
    const historyBefore = window.history.length;
    renderTool();

    const workspace = await screen.findByTestId("inline-workspace");
    expect(workspace.getAttribute("data-file")).toBe("dos.pdf");
    // Las ediciones del borrador vuelven (las pone `useEditDrafts` por la huella del contenido).
    await waitFor(() => expect(within(workspace).getByTestId("count").textContent).toBe("2"));
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(window.location.pathname).toBe("/edit-pdf");
    expect(window.history.length).toBe(historyBefore);
    expect(document.querySelector("[data-resume-gone]")?.textContent ?? "").toBe("");
  });

  it("si el borrador ya no existe: aviso con «Abrir de nuevo» y la herramienta queda vacia", async () => {
    await seedDraft("uno", "uno.pdf", 1);
    setUrl(`/edit-pdf?resume=edit:${"ab".repeat(32)}`);
    renderTool();

    const notice = await screen.findByText(es.resume.gone);
    expect(notice).toBeTruthy();
    expect(screen.getByRole("button", { name: es.resume.reopen })).toBeTruthy();
    expect(screen.queryByTestId("inline-workspace")).toBeNull();
    // No se muestra ademas el aviso generico de «no se pudo abrir ese borrador».
    expect(document.querySelector("[data-resume-status]")?.textContent).toBe("");
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("«Abrir de nuevo» abre el selector de PDF y al elegir un archivo el aviso se retira", async () => {
    setUrl(`/edit-pdf?resume=edit:${"ab".repeat(32)}`);
    const { container } = renderTool();
    await screen.findByText(es.resume.gone);
    const input = container.querySelector('input[type="file"][accept*="pdf"]') as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    fireEvent.click(screen.getByRole("button", { name: es.resume.reopen }));
    expect(click).toHaveBeenCalled();

    const bytes = await pdfBytes("nuevo");
    fireEvent.change(input, { target: { files: [new File([bytes as BlobPart], "nuevo.pdf", { type: "application/pdf" })] } });
    await screen.findByTestId("inline-workspace");
    await waitFor(() => expect(screen.queryByText(es.resume.gone)).toBeNull());
  });

  it.each([
    ["tipo de otra herramienta (aunque exista un borrador con ese id)", (id: string) => `pro:${id}`],
    ["sesion de Firmar", () => "session:s-mgx4k2w1-1a2b3c4d"],
    ["tipo fuera de la lista blanca", (id: string) => `delete:${id}`],
    ["id manipulado", () => "edit:../../etc/passwd"],
    ["etiqueta", () => "<script>alert(1)</script>"],
    ["prototipo", (id: string) => `constructor:${id}`],
  ])("%s: no abre nada, no avisa y limpia la URL", async (_label, make) => {
    const id = await seedDraft("uno", "uno.pdf", 1);
    setUrl(`/edit-pdf?resume=${encodeURIComponent(make(id))}`);
    renderTool();
    await waitFor(() => expect(window.location.search).toBe(""));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByTestId("inline-workspace")).toBeNull();
    expect(screen.queryByText(es.resume.gone)).toBeNull();
  });

  it("sin ?resume= la herramienta abre vacia y sin aviso", async () => {
    await seedDraft("uno", "uno.pdf", 1);
    renderTool();
    await screen.findByRole("button", { name: es.tool.dropButton });
    expect(screen.queryByTestId("inline-workspace")).toBeNull();
    expect(screen.queryByText(es.resume.gone)).toBeNull();
  });
});
