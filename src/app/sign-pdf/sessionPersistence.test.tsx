import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import JSZip from "jszip";
import { PDFDocument } from "@cantoo/pdf-lib";
import { SignToolClient } from "@/app/sign-pdf/SignToolClient";
import { exportSignConfigSet } from "@/app/sign-pdf/signConfig";
import { EMPTY_DOC_STATE, docIdOf } from "@/app/sign-pdf/docSet";
import { fitDocumentPrefix, MAX_DOCUMENTS } from "@/app/sign-pdf/signLimits";
import {
  clearAllDrafts,
  listAllDrafts,
  listDrafts,
  listSessionDrafts,
  loadSessionDraft,
  saveSessionDraft,
} from "@/app/sign-pdf/signDrafts";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import {
  __resetSignPdfFeatureFlagsCacheForTests,
  setSignPdfFeatureFlag,
} from "@/app/sign-pdf/signFeatureFlags";
import {
  __resetSignTemplatesCacheForTests,
  saveTemplate,
} from "@/app/sign-pdf/signTemplates";
import { LanguageProvider, LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { es } from "@/lib/locales/es";
import { downloadBlob } from "@/lib/pdf/core";
import { detectFields } from "@/lib/pdf/detectFields";
import { __resetValueHistoryCacheForTests } from "@/lib/valueHistory";

/*
 * Persistencia de la sesion con VARIOS documentos (Wave 4 · U5) a traves de
 * `SignToolClient` completo: borrador por sesion, retomar, relevo con el flujo
 * de un documento, exportar/importar la configuracion y plantilla a todos.
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

// Cada caso espera varios autoguardados reales (debounce de ~800 ms).
vi.setConfig({ testTimeout: 30_000 });

const strings = SIGN_STRINGS.es;
const MB = 1024 * 1024;

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      width: 600,
      height: 800,
      top: 0,
      left: 0,
      right: 600,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

let seed = 200;
/** Un PDF real de 2 paginas, distinto en cada llamada (otra huella). */
async function pdf(name: string): Promise<File> {
  const document = await PDFDocument.create();
  seed += 1;
  document.addPage([300 + seed, 300]);
  document.addPage([300 + seed, 300]);
  const bytes = await document.save({ useObjectStreams: true });
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

beforeEach(async () => {
  vi.mocked(detectFields).mockReset();
  vi.mocked(detectFields).mockResolvedValue([]);
  vi.mocked(downloadBlob).mockReset();
  window.sessionStorage.clear();
  window.localStorage.clear();
  __resetValueHistoryCacheForTests();
  __resetSignPdfFeatureFlagsCacheForTests();
  __resetSignTemplatesCacheForTests();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  await clearAllDrafts();
});

afterEach(async () => {
  // Desmontar vuelca el guardado pendiente: se espera a que aterrice y SOLO
  // entonces se limpia, para que no contamine al caso siguiente.
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await clearAllDrafts();
});

function renderTool() {
  return render(
    <LanguageProvider>
      <SignToolClient />
    </LanguageProvider>,
  );
}

const pdfInput = (container: HTMLElement) =>
  container.querySelector('input[type="file"][accept*="pdf"]') as HTMLInputElement;
const zipInput = (container: HTMLElement) =>
  container.querySelector('input[type="file"][accept*="zip"]') as HTMLInputElement;

async function load(container: HTMLElement, ...files: File[]) {
  fireEvent.change(pdfInput(container), { target: { files } });
  await waitFor(() => expect(screen.getByText(es.tool.filesTitle)).toBeTruthy());
}

const docNav = () => screen.queryByRole("navigation", { name: strings.documentsLabel });
const docButtons = () => within(docNav()!).getAllByRole("button");

async function toMulti() {
  fireEvent.click(await screen.findByRole("tab", { name: strings.modeMulti }));
}

/** «Varios firmantes» con un firmante dado de alta. */
async function startRound() {
  await toMulti();
  fireEvent.click(await screen.findByRole("button", { name: strings.addSigner }));
  await screen.findByRole("button", {
    name: strings.removeSigner(strings.defaultSignerName(1)),
  });
}

const waitSessions = (count: number) =>
  waitFor(async () => expect(await listSessionDrafts()).toHaveLength(count), {
    interval: 100,
  });

describe("borrador de sesion con varios documentos", () => {
  it("dos documentos guardan UN borrador de sesion y ninguno por documento", async () => {
    const { container } = renderTool();
    await load(container, await pdf("a.pdf"), await pdf("b.pdf"));
    await startRound();
    await waitSessions(1);

    const [meta] = await listSessionDrafts();
    expect(meta.documents.map((doc) => doc.fileName)).toEqual(["a.pdf", "b.pdf"]);
    expect(meta.signers).toHaveLength(1);
    expect(await listDrafts()).toEqual([]);
  });

  it("recargar y retomar desde «Ver borradores» devuelve los dos documentos y el firmante", async () => {
    const first = renderTool();
    await load(first.container, await pdf("a.pdf"), await pdf("b.pdf"));
    await startRound();
    await waitSessions(1);
    first.unmount();

    const second = renderTool();
    expect(docNav()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: strings.draftsButton }));
    expect(await screen.findByText(/2 documentos/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: strings.draftsResume }));

    await waitFor(() => expect(docNav()).not.toBeNull());
    expect(docButtons().map((button) => button.textContent)).toEqual(["1. a.pdf", "2. b.pdf"]);
    await screen.findByRole("button", {
      name: strings.removeSigner(strings.defaultSignerName(1)),
    });
    expect(second.container.querySelector('input[type="file"]')).toBeTruthy();
  });

  it("tras retomar, el siguiente autoguardado actualiza la MISMA sesion (no la duplica)", async () => {
    const first = renderTool();
    await load(first.container, await pdf("a.pdf"), await pdf("b.pdf"));
    await startRound();
    await waitSessions(1);
    const [original] = await listSessionDrafts();
    first.unmount();

    renderTool();
    fireEvent.click(screen.getByRole("button", { name: strings.draftsButton }));
    fireEvent.click(await screen.findByRole("button", { name: strings.draftsResume }));
    await waitFor(() => expect(docNav()).not.toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: strings.addSigner }));
    await waitFor(async () => expect((await listSessionDrafts())[0]?.signers).toHaveLength(2), {
      interval: 100,
    });
    const after = await listSessionDrafts();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(original.id);
    // Los PDF no se reescribieron ni se duplicaron.
    expect((await loadSessionDraft(original.id))!.files).toHaveLength(2);
  });

  it("retomar conserva el orden de los documentos y vuelve al paso en el que se dejo", async () => {
    const first = renderTool();
    await load(first.container, await pdf("zeta.pdf"), await pdf("alfa.pdf"));
    await startRound();
    fireEvent.click(await screen.findByRole("button", { name: `2. ${strings.stepDocument}` }));
    await waitFor(async () => expect((await listSessionDrafts())[0]?.step).toBe("document"), {
      interval: 100,
    });
    first.unmount();

    renderTool();
    fireEvent.click(screen.getByRole("button", { name: strings.draftsButton }));
    fireEvent.click(await screen.findByRole("button", { name: strings.draftsResume }));
    await waitFor(() => expect(docNav()).not.toBeNull());
    expect(docButtons().map((button) => button.textContent)).toEqual(["1. zeta.pdf", "2. alfa.pdf"]);
    expect(
      screen.getByRole("button", { name: `2. ${strings.stepDocument}` }).getAttribute("aria-current"),
    ).toBe("step");
  });

  it("de 1 a 2 documentos: el borrador v1 del primero se retira y nace la sesion", async () => {
    const a = await pdf("a.pdf");
    const { container } = renderTool();
    await load(container, a);
    await startRound();
    await waitFor(async () => expect(await listDrafts()).toHaveLength(1), { interval: 100 });

    fireEvent.change(pdfInput(container), { target: { files: [await pdf("b.pdf")] } });
    await waitFor(() => expect(docNav()).not.toBeNull());
    await waitSessions(1);
    await waitFor(async () => expect(await listDrafts()).toEqual([]), { interval: 100 });
  });

  it("de 2 a 1 documento: la sesion se borra y el flujo de un documento toma el relevo con su borrador v1", async () => {
    const { container } = renderTool();
    await load(container, await pdf("a.pdf"), await pdf("b.pdf"));
    await startRound();
    await waitSessions(1);

    fireEvent.click(screen.getAllByRole("button", { name: es.tool.remove })[1]);
    await waitFor(() => expect(docNav()).toBeNull());
    await waitSessions(0);
    await waitFor(async () => expect(await listDrafts()).toHaveLength(1), { interval: 100 });
    expect((await listAllDrafts())[0].kind).toBe("document");
  });

  it("con un solo documento el borrador es el v1 de siempre", async () => {
    const { container } = renderTool();
    await load(container, await pdf("solo.pdf"));
    await startRound();
    await waitFor(async () => expect(await listDrafts()).toHaveLength(1), { interval: 100 });
    expect(await listSessionDrafts()).toEqual([]);
  });

  it("una ronda que pesa mas de 150 MB no se guarda y lo dice con amabilidad", async () => {
    const big = await pdf("grande.pdf");
    Object.defineProperty(big, "size", { value: 100 * MB });
    const bigger = await pdf("otro-grande.pdf");
    Object.defineProperty(bigger, "size", { value: 60 * MB });
    const { container } = renderTool();
    await load(container, big, bigger);
    await startRound();
    expect(await screen.findByText(strings.draftsTooBig)).toBeTruthy();
    expect(await listSessionDrafts()).toEqual([]);
  });

  it("«Solo yo» con dos documentos no guarda borrador de sesion", async () => {
    const { container } = renderTool();
    await load(container, await pdf("a.pdf"), await pdf("b.pdf"));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await listSessionDrafts()).toEqual([]);
  });
});

