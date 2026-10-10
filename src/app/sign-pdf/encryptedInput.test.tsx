import "fake-indexeddb/auto";
import { createRef, type MutableRefObject } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PDFDocument } from "@cantoo/pdf-lib";
import { InputGuardContext } from "@/components/tool/InputGuardContext";
import { SignToolClient } from "@/app/sign-pdf/SignToolClient";
import { SessionDraftAutosave } from "@/app/sign-pdf/SessionDraftAutosave";
import { EMPTY_DOC_STATE, docIdOf } from "@/app/sign-pdf/docSet";
import type { SessionIdentity } from "@/app/sign-pdf/sessionDraft";
import { clearAllDrafts, listDrafts, listSessionDrafts } from "@/app/sign-pdf/signDrafts";
import { DEFAULT_SESSION } from "@/app/sign-pdf/signSession";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { LanguageProvider, LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { es } from "@/lib/locales/es";
import { loadPdf } from "@/lib/pdf/core";
import { detectFields } from "@/lib/pdf/detectFields";
import { createInputGuard, markDecryptedCopy } from "@/lib/pdf/inputGuard";
import { buildEncryptedPdf, buildGoodPdf, pdfFile } from "@/lib/pdf/testing/inputFixtures";

/**
 * Wave 6 · D4: un PDF cifrado en Firmar ya no deja una pagina gris con «No se
 * pudieron detectar campos automaticamente»: pide la contrasena, trabaja con una
 * copia sin cifrar y NUNCA guarda esa copia como borrador (privacidad).
 */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: async () => ({
      numPages: 2,
      getPage: async () => ({ cleanup: () => {} }),
    }),
    renderPageToDataUrl: async () => "data:image/png;base64,iVBORw0KGgo=",
    closePdfDocument: async () => {},
    downloadBlob: vi.fn(),
  };
});
vi.mock("@/lib/pdf/detectFields", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/detectFields")>();
  return { ...actual, detectFields: vi.fn(async () => []) };
});

vi.setConfig({ testTimeout: 30_000 });

const strings = SIGN_STRINGS.es;
const guard = createInputGuard({
  open: async (file) => {
    const { loadPdf: realLoad } = await vi.importActual<typeof import("@/lib/pdf/core")>("@/lib/pdf/core");
    (await realLoad(file)).getPageCount();
  },
});

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 600, height: 800, top: 0, left: 0, right: 600, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
});

beforeEach(async () => {
  vi.mocked(detectFields).mockReset();
  vi.mocked(detectFields).mockResolvedValue([]);
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  await clearAllDrafts();
});

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await clearAllDrafts();
});

const pdfInput = (container: HTMLElement) =>
  container.querySelector('input[type="file"][accept*="pdf"]') as HTMLInputElement;

function renderTool() {
  return render(
    <LanguageProvider>
      <InputGuardContext.Provider value={guard}>
        <SignToolClient />
      </InputGuardContext.Provider>
    </LanguageProvider>,
  );
}

async function distinctPdf(name: string, seed: number): Promise<File> {
  const document = await PDFDocument.create();
  document.addPage([300 + seed, 300]);
  document.addPage([300 + seed, 300]);
  return pdfFile(await document.save({ useObjectStreams: true }), name);
}

