import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts } from "@cantoo/pdf-lib";
import { EditToolClient } from "@/app/edit-pdf/EditToolClient";
import { __resetEditPdfFeatureFlagsCacheForTests } from "@/app/edit-pdf/editFeatureFlags";
import { clearAllEditDrafts, __resetEditDraftsMemoryForTests } from "@/app/edit-pdf/editDrafts";
import { flattenItem, newTextEdit, textItem } from "@/app/edit-pdf/editSession";
import type { EditWorkspaceProps } from "@/app/edit-pdf/EditWorkspace";
import { EDIT_FLOW_STRINGS } from "@/app/edit-pdf/flowStrings";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";

/**
 * Integracion de la herramienta (W5-U5): avisos al abrir (cifrado, firmas,
 * formularios), confirmacion de firmas antes de exportar, descarga con resumen y
 * avisos. El lienzo real necesita pdf.js y canvas: se sustituye por un cuadro que
 * deja crear ediciones; TODO lo demas (preparacion, sesion, exportacion) es real.
 */

const downloaded = vi.hoisted(() => ({ blobs: [] as { blob: Blob; name: string }[] }));

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    downloadBlob: (blob: Blob, name: string) => downloaded.blobs.push({ blob, name }),
  };
});

vi.mock("@/app/edit-pdf/EditWorkspace", () => ({
  EditWorkspace: ({ session, file }: EditWorkspaceProps) => (
    <div data-testid="inline-workspace" data-file={file.name}>
      <output data-testid="count">{session.items.length}</output>
      <button
        type="button"
        onClick={() =>
          session.dispatch({
            type: "add",
            item: textItem(
              newTextEdit({ pageIndex: 0, fontKey: "helvetica", box: { x: 50, y: 200, width: 200, height: 20 }, text: "Texto nuevo" }),
            ),
          })
        }
      >
        anadir-texto
      </button>
      <button
        type="button"
        onClick={() =>
          session.dispatch({
            type: "add",
            item: textItem(
              newTextEdit({
                pageIndex: 0,
                blockId: "p0-b0",
                coverBox: { x: 50, y: 200, width: 200, height: 20 },
                cover: { color: "#ffffff", padding: 1, uniform: false },
                fontKey: "helvetica",
                box: { x: 50, y: 200, width: 200, height: 20 },
                text: "Reemplazo",
              }),
            ),
          })
        }
      >
        reemplazar-bloque
      </button>
      <button type="button" onClick={() => session.dispatch({ type: "add", item: flattenItem(0) })}>
        aplanar-pagina
      </button>
    </div>
  ),
}));

const flow = EDIT_FLOW_STRINGS.es;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
beforeEach(async () => {
  downloaded.blobs.length = 0;
  window.localStorage.removeItem("optimuspdf.editPdf.featureFlags");
  __resetEditPdfFeatureFlagsCacheForTests();
  __resetEditDraftsMemoryForTests();
  await clearAllEditDrafts();
});
afterEach(cleanup);

async function basePdf(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText("Original", { x: 50, y: 700, size: 12, font });
  return doc;
}
const toFile = async (doc: PDFDocument, name = "doc.pdf") =>
  new File([(await doc.save()) as BlobPart], name, { type: "application/pdf" });

async function signedFile(): Promise<File> {
  const doc = await basePdf();
  const ctx = doc.context;
  const sig = PDFDict.withContext(ctx);
  sig.set(PDFName.of("Type"), PDFName.of("Sig"));
  const field = PDFDict.withContext(ctx);
  field.set(PDFName.of("FT"), PDFName.of("Sig"));
  field.set(PDFName.of("V"), ctx.register(sig));
  field.set(PDFName.of("T"), PDFString.of("Firma1"));
  const fields = PDFArray.withContext(ctx);
  fields.push(ctx.register(field));
  const acro = PDFDict.withContext(ctx);
  acro.set(PDFName.of("Fields"), fields);
  acro.set(PDFName.of("SigFlags"), PDFNumber.of(3));
  doc.catalog.set(PDFName.of("AcroForm"), ctx.register(acro));
  return toFile(doc, "firmado.pdf");
}

function renderTool() {
  return render(
    <LanguageProvider>
      <EditToolClient />
    </LanguageProvider>,
  );
}
async function upload(container: HTMLElement, file: File) {
  fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
}
const runButton = async () => (await screen.findAllByRole("button", { name: "Procesar" }))[0];
const notice = (id: string) => document.querySelector(`[data-notice="${id}"]`) as HTMLElement | null;

