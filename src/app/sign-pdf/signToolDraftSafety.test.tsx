import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PDFDocument } from "@cantoo/pdf-lib";
import { SignToolClient } from "@/app/sign-pdf/SignToolClient";
import { documentContentKey } from "@/app/sign-pdf/documentKey";
import { __closeWarmDraftsConnectionForTests, clearAllDrafts, draftFingerprint, listDrafts } from "@/app/sign-pdf/signDrafts";
import { __resetSignPdfFeatureFlagsCacheForTests } from "@/app/sign-pdf/signFeatureFlags";
import { __resetSignTemplatesCacheForTests } from "@/app/sign-pdf/signTemplates";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { detectFields } from "@/lib/pdf/detectFields";
import { __resetValueHistoryCacheForTests } from "@/lib/valueHistory";

/**
 * F0-fix a traves de `SignToolClient` completo (sobre IndexedDB falsa): D2 (si el navegador no deja guardar, el aviso lo dice
 * y desaparece cuando vuelve a funcionar) y D3 (la misma plantilla para otro cliente NO pisa el borrador del primero).
 */

vi.mock("@/lib/pdf/detectFields", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/detectFields")>();
  return { ...actual, detectFields: vi.fn(async () => []) };
});

const strings = SIGN_STRINGS.es;
const r = strings.resume;

async function pdfFile(name: string, size = 312): Promise<File> {
  // Sin fecha ni productor de la libreria: los MISMOS bytes siempre, aunque pase tiempo entre una creacion y otra.
  const document = await PDFDocument.create({ updateMetadata: false });
  document.setCreationDate(new Date(0));
  document.setModificationDate(new Date(0));
  document.addPage([size, size]);
  const bytes = await document.save({ useObjectStreams: true });
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

function pdfInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"][accept*="pdf"]');
  if (!input) throw new Error("no se encontro el input de archivo PDF");
  return input as HTMLInputElement;
}

function renderTool() {
  return render(
    <LanguageProvider>
      <SignToolClient />
    </LanguageProvider>,
  );
}

/** «Varios firmantes» + `count` firmantes dados de alta (lo minimo para que haya algo que guardar). */
async function startRound(count = 1) {
  fireEvent.click(await screen.findByRole("tab", { name: strings.modeMulti }));
  for (let n = 0; n < count; n += 1) fireEvent.click(screen.getByRole("button", { name: strings.addSigner }));
}

function failPuts(...stores: string[]) {
  const original = IDBObjectStore.prototype.put;
  return vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function patched(this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
    if (stores.includes(this.name)) throw new DOMException("cuota llena (simulada)", "QuotaExceededError");
    return original.apply(this, args);
  });
}

const health = () => document.querySelector("[data-draft-health]") as HTMLElement;

beforeEach(async () => {
  vi.mocked(detectFields).mockReset();
  vi.mocked(detectFields).mockResolvedValue([]);
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/sign-pdf");
  __resetValueHistoryCacheForTests();
  __resetSignPdfFeatureFlagsCacheForTests();
  __resetSignTemplatesCacheForTests();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  __closeWarmDraftsConnectionForTests();
  await clearAllDrafts();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await new Promise((resolve) => setTimeout(resolve, 120));
  await clearAllDrafts();
});

describe("D2 · UN documento: el aviso de «sin autoguardado»", () => {
  it("con la cuota llena dice «Sin autoguardado...» y NO hay borrador; al volver a funcionar, el siguiente cambio guarda y el aviso se retira", async () => {
    const spy = failPuts("draftMeta");
    const file = await pdfFile("contrato.pdf");
    const { container } = renderTool();
    fireEvent.change(pdfInput(container), { target: { files: [file] } });
    await startRound(1);
    await waitFor(() => expect(health().textContent).toContain(r.draftFailedNotice), { timeout: 5000 });
    expect(health().className).not.toContain("sr-only");
    expect(await listDrafts()).toEqual([]);

    // El navegador vuelve a dejar guardar: el siguiente cambio (un segundo firmante) reintenta.
    spy.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: strings.addSigner }));
    await waitFor(async () => expect(await listDrafts()).toHaveLength(1), { timeout: 5000 });
    await waitFor(() => expect(health().textContent).toBe(""), { timeout: 5000 });
    expect(health().className).toContain("sr-only");
  });

  it("sin fallos no hay aviso", async () => {
    const file = await pdfFile("contrato.pdf");
    const { container } = renderTool();
    fireEvent.change(pdfInput(container), { target: { files: [file] } });
    await startRound(1);
    await waitFor(async () => expect(await listDrafts()).toHaveLength(1), { timeout: 5000 });
    expect(health().textContent).toBe("");
  });
});

