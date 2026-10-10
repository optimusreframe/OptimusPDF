import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PDFDocument, PDFRawStream, StandardFonts, decodePDFRawStream } from "@cantoo/pdf-lib";
import { EditToolClient } from "@/app/edit-pdf/EditToolClient";
import {
  __resetEditPdfFeatureFlagsCacheForTests,
  setEditPdfFeatureFlag,
} from "@/app/edit-pdf/editFeatureFlags";
import { newTextEdit, textItem } from "@/app/edit-pdf/editSession";
import type { EditWorkspaceProps } from "@/app/edit-pdf/EditWorkspace";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";

const downloaded = vi.hoisted(() => ({ blobs: [] as { blob: Blob; name: string }[] }));

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    downloadBlob: (blob: Blob, name: string) => downloaded.blobs.push({ blob, name }),
  };
});

/** El lienzo real necesita pdf.js y canvas: aqui se sustituye por un resumen de la sesion. */
vi.mock("@/app/edit-pdf/EditWorkspace", () => ({
  EditWorkspace: ({ session, file, existingText = true }: EditWorkspaceProps) => (
    <div data-testid="inline-workspace" data-file={file.name} data-existing-text={String(existingText)}>
      <output data-testid="count">{session.items.length}</output>
      <button
        type="button"
        onClick={() =>
          session.dispatch({
            type: "add",
            item: textItem(
              newTextEdit({
                pageIndex: 0,
                fontKey: "helvetica",
                box: { x: 50, y: 700, width: 200, height: 20 },
                text: "Hola desde el editor",
              }),
            ),
          })
        }
      >
        anadir-edicion
      </button>
    </div>
  ),
}));

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

beforeEach(() => {
  downloaded.blobs.length = 0;
  window.localStorage.removeItem("optimuspdf.editPdf.featureFlags");
  __resetEditPdfFeatureFlagsCacheForTests();
});

afterEach(() => {
  __resetEditPdfFeatureFlagsCacheForTests();
});

async function makePdf(name = "doc.pdf"): Promise<File> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText("Original", { x: 50, y: 700, size: 12, font });
  const bytes = await doc.save();
  return new File([bytes as BlobPart], name, { type: "application/pdf" });
}

function fileInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="file"]') as HTMLInputElement;
}

async function upload(container: HTMLElement, file: File) {
  fireEvent.change(fileInput(container), { target: { files: [file] } });
}

const processButton = async () => (await screen.findAllByRole("button", { name: "Procesar" }))[0];

function renderTool() {
  return render(
    <LanguageProvider>
      <EditToolClient />
    </LanguageProvider>,
  );
}

describe("EditToolClient — flag editExistingText", () => {
  it("activo (por defecto): el lienzo inline edita el texto existente y no hay panel de opciones ni avisos fijos", async () => {
    const { container } = renderTool();
    await upload(container, await makePdf());
    const workspace = await screen.findByTestId("inline-workspace");
    expect(workspace.getAttribute("data-existing-text")).toBe("true");
    // El formulario aparte de la version anterior ya no existe.
    expect(screen.queryByText("Añade encima, no reescribe lo que ya hay")).toBeNull();
    expect(screen.queryByText("Estilo")).toBeNull();
  });

  it("apagado NO vuelve a un editor antiguo: el mismo lienzo, con la edicion del texto existente desactivada", async () => {
    setEditPdfFeatureFlag("editExistingText", false);
    const { container } = renderTool();
    await upload(container, await makePdf());
    const workspace = await screen.findByTestId("inline-workspace");
    expect(workspace.getAttribute("data-existing-text")).toBe("false");
    expect(screen.queryByTestId("legacy-canvas")).toBeNull();
  });

  it("cambiar el flag en caliente no remonta el lienzo ni pierde la sesion", async () => {
    const { container } = renderTool();
    await upload(container, await makePdf());
    await screen.findByTestId("inline-workspace");
    fireEvent.click(screen.getByRole("button", { name: "anadir-edicion" }));
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("1"));
    act(() => setEditPdfFeatureFlag("editExistingText", false));
    await waitFor(() =>
      expect(screen.getByTestId("inline-workspace").getAttribute("data-existing-text")).toBe("false"),
    );
    expect(screen.getByTestId("count").textContent).toBe("1");
  });
});

describe("EditInlineTool — exportar", () => {
  it("Procesar esta deshabilitado hasta que hay un cambio real", async () => {
    const { container } = renderTool();
    await upload(container, await makePdf());
    await screen.findByTestId("inline-workspace");
    expect((await processButton()).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "anadir-edicion" }));
    await waitFor(() => expect((screen.getAllByRole("button", { name: "Procesar" })[0]).hasAttribute("disabled")).toBe(false));
  });

  it("exporta con applyTextEdits: el PDF descargado lleva el texto editado y conserva la pagina", async () => {
    const { container } = renderTool();
    await upload(container, await makePdf("informe.pdf"));
    await screen.findByTestId("inline-workspace");
    fireEvent.click(screen.getByRole("button", { name: "anadir-edicion" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "Procesar" }))[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Descargar" }));
    expect(downloaded.blobs).toHaveLength(1);
    expect(downloaded.blobs[0].name).toBe("informe-editado.pdf");
    const out = new Uint8Array(await downloaded.blobs[0].blob.arrayBuffer());
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(1);
    // Los flujos de contenido van comprimidos y pdf-lib escribe el texto en hexadecimal: se decodifica para buscarlo.
    const streams = reloaded.context
      .enumerateIndirectObjects()
      .map(([, object]) => object)
      .filter((object): object is PDFRawStream => object instanceof PDFRawStream)
      .map((stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1"));
    const hex = Buffer.from("Hola desde el editor", "latin1").toString("hex");
    expect(streams.some((text) => text.toLowerCase().includes(hex))).toBe(true);
  });

  it("la sesion se reinicia al cargar OTRO archivo", async () => {
    const { container } = renderTool();
    await upload(container, await makePdf("a.pdf"));
    await screen.findByTestId("inline-workspace");
    fireEvent.click(screen.getByRole("button", { name: "anadir-edicion" }));
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("1"));
    // Sacar el archivo y subir otro distinto.
    fireEvent.click(screen.getByRole("button", { name: /quitar|eliminar|remove/i }));
    await upload(container, await makePdf("b.pdf"));
    await waitFor(() => expect(screen.getByTestId("inline-workspace").getAttribute("data-file")).toBe("b.pdf"));
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("0"));
  });
});
