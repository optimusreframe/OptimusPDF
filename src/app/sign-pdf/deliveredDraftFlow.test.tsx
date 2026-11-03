import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PDFDocument } from "@cantoo/pdf-lib";
import { SignToolClient } from "@/app/sign-pdf/SignToolClient";
import { captureStamp } from "@/app/sign-pdf/captures";
import { documentContentKey } from "@/app/sign-pdf/documentKey";
import { EMPTY_DOC_STATE, type SignerBlock } from "@/app/sign-pdf/docSet";
import { __setDeliveredDeleteDelayForTests } from "@/app/sign-pdf/DeliveredDraftOption";
import { hasPendingDraftWrite } from "@/app/sign-pdf/draftActivity";
import { ANA, LUIS } from "@/app/sign-pdf/draftTestUtils";
import { clearAllDrafts, draftExists, listAllDrafts, saveDraft, saveSessionDraft } from "@/app/sign-pdf/signDrafts";
import { __resetSignPdfFeatureFlagsCacheForTests, setSignPdfFeatureFlag } from "@/app/sign-pdf/signFeatureFlags";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { __resetSignTemplatesCacheForTests } from "@/app/sign-pdf/signTemplates";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { es } from "@/lib/locales/es";
import { detectFields } from "@/lib/pdf/detectFields";
import { downloadBlob } from "@/lib/pdf/core";
import type { SignatureField } from "@/lib/pdf/sign";
import { __resetValueHistoryCacheForTests } from "@/lib/valueHistory";

/*
 * «Borrar el borrador de esta firma» al descargar y la opcion «E-sign» (Fase 0 «Firma agil», U0.4 y U0.7) a traves de
 * `SignToolClient` completo: una ronda real (PDF de verdad, firmas recogidas) restaurada desde su borrador, firmada y
 * llevada hasta la pantalla de resultado; sobre IndexedDB falsa.
 */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: async () => ({ numPages: 1, getPage: async () => ({ cleanup: () => {} }) }),
    renderPageToDataUrl: async () => "data:image/png;base64,iVBORw0KGgo=",
    closePdfDocument: async () => {},
    downloadBlob: vi.fn(),
  };
});
vi.mock("@/lib/pdf/detectFields", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/detectFields")>();
  return { ...actual, detectFields: vi.fn(async () => []) };
});

vi.setConfig({ testTimeout: 40_000 });

const strings = SIGN_STRINGS.es;
const dp = strings.draftPrivacy;

/** PNG real de 1x1 pixel (el que acepta `embedPng`). */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const STROKE = { dataUrl: PNG, ratio: 1 };

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 600, height: 800, top: 0, left: 0, right: 600, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
});