describe("exportar e importar la configuracion", () => {
  async function exportedBlob(): Promise<Blob> {
    const calls = vi.mocked(downloadBlob).mock.calls;
    await waitFor(() => expect(vi.mocked(downloadBlob).mock.calls.length).toBeGreaterThan(0));
    return calls.at(-1)![0] as Blob;
  }

  it("con dos documentos exporta la v2: los dos PDF y el manifiesto, con el nombre de la ronda", async () => {
    const { container } = renderTool();
    await load(container, await pdf("a.pdf"), await pdf("b.pdf"));
    await startRound();
    fireEvent.click(screen.getAllByRole("button", { name: strings.exportConfigButton })[0]);
    const blob = await exportedBlob();
    expect(vi.mocked(downloadBlob).mock.calls.at(-1)![1]).toBe("Configuracion - 2 documentos.zip");
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(["documentos/01.pdf", "documentos/02.pdf", "manifest.json"]);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("text"));
    expect(manifest.version).toBe(2);
    expect(manifest.documents.map((doc: { name: string }) => doc.name)).toEqual(["a.pdf", "b.pdf"]);
    expect(manifest.signers).toHaveLength(1);
    expect(JSON.stringify(manifest)).not.toContain("dataUrl");
  });

  it("con un documento exporta la v1 de siempre", async () => {
    const { container } = renderTool();
    await load(container, await pdf("solo.pdf"));
    await startRound();
    fireEvent.click(screen.getAllByRole("button", { name: strings.exportConfigButton })[0]);
    const blob = await exportedBlob();
    expect(vi.mocked(downloadBlob).mock.calls.at(-1)![1]).toBe("solo-config.zip");
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(["documento.pdf", "manifest.json"]);
    expect(JSON.parse(await zip.file("manifest.json")!.async("text")).version).toBe(1);
  });

  it("el panel avisa de que el .zip contiene los documentos", async () => {
    const { container } = renderTool();
    await load(container, await pdf("a.pdf"), await pdf("b.pdf"));
    await toMulti();
    expect(screen.getAllByText(strings.exportConfigNote).length).toBeGreaterThan(0);
  });

  it("importar un .zip v2 carga los dos documentos, los firmantes y el modo", async () => {
    const a = await pdf("contrato.pdf");
    const b = await pdf("anexo.pdf");
    const blob = await exportSignConfigSet(
      [
        { id: docIdOf(a), file: a, fields: [], textFields: [], textValues: {} },
        { id: docIdOf(b), file: b, fields: [], textFields: [], textValues: {} },
      ],
      {
        mode: "multi",
        signMode: "independent",
        signers: [
          { id: "sg-91", name: "Marta", color: "#0d4bff" },
          { id: "sg-92", name: "Pablo", color: "#e5484d" },
        ],
        blocks: [],
      },
    );
    const { container } = renderTool();
    fireEvent.change(zipInput(container), {
      target: { files: [new File([blob], "ronda.zip", { type: "application/zip" })] },
    });
    await waitFor(() => expect(docNav()).not.toBeNull());
    expect(docButtons().map((button) => button.textContent)).toEqual(["1. contrato.pdf", "2. anexo.pdf"]);
    expect(await screen.findByDisplayValue("Marta")).toBeTruthy();
    expect(screen.getByDisplayValue("Pablo")).toBeTruthy();
  });

  it("importar un .zip v1 sigue cargando un solo documento", async () => {
    const a = await pdf("viejo.pdf");
    const blob = await exportSignConfigSet(
      [{ id: docIdOf(a), file: a, fields: [], textFields: [], textValues: {} }],
      {
        mode: "multi",
        signMode: "same",
        signers: [{ id: "sg-93", name: "Rosa", color: "#0d4bff" }],
        blocks: [],
      },
    );
    const { container } = renderTool();
    fireEvent.change(zipInput(container), {
      target: { files: [new File([blob], "viejo.zip", { type: "application/zip" })] },
    });
    expect(await screen.findByDisplayValue("Rosa")).toBeTruthy();
    expect(docNav()).toBeNull();
  });

  it("un .zip manipulado se rechaza con el mensaje de configuracion no valida", async () => {
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify({ version: 2 }));
    const { container } = renderTool();
    fireEvent.change(zipInput(container), {
      target: { files: [new File([await zip.generateAsync({ type: "blob" })], "malo.zip")] },
    });
    expect(await screen.findByText(es.tool.errors.invalidConfig)).toBeTruthy();
    expect(docNav()).toBeNull();
  });
});