describe("Firmar con un PDF cifrado (D4)", () => {
  it("pide la contrasena en vez de mostrar una pagina gris y «No se pudieron detectar campos»", async () => {
    const { container } = renderTool();
    fireEvent.change(pdfInput(container), {
      target: { files: [pdfFile(await buildEncryptedPdf("secreta"), "cifrado.pdf")] },
    });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(es.tool.password.title)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(es.tool.encryptedSheetMessage);
    expect(document.body.textContent).not.toContain("No se pudieron detectar campos");
    expect(detectFields).not.toHaveBeenCalled();
  });

  it("con la contrasena buena se trabaja con la copia: la deteccion recibe un PDF legible sin contrasena", async () => {
    const { container } = renderTool();
    fireEvent.change(pdfInput(container), {
      target: { files: [pdfFile(await buildEncryptedPdf("secreta"), "cifrado.pdf")] },
    });
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(es.tool.password.label), { target: { value: "secreta" } });
    fireEvent.click(within(dialog).getByRole("button", { name: es.tool.password.submit }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getAllByRole("status").some((node) => node.textContent?.includes("sin cifrar"))).toBe(true);
    await waitFor(() => expect(detectFields).toHaveBeenCalled());
    const analysed = vi.mocked(detectFields).mock.calls[0][0] as File;
    await expect(loadPdf(analysed)).resolves.toBeTruthy();
  });

  it("contrasena mala: mensaje claro y la herramienta no avanza", async () => {
    const { container } = renderTool();
    fireEvent.change(pdfInput(container), {
      target: { files: [pdfFile(await buildEncryptedPdf("secreta"), "cifrado.pdf")] },
    });
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(es.tool.password.label), { target: { value: "no" } });
    fireEvent.click(within(dialog).getByRole("button", { name: es.tool.password.submit }));
    await waitFor(() => expect(within(dialog).getByText(es.tool.password.wrong)).toBeTruthy());
    expect(detectFields).not.toHaveBeenCalled();
  });

  it("PRIVACIDAD: la copia descifrada nunca se guarda como borrador (el control sin cifrar si)", async () => {
    // Control: un PDF normal con un firmante genera borrador.
    const control = renderTool();
    fireEvent.change(pdfInput(control.container), { target: { files: [await distinctPdf("normal.pdf", 1)] } });
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeMulti }));
    fireEvent.click(screen.getByRole("button", { name: strings.addSigner }));
    await waitFor(async () => expect(await listDrafts()).toHaveLength(1), { interval: 100 });
    control.unmount();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await clearAllDrafts();

    // Cifrado: abre con contrasena, anade un firmante y espera de sobra al autoguardado.
    const { container } = renderTool();
    fireEvent.change(pdfInput(container), {
      target: { files: [pdfFile(await buildEncryptedPdf("secreta"), "cifrado.pdf")] },
    });
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(es.tool.password.label), { target: { value: "secreta" } });
    fireEvent.click(within(dialog).getByRole("button", { name: es.tool.password.submit }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(await screen.findByRole("tab", { name: strings.modeMulti }));
    fireEvent.click(screen.getByRole("button", { name: strings.addSigner }));
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(await listDrafts()).toEqual([]);
    expect(await listSessionDrafts()).toEqual([]);
  });
});

describe("SessionDraftAutosave — copias descifradas", () => {
  function sessionFor(files: File[]) {
    const ids = files.map(docIdOf);
    return {
      ...DEFAULT_SESSION,
      mode: "multi" as const,
      signers: [{ id: "sg-1", name: "Ana", color: "#0d4bff" }],
      docOrder: ids,
      activeDocId: ids[0] ?? null,
      docs: Object.fromEntries(ids.map((id) => [id, { ...EMPTY_DOC_STATE }])),
    };
  }

  function mountAutosave(files: File[]) {
    const identityRef = createRef<SessionIdentity | null>() as MutableRefObject<SessionIdentity | null>;
    identityRef.current = null;
    return render(
      <SessionDraftAutosave files={files} session={sessionFor(files)} identityRef={identityRef} onTooBig={() => {}} />,
    );
  }

  it("control: dos documentos normales con progreso se guardan", async () => {
    const files = [pdfFile(await buildGoodPdf(1), "a.pdf"), pdfFile(await buildGoodPdf(2), "b.pdf")];
    mountAutosave(files);
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 3000, interval: 100 });
  });

  it("si UNO de los documentos es una copia descifrada, la sesion no se guarda", async () => {
    const files = [pdfFile(await buildGoodPdf(1), "a.pdf"), pdfFile(await buildGoodPdf(2), "b.pdf")];
    markDecryptedCopy(files[1]);
    const view = mountAutosave(files);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await listSessionDrafts()).toEqual([]);
  });
});