let seed = 900;
async function realPdf(name: string): Promise<File> {
  const document = await PDFDocument.create();
  seed += 1;
  document.addPage([300 + seed, 300]);
  const bytes = await document.save({ useObjectStreams: true });
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

const slot = (signerId: string, id: string): SignatureField => ({
  id,
  signerId,
  pageIndex: 0,
  type: "signature",
  rect: { x: 0.1, y: signerId === "sg-1" ? 0.1 : 0.4, width: 0.3, height: 0.1 },
});

/** Una sesion de DOS documentos reales con las firmas de Ana y Luis ya recogidas (lista para firmar y descargar). */
async function seedSignedSession(id: string): Promise<File[]> {
  const files = [await realPdf("Contrato A.pdf"), await realPdf("Anexo B.pdf")];
  const keys = await Promise.all(files.map((file) => documentContentKey(file)));
  const docIds = ["d1", "d2"];
  const fieldsOf = (index: number) => [ANA, LUIS].map((signer) => slot(signer.id, `fld-${signer.id}-${index}`));
  const blocks: SignerBlock[] = [ANA, LUIS].map((signer, position) => ({
    id: `bk-${position + 1}`,
    signerId: signer.id,
    appliesTo: docIds,
    signature: STROKE,
    initials: null,
    stamps: Object.fromEntries(docIds.map((docId, index) => [docId, captureStamp(keys[index], fieldsOf(index), signer.id)])),
    auto: true,
  }));
  const result = await saveSessionDraft({
    id,
    mode: "multi",
    signMode: "same",
    signers: [ANA, LUIS],
    blocks,
    documents: files.map((file, index) => ({
      id: docIds[index],
      fileName: file.name,
      size: file.size,
      state: { ...EMPTY_DOC_STATE, sealedKey: keys[index], fields: fieldsOf(index) },
      getBytes: async () => new Uint8Array(await file.arrayBuffer()),
    })),
    activeDocId: "d1",
    step: "sign",
    keepSignatures: true,
  });
  if (!result.ok) throw new Error(`no se pudo guardar la sesion de prueba: ${result.reason}`);
  return files;
}

/** Un documento real con UN firmante cuya firma ya esta recogida (borrador de documento suelto). */
async function seedSignedDocument(): Promise<{ file: File; key: string }> {
  const file = await realPdf("Poliza.pdf");
  const key = await documentContentKey(file);
  const fields = [slot("sg-1", "fld-1")];
  await saveDraft({
    id: key,
    fileBytes: new Uint8Array(await file.arrayBuffer()),
    fileName: file.name,
    manifest: { mode: "multi", signers: [ANA], fields, textFields: [], textValues: {} },
    step: "sign",
    captures: { "sg-1": { signature: STROKE, initials: null, stamp: captureStamp(key, fields, "sg-1") } },
    textFieldsDetectedFor: key,
    keepSignatures: true,
  });
  return { file, key };
}

beforeEach(async () => {
  // F0-fix (D5): el borrado tras «Descargar» espera unos segundos (con «Deshacer»); aqui se acorta para no esperar 8 s de verdad.
  __setDeliveredDeleteDelayForTests(30);
  vi.mocked(detectFields).mockReset();
  vi.mocked(detectFields).mockResolvedValue([]);
  vi.mocked(downloadBlob).mockClear();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/sign-pdf");
  __resetValueHistoryCacheForTests();
  __resetSignPdfFeatureFlagsCacheForTests();
  __resetSignTemplatesCacheForTests();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  await clearAllDrafts();
});

afterEach(async () => {
  __setDeliveredDeleteDelayForTests(null);
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

/**
 * Desde W3-B2 el archivo se DESCARGA SOLO al llegar a la pantalla de resultado (`ToolShell.autoDownload`) y eso cuenta como la
 * entrega: la espera del borrado ya empieza ahi (con «Deshacer» y la casilla como verdad). Las pruebas que miran la casilla en la
 * pantalla de resultado (o que desmarcan / se van antes del plazo) alargan la espera para que el borrado no se adelante.
 */
function keepDeleteWaiting(): void {
  __setDeliveredDeleteDelayForTests(60_000);
}

/** Entra con `?s=<id>` (se restaura sola) y espera el borrador al dia, listo para «Firmar y descargar». */
async function restoreAndWaitReady(id: string): Promise<void> {
  window.history.replaceState(null, "", `/sign-pdf?s=${id}`);
  renderTool();
  await waitFor(() => expect(screen.queryByRole("navigation", { name: strings.documentsLabel }) ?? screen.queryByText(strings.applyAndDownload)).not.toBeNull());
  await waitFor(() => expect(hasPendingDraftWrite()).toBe(false), { timeout: 8000 });
}

/** Entra con `?s=<id>` (se restaura sola), espera el borrador al dia y firma y descarga hasta la pantalla de resultado. */
async function restoreAndFinish(id: string): Promise<void> {
  await restoreAndWaitReady(id);
  fireEvent.click(await screen.findByRole("button", { name: strings.applyAndDownload }));
  await screen.findByRole("button", { name: "Descargar" }, { timeout: 30_000 });
}

describe("pantalla de resultado de una ronda de VARIOS documentos (ZIP)", () => {
  it("trae la casilla «Borrar el borrador de esta firma (incluye las firmas guardadas en él)» MARCADA, dentro de la tarjeta de descarga", async () => {
    keepDeleteWaiting();
    await seedSignedSession("s-mgl1a-1k3v9x2a");
    await restoreAndFinish("s-mgl1a-1k3v9x2a");
    const card = screen.getByRole("heading", { name: es.tool.doneTitle }).closest("section") as HTMLElement;
    const box = within(card).getByRole("checkbox", { name: dp.deleteLabelWithSignatures }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(card.querySelector("[data-download-extras]")?.contains(box)).toBe(true);
  });

  it("con la casilla marcada, la descarga automatica entrega el ZIP Y borra el borrador de la sesion; «Descargar» queda de respaldo y la tarjeta de entrada ya no lo ofrece", async () => {
    const id = "s-mgl1a-1k3v9x2a";
    await seedSignedSession(id);
    await restoreAndWaitReady(id);
    // Antes de entregar, el borrador de la ronda sigue ahi.
    expect(await draftExists("session", id)).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: strings.applyAndDownload }));
    await screen.findByRole("button", { name: "Descargar" }, { timeout: 30_000 });

    // W3-B2: el ZIP se descarga solo al llegar al resultado (una vez) y eso cuenta como la entrega: el borrado sigue (con la espera).
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(dp.deleteDone)).toBeTruthy());
    expect(await draftExists("session", id)).toBe(false);
    expect(await listAllDrafts()).toEqual([]);

    // «Descargar» sigue ahi por si el navegador no dejo hacer la descarga sola: vuelve a entregar el mismo archivo.
    fireEvent.click(screen.getByRole("button", { name: "Descargar" }));
    expect(downloadBlob).toHaveBeenCalledTimes(2);
    expect(vi.mocked(downloadBlob).mock.calls[1][1]).toBe(vi.mocked(downloadBlob).mock.calls[0][1]);

    // «Empezar de nuevo»: la herramienta vacia ya no ofrece la ronda entregada.
    fireEvent.click(screen.getByRole("button", { name: "Empezar de nuevo" }));
    await screen.findByRole("button", { name: strings.draftsButton });
    expect(screen.queryByRole("heading", { name: strings.resume.cardTitle })).toBeNull();
  });

  it("con la casilla DESMARCADA durante la espera, la descarga ya hecha CONSERVA el borrador (con la caducidad de 7 dias)", async () => {
    // La descarga automatica ya entrego el ZIP y el borrado espera su plazo; la casilla es la verdad: desmarcarla lo cancela.
    keepDeleteWaiting();
    const id = "s-mgl1b-1k3v9x2a";
    await seedSignedSession(id);
    await restoreAndFinish(id);
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(dp.deleteSoon)).toBeTruthy());
    fireEvent.click(screen.getByRole("checkbox", { name: dp.deleteLabelWithSignatures }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await draftExists("session", id)).toBe(true);
    const [entry] = await listAllDrafts();
    expect(entry.kind === "session" && typeof entry.meta.expiresAt).toBe("string");
    expect(screen.queryByText(dp.deleteDone)).toBeNull();
    expect(screen.getByText(dp.deleteKeptExpires)).toBeTruthy();
  });

  it("irse (Empezar de nuevo) antes de que pase el plazo NO borra el borrador: la llegada del archivo no se puede confirmar", async () => {
    // Con la descarga automatica ya hay una entrega, pero el borrado espera su plazo y se cancela si la persona se va antes.
    keepDeleteWaiting();
    const id = "s-mgl1c-1k3v9x2a";
    await seedSignedSession(id);
    await restoreAndFinish(id);
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Empezar de nuevo" }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await draftExists("session", id)).toBe(true);
  });

  it("con el ajuste «guardar las firmas» apagado la casilla no promete firmas y no explica el plazo", async () => {
    keepDeleteWaiting();
    setSignPdfFeatureFlag("signaturesInDraft", false);
    const id = "s-mgl1d-1k3v9x2a";
    await seedSignedSession(id);
    await restoreAndFinish(id);
    expect(screen.getByRole("checkbox", { name: dp.deleteLabel })).toBeTruthy();
    expect(screen.queryByText(dp.deleteHintKept)).toBeNull();
  });
});