describe("plantillas con varios documentos", () => {
  beforeEach(() => {
    setSignPdfFeatureFlag("reusableTemplates", true);
    saveTemplate({
      name: "Dos firmantes",
      pageCount: 2,
      signers: [
        { id: "sg-a", name: "Ana", color: "#0d4bff" },
        { id: "sg-b", name: "Luis", color: "#e5484d" },
      ],
      fields: [
        { id: "f1", signerId: "sg-a", pageIndex: 0, type: "signature", rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } },
        { id: "f2", signerId: "sg-b", pageIndex: 1, type: "signature", rect: { x: 0.1, y: 0.4, width: 0.2, height: 0.1 } },
      ],
      textFields: [],
    });
  });

  it("«Aplicar a todos los documentos» solo aparece con varios documentos", async () => {
    const { container } = renderTool();
    await load(container, await pdf("solo.pdf"));
    await toMulti();
    fireEvent.click((await screen.findAllByRole("button", { name: strings.templatesButton }))[0]);
    await screen.findByText("Dos firmantes");
    expect(screen.queryByRole("button", { name: strings.templatesApplyAll })).toBeNull();
  });

  it("aplica la plantilla a TODOS los documentos: los mismos firmantes y los huecos repetidos en cada uno", async () => {
    const { container } = renderTool();
    await load(container, await pdf("a.pdf"), await pdf("b.pdf"));
    await toMulti();
    fireEvent.click((await screen.findAllByRole("button", { name: strings.templatesButton }))[0]);
    fireEvent.click(await screen.findByRole("button", { name: strings.templatesApplyAll }));

    await waitFor(async () => {
      const [meta] = await listSessionDrafts();
      expect(meta?.signers.map((signer) => signer.name)).toEqual(["Ana", "Luis"]);
      expect(Object.values(meta.docStates).map((state) => state.fields.length)).toEqual([2, 2]);
    }, { interval: 100 });
    const [meta] = await listSessionDrafts();
    const ids = Object.values(meta.docStates).flatMap((state) => state.fields.map((field) => field.id));
    expect(new Set(ids).size).toBe(4);
    expect(await screen.findByText(strings.applyTemplateAllDone(2, 0))).toBeTruthy();
  });

  it("si ya habia una disposicion pide confirmacion antes de reemplazar TODA la ronda", async () => {
    const { container } = renderTool();
    await load(container, await pdf("a.pdf"), await pdf("b.pdf"));
    await startRound();
    fireEvent.click((await screen.findAllByRole("button", { name: strings.templatesButton }))[0]);
    fireEvent.click(await screen.findByRole("button", { name: strings.templatesApplyAll }));
    expect(await screen.findByText(strings.applyTemplateAllConfirmBody)).toBeTruthy();
    // Cancelar no cambia nada.
    fireEvent.click(screen.getByRole("button", { name: strings.confirmCancel }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(strings.applyTemplateAllDone(2, 0))).toBeNull();
  });
});