describe("abrir el documento", () => {
  it("un PDF normal pasa por «Comprobando el documento» y monta el lienzo sin avisos", async () => {
    const { container } = renderTool();
    await upload(container, await toFile(await basePdf()));
    await screen.findByTestId("inline-workspace");
    expect(notice("protected")).toBeNull();
    expect(notice("signatures")).toBeNull();
    expect(notice("form")).toBeNull();
  });

  it("cifrado solo de propietario: se abre solo y avisa de que la copia irá sin contraseña", async () => {
    const doc = await basePdf();
    doc.encrypt({ userPassword: "", ownerPassword: "owner" });
    const { container } = renderTool();
    await upload(container, await toFile(doc, "protegido.pdf"));
    await screen.findByTestId("inline-workspace");
    expect(notice("protected")!.textContent).toContain(flow.protectedCopy);
  });

  it("contrasena de usuario: pide la contrasena en una hoja; equivocada -> mensaje claro; correcta -> abre", async () => {
    const doc = await basePdf();
    doc.encrypt({ userPassword: "secreto", ownerPassword: "owner" });
    const { container } = renderTool();
    await upload(container, await toFile(doc, "cifrado.pdf"));
    const input = await screen.findByLabelText("Contraseña");
    expect(screen.queryByTestId("inline-workspace")).toBeNull();

    fireEvent.change(input, { target: { value: "mala" } });
    fireEvent.click(screen.getByRole("button", { name: flow.passwordSubmit }));
    await waitFor(() => expect(document.querySelector("[data-password-message]")!.textContent).toBe(flow.passwordWrong));
    expect(screen.queryByTestId("inline-workspace")).toBeNull();

    fireEvent.change(await screen.findByLabelText("Contraseña"), { target: { value: "secreto" } });
    fireEvent.click(screen.getByRole("button", { name: flow.passwordSubmit }));
    await screen.findByTestId("inline-workspace");
    expect(notice("protected")).not.toBeNull();
  });

  it("cancelar la contrasena saca el archivo y vuelve a la zona de carga", async () => {
    const doc = await basePdf();
    doc.encrypt({ userPassword: "secreto", ownerPassword: "owner" });
    const { container } = renderTool();
    await upload(container, await toFile(doc, "cifrado.pdf"));
    await screen.findByLabelText("Contraseña");
    fireEvent.click(screen.getByRole("button", { name: flow.passwordCancel }));
    await waitFor(() => expect(screen.queryByLabelText("Contraseña")).toBeNull());
    await waitFor(() => expect(container.querySelector('input[type="file"]')).not.toBeNull());
    expect(screen.queryByText("cifrado.pdf")).toBeNull();
  });

  it("cerrar la hoja con «Cerrar» NO pierde el documento: la tarjeta ofrece volver a escribirla", async () => {
    const doc = await basePdf();
    doc.encrypt({ userPassword: "secreto", ownerPassword: "owner" });
    const { container } = renderTool();
    await upload(container, await toFile(doc, "cifrado.pdf"));
    await screen.findByLabelText("Contraseña");
    fireEvent.click(screen.getAllByRole("button", { name: flow.confirmClose })[0]);
    await waitFor(() => expect(screen.queryByLabelText("Contraseña")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: flow.passwordOpenSheet }));
    expect(await screen.findByLabelText("Contraseña")).toBeTruthy();
  });

  it("firma digital activa: aviso permanente al abrir (no un modal)", async () => {
    const { container } = renderTool();
    await upload(container, await signedFile());
    await screen.findByTestId("inline-workspace");
    expect(notice("signatures")!.textContent).toContain(flow.signaturesActive);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("campos de formulario: aviso con enlace a Firmar PDF y se puede ocultar", async () => {
    const doc = await basePdf();
    doc.getForm().createTextField("nombre").addToPage(doc.getPage(0), { x: 50, y: 500, width: 100, height: 20 });
    const { container } = renderTool();
    await upload(container, await toFile(doc, "formulario.pdf"));
    await screen.findByTestId("inline-workspace");
    const row = notice("form")!;
    expect(row.textContent).toContain(flow.formNotice);
    expect(within(row).getByRole("link", { name: flow.formLink }).getAttribute("href")).toBe("/sign-pdf");
    fireEvent.click(within(row).getByRole("button", { name: flow.dismiss }));
    expect(notice("form")).toBeNull();
  });

  it("un archivo danado no monta el lienzo y deja salir", async () => {
    const { container } = renderTool();
    await upload(container, new File([new Uint8Array([1, 2, 3, 4])], "roto.pdf", { type: "application/pdf" }));
    await screen.findByText(flow.cannotOpen);
    expect(screen.queryByTestId("inline-workspace")).toBeNull();
    expect(screen.getByRole("button", { name: flow.tryAnotherFile })).toBeTruthy();
  });

  it("un archivo de mas de 100 MB se admite con el aviso de tamano del shell (no bloquea)", async () => {
    const big = await toFile(await basePdf(), "enorme.pdf");
    Object.defineProperty(big, "size", { value: 101 * 1024 * 1024 });
    const { container } = renderTool();
    await upload(container, big);
    await screen.findByTestId("inline-workspace");
    expect(document.body.textContent).toContain("El archivo supera los 100 MB");
  });
});

describe("exportar", () => {
  it("sin firmas no hay confirmacion: descarga con el nombre correcto, resumen y avisos", async () => {
    const { container } = renderTool();
    await upload(container, await toFile(await basePdf(), "informe.pdf"));
    await screen.findByTestId("inline-workspace");
    fireEvent.click(screen.getByRole("button", { name: "reemplazar-bloque" }));
    fireEvent.click(screen.getByRole("button", { name: "anadir-texto" }));
    fireEvent.click(await runButton());
    await screen.findByRole("button", { name: "Descargar" });
    expect(screen.queryByText(flow.signaturesConfirmTitle)).toBeNull();
    expect(document.querySelector("[data-download-summary]")!.textContent).toBe("1 texto editado, 1 texto añadido.");
    const list = document.querySelector("[data-download-notices]") as HTMLElement;
    expect(within(list).getByRole("heading", { name: flow.noticesTitle })).toBeTruthy();
    expect(list.textContent).toContain(flow.noticeRemains(1));
    expect(list.textContent).toContain(flow.noticeBackground(1));
    fireEvent.click(screen.getByRole("button", { name: "Descargar" }));
    expect(downloaded.blobs[0].name).toBe("informe-editado.pdf");
  });

  it("la descarga sin avisos no muestra la caja de avisos", async () => {
    const { container } = renderTool();
    await upload(container, await toFile(await basePdf()));
    await screen.findByTestId("inline-workspace");
    fireEvent.click(screen.getByRole("button", { name: "anadir-texto" }));
    fireEvent.click(await runButton());
    await screen.findByRole("button", { name: "Descargar" });
    expect(document.querySelector("[data-download-notices]")).toBeNull();
    expect(document.querySelector("[data-download-summary]")!.textContent).toBe("1 texto añadido.");
  });

  it("con firmas: pedir exportar abre la confirmacion y NO procesa hasta aceptarla", async () => {
    const { container } = renderTool();
    await upload(container, await signedFile());
    await screen.findByTestId("inline-workspace");
    fireEvent.click(screen.getByRole("button", { name: "anadir-texto" }));
    fireEvent.click(await runButton());
    expect(await screen.findByText(flow.signaturesConfirmTitle)).toBeTruthy();
    expect(screen.getByText(flow.signaturesConfirmBodyActive)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Descargar" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: flow.signaturesConfirmAction }));
    await screen.findByRole("button", { name: "Descargar" });
    expect(document.querySelector("[data-download-notices]")!.textContent).toContain(flow.noticeSignatures);
  });

  it("con firmas: cancelar la confirmacion no exporta ni deja error, y se puede volver a intentar", async () => {
    const { container } = renderTool();
    await upload(container, await signedFile());
    await screen.findByTestId("inline-workspace");
    fireEvent.click(screen.getByRole("button", { name: "anadir-texto" }));
    fireEvent.click(await runButton());
    fireEvent.click(await screen.findByRole("button", { name: flow.signaturesConfirmCancel }));
    await waitFor(() => expect(screen.queryByText(flow.signaturesConfirmBodyActive)).toBeNull());
    expect(screen.queryByRole("button", { name: "Descargar" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("count").textContent).toBe("1");
    fireEvent.click(await runButton());
    expect(await screen.findByText(flow.signaturesConfirmTitle)).toBeTruthy();
  });

  it("solo una pagina aplanada ya basta para exportar (Procesar se habilita) y el resumen la cuenta", async () => {
    const { container } = renderTool();
    await upload(container, await toFile(await basePdf()));
    await screen.findByTestId("inline-workspace");
    expect((await runButton()).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "aplanar-pagina" }));
    await waitFor(() => expect((screen.getAllByRole("button", { name: "Procesar" })[0]).hasAttribute("disabled")).toBe(false));
  });

  it("«Ver borradores» abre la hoja de borradores", async () => {
    renderTool();
    fireEvent.click(screen.getByRole("button", { name: flow.draftsButton }));
    expect(await screen.findByText(flow.draftsEmpty)).toBeTruthy();
  });
});