describe("pantalla de resultado de UN documento", () => {
  it("la descarga automatica con la casilla marcada borra el borrador del documento suelto; «Descargar» queda de respaldo", async () => {
    const { key } = await seedSignedDocument();
    window.history.replaceState(null, "", `/sign-pdf?s=${key}`);
    renderTool();
    await waitFor(() => expect(screen.queryByRole("button", { name: strings.applyAndDownload })).not.toBeNull());
    await waitFor(() => expect(hasPendingDraftWrite()).toBe(false), { timeout: 8000 });
    // Antes de entregar, el borrador del documento sigue ahi.
    expect(await draftExists("document", key)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: strings.applyAndDownload }));
    // Un documento con varios firmantes pregunta por el prefijo del nombre antes de procesar.
    const prefixNo = await screen.findByRole("button", { name: strings.filenamePrefixNo }).catch(() => null);
    if (prefixNo) fireEvent.click(prefixNo);
    await screen.findByRole("button", { name: "Descargar" }, { timeout: 30_000 });

    // W3-B2: el archivo se descarga solo al llegar al resultado y eso cuenta como la entrega: el borrado sigue (con la espera).
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(dp.deleteDone)).toBeTruthy());
    expect(await draftExists("document", key)).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Descargar" }));
    expect(downloadBlob).toHaveBeenCalledTimes(2);
  });
});

describe("«Solo yo»: sin borrador no hay nada que borrar, pero la opcion «E-sign» esta", () => {
  it("la cabecera de Firmar trae «E-sign · Pedir firma por email» deshabilitada, y no hay casilla de borrado", async () => {
    const { container } = renderTool();
    const input = container.querySelector('input[type="file"][accept*="pdf"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [await realPdf("a.pdf")] } });
    const teaser = await screen.findByRole("button", { name: strings.esign.label + " " + strings.esign.soon });
    expect(teaser.getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByRole("checkbox", { name: dp.deleteLabel })).toBeNull();
  });
});