describe("D3 · la misma plantilla (1 documento) para otro cliente", () => {
  it("cada sesion de trabajo guarda en SU borrador (id propio de 64 hex, la huella aparte); «Empezar de nuevo» no pisa el del primero", async () => {
    const template = await pdfFile("plantilla.pdf", 314);
    const fingerprint = await documentContentKey(template);

    // Cliente A: un firmante.
    const first = renderTool();
    fireEvent.change(pdfInput(first.container), { target: { files: [template] } });
    await startRound(1);
    await waitFor(async () => expect(await listDrafts()).toHaveLength(1), { timeout: 5000 });
    const [draftA] = await listDrafts();
    expect(draftA.id).toMatch(/^[0-9a-f]{64}$/);
    expect(draftA.id).not.toBe(fingerprint);
    expect(draftFingerprint(draftA)).toBe(fingerprint);
    expect(draftA.signers).toHaveLength(1);
    first.unmount();
    window.history.replaceState(null, "", "/sign-pdf");

    // Cliente B: MISMO PDF. Se ofrece retomar el de A; se elige «Empezar de nuevo» y se trabaja con DOS firmantes.
    const second = renderTool();
    fireEvent.change(pdfInput(second.container), { target: { files: [await pdfFile("plantilla.pdf", 314)] } });
    fireEvent.click(await screen.findByRole("button", { name: r.offerStartOver }));
    await startRound(2);
    await waitFor(async () => expect(await listDrafts()).toHaveLength(2), { timeout: 5000 });
    // Varios autoguardados mas del cliente B: ninguno pisa al de A.
    fireEvent.click(screen.getByRole("button", { name: strings.addSigner }));
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const drafts = await listDrafts();
    expect(drafts).toHaveLength(2);
    const a = drafts.find((draft) => draft.id === draftA.id);
    const b = drafts.find((draft) => draft.id !== draftA.id);
    expect(a?.signers).toHaveLength(1);
    expect(b?.signers.length).toBeGreaterThanOrEqual(2);
    expect(b ? draftFingerprint(b) : "").toBe(fingerprint);
  });

  it("al volver a subir el mismo PDF se ofrece el MAS RECIENTE y «Ver todos» abre la lista con los dos (fecha y firmantes)", async () => {
    const template = await pdfFile("plantilla.pdf", 316);
    const first = renderTool();
    fireEvent.change(pdfInput(first.container), { target: { files: [template] } });
    await startRound(1);
    await waitFor(async () => expect(await listDrafts()).toHaveLength(1), { timeout: 5000 });
    first.unmount();
    window.history.replaceState(null, "", "/sign-pdf");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = renderTool();
    fireEvent.change(pdfInput(second.container), { target: { files: [await pdfFile("plantilla.pdf", 316)] } });
    fireEvent.click(await screen.findByRole("button", { name: r.offerStartOver }));
    await startRound(2);
    await waitFor(async () => expect(await listDrafts()).toHaveLength(2), { timeout: 5000 });
    second.unmount();
    window.history.replaceState(null, "", "/sign-pdf");

    const third = renderTool();
    fireEvent.change(pdfInput(third.container), { target: { files: [await pdfFile("plantilla.pdf", 316)] } });
    const offer = await waitFor(() => {
      const el = document.querySelector("[data-resume-offer]");
      if (!el) throw new Error("sin oferta");
      return el as HTMLElement;
    });
    // El mas reciente es el de DOS firmantes (el segundo cliente).
    expect(offer.textContent).toContain("Firmantes: Firmante 1, Firmante 2");
    expect(offer.textContent).toContain("Hay 1 más sin terminar.");
    fireEvent.click(within(offer).getByRole("button", { name: r.viewAll }));
    const sheet = await screen.findByRole("dialog", { name: strings.draftsTitle });
    expect(await within(sheet).findAllByRole("listitem")).toHaveLength(2);
    const text = sheet.textContent ?? "";
    expect(text).toContain("Firmantes: Firmante 1, Firmante 2");
    expect(text).toContain("Firmantes: Firmante 1");
    expect(within(sheet).getAllByText(/Guardado el /)).toHaveLength(2);
  });

  it("retomar un borrador y seguir trabajando lo guarda en EL MISMO borrador (no crea otro)", async () => {
    const template = await pdfFile("plantilla.pdf", 318);
    const first = renderTool();
    fireEvent.change(pdfInput(first.container), { target: { files: [template] } });
    await startRound(1);
    await waitFor(async () => expect(await listDrafts()).toHaveLength(1), { timeout: 5000 });
    const [draft] = await listDrafts();
    first.unmount();
    window.history.replaceState(null, "", "/sign-pdf");

    renderTool();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(strings.draftsButton) }));
    fireEvent.click(await screen.findByRole("button", { name: strings.draftsResume }));
    await screen.findByRole("button", { name: strings.removeSigner(strings.defaultSignerName(1)) });
    fireEvent.click(screen.getByRole("button", { name: strings.addSigner }));
    await waitFor(async () => expect((await listDrafts())[0].signers).toHaveLength(2), { timeout: 5000 });
    const after = await listDrafts();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(draft.id);
    expect(after[0].copyOf).toBeUndefined();
  });
});