describe("topes de la ronda y flag multiDocument al retomar o importar", () => {
  async function seedSession(docCount: number): Promise<string> {
    const files = await Promise.all(
      Array.from({ length: docCount }, (_, index) => pdf(`d${index + 1}.pdf`)),
    );
    const result = await saveSessionDraft({
      id: "s-topes",
      mode: "multi",
      signMode: "same",
      signers: [{ id: "sg-t1", name: "Ana", color: "#0d4bff" }],
      blocks: [],
      documents: await Promise.all(
        files.map(async (file, index) => {
          const bytes = new Uint8Array(await file.arrayBuffer());
          return {
            id: `doc-${index + 1}`,
            fileName: file.name,
            size: bytes.byteLength,
            state: { ...EMPTY_DOC_STATE },
            getBytes: async () => bytes,
          };
        }),
      ),
      activeDocId: "doc-1",
      step: "signers",
    });
    expect(result.ok).toBe(true);
    return "s-topes";
  }

  async function resume() {
    fireEvent.click(screen.getByRole("button", { name: strings.draftsButton }));
    fireEvent.click(await screen.findByRole("button", { name: strings.draftsResume }));
  }

  it("fitDocumentPrefix: los primeros que caben, parando en el primero que no", () => {
    expect(fitDocumentPrefix([])).toBe(0);
    expect(fitDocumentPrefix(Array.from({ length: 12 }, () => ({ size: 1 })))).toBe(MAX_DOCUMENTS);
    expect(fitDocumentPrefix([{ size: 10 }, { size: 101 * MB }, { size: 10 }])).toBe(1);
    expect(fitDocumentPrefix([{ size: 100 * MB }, { size: 100 * MB }, { size: 1 }])).toBe(2);
  });

  it("retomar una sesion de 11 documentos restaura solo los primeros 10 y avisa", async () => {
    await seedSession(MAX_DOCUMENTS + 1);
    renderTool();
    await resume();
    await waitFor(() => expect(docNav()).not.toBeNull());
    expect(docButtons()).toHaveLength(MAX_DOCUMENTS);
    expect(docButtons().at(-1)!.textContent).toBe(`${MAX_DOCUMENTS}. d${MAX_DOCUMENTS}.pdf`);
    expect(await screen.findByText(strings.draftsResumeTrimmed(MAX_DOCUMENTS, MAX_DOCUMENTS + 1))).toBeTruthy();
  });

  it("el aviso de recorte existe en es y en", () => {
    expect(strings.draftsResumeTrimmed(10, 12)).toMatch(/10 de 12/);
    expect(SIGN_STRINGS.en.draftsResumeTrimmed(10, 12)).toMatch(/10 of 12/);
    expect(strings.multiDocOffNotice.length).toBeGreaterThan(30);
    expect(SIGN_STRINGS.en.multiDocOffNotice.length).toBeGreaterThan(30);
  });

  it("con «varios documentos» apagado, retomar una sesion de varios NO carga N documentos: avisa y deja el borrador intacto", async () => {
    await seedSession(3);
    setSignPdfFeatureFlag("multiDocument", false);
    const { container } = renderTool();
    await resume();
    expect(await screen.findByText(strings.multiDocOffNotice)).toBeTruthy();
    expect(docNav()).toBeNull();
    expect(container.querySelector("li")).toBeNull();
    expect(screen.queryByText(es.tool.filesTitle)).toBeNull();
    expect(await listSessionDrafts()).toHaveLength(1);
    expect((await loadSessionDraft("s-topes"))!.files).toHaveLength(3);
  });

  it("con «varios documentos» apagado, importar una configuracion v2 de varios tampoco carga N documentos", async () => {
    const a = await pdf("a.pdf");
    const b = await pdf("b.pdf");
    const blob = await exportSignConfigSet(
      [
        { id: docIdOf(a), file: a, fields: [], textFields: [], textValues: {} },
        { id: docIdOf(b), file: b, fields: [], textFields: [], textValues: {} },
      ],
      { mode: "multi", signMode: "same", signers: [], blocks: [] },
    );
    setSignPdfFeatureFlag("multiDocument", false);
    const { container } = renderTool();
    fireEvent.change(zipInput(container), {
      target: { files: [new File([blob], "ronda.zip", { type: "application/zip" })] },
    });
    expect(await screen.findByText(strings.multiDocOffNotice)).toBeTruthy();
    expect(screen.queryByText(es.tool.filesTitle)).toBeNull();
  });

  it("con el flag apagado un documento suelto (v1) se sigue retomando", async () => {
    setSignPdfFeatureFlag("multiDocument", false);
    const { container } = renderTool();
    const a = await pdf("solo.pdf");
    fireEvent.change(pdfInput(container), { target: { files: [a] } });
    await waitFor(() => expect(screen.getByText(es.tool.filesTitle)).toBeTruthy());
    expect(docNav()).toBeNull();
  });

  it("con UN documento, pagehide vuelca el borrador v1 sin esperar al debounce", async () => {
    const { container } = renderTool();
    await load(container, await pdf("solo.pdf"));
    await startRound();
    expect(await listDrafts()).toEqual([]);
    window.dispatchEvent(new Event("pagehide"));
    await waitFor(async () => expect(await listDrafts()).toHaveLength(1), { timeout: 600, interval: 25 });
  });

  it("con dos documentos, pagehide vuelca la sesion sin esperar al debounce", async () => {
    const { container } = renderTool();
    await load(container, await pdf("a.pdf"), await pdf("b.pdf"));
    await startRound();
    expect(await listSessionDrafts()).toEqual([]);
    window.dispatchEvent(new Event("pagehide"));
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 600, interval: 25 });
  });
});