/** Escribe una fila tal cual (como la dejo una version anterior: sin `fingerprint`, `rev` ni `writerId`). */
async function putLegacyDocumentDraft(id: string, name: string): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("optimuspdf-sign-drafts", 2);
    request.onupgradeneeded = () => {
      for (const store of ["draftFiles", "draftMeta", "sessionMeta"]) {
        if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["draftFiles", "draftMeta"], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore("draftFiles").put({ id, bytes: new Uint8Array([37, 80, 68, 70, 9]) });
    tx.objectStore("draftMeta").put({
      id,
      fileName: name,
      fileSize: 5,
      savedAt: new Date().toISOString(),
      mode: "multi",
      signers: [{ id: "sg-1", name: "Ana", color: "#0d4bff" }],
      fields: [],
      textFields: [],
      textValues: {},
      step: "signers",
      captures: {},
      textFieldsDetectedFor: null,
    });
  });
  db.close();
}

describe("migracion: un borrador anterior (su id ES la huella, sin campo `fingerprint`)", () => {
  it("se retoma y se sigue guardando bajo SU MISMO id (no se duplica); el borrador queda con su huella escrita", async () => {
    // El id de un borrador anterior ES la huella real del PDF guardado (sha-256 de sus bytes).
    const legacyId = await documentContentKey(new File([new Uint8Array([37, 80, 68, 70, 9])], "viejo.pdf", { type: "application/pdf" }));
    await putLegacyDocumentDraft(legacyId, "viejo.pdf");
    const [seeded] = await listDrafts();
    expect(seeded.id).toBe(legacyId);
    expect(seeded.fingerprint).toBeUndefined();
    expect(seeded.rev).toBeUndefined();

    renderTool();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(strings.draftsButton) }));
    fireEvent.click(await screen.findByRole("button", { name: strings.draftsResume }));
    await screen.findByRole("button", { name: strings.removeSigner("Ana") });
    fireEvent.click(screen.getByRole("button", { name: strings.addSigner }));
    await waitFor(async () => expect((await listDrafts())[0].signers).toHaveLength(2), { timeout: 5000 });
    const after = await listDrafts();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(legacyId);
    expect(draftFingerprint(after[0])).toBe(legacyId);
    expect(after[0].copyOf).toBeUndefined();
    expect(after[0].rev).toBe(1);
  });
});
