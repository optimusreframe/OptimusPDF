import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PDFDocument } from "@cantoo/pdf-lib";
import { SignToolClient } from "@/app/sign-pdf/SignToolClient";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { installCanvasStubs } from "@/app/sign-pdf/vaultTestUtils";
import {
  __resetSignPdfFeatureFlagsCacheForTests,
  setSignPdfFeatureFlag,
} from "@/app/sign-pdf/signFeatureFlags";
import { clearVault } from "@/app/sign-pdf/signVault";
import { __resetValueHistoryCacheForTests } from "@/lib/valueHistory";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { contractFile, realSignaturePng } from "@/app/pdf-pro/modes/modeTestUtils";

/**
 * F0-U0.5, un documento: con los ajustes por defecto la descarga es SOLO el PDF (con sus paginas y sin boton extra);
 * con «Incluir registro .json aparte» activo aparece «Descargar registro (.json)», un boton secundario que descarga
 * `registro-firmas.json` con el hash SHA-256 del PDF EXACTO que se descargo.
 */

const downloads: { blob: Blob; name: string }[] = [];
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    downloadBlob: (blob: Blob, name: string) => {
      downloads.push({ blob, name });
    },
    openPdfDocument: async () => ({
      numPages: 3,
      getPage: async () => ({ cleanup: () => {} }),
    }),
    renderPageToDataUrl: async () => "data:image/png;base64,iVBORw0KGgo=",
    closePdfDocument: async () => {},
  };
});

const strings = SIGN_STRINGS.es;

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 600, height: 800, top: 0, left: 0, right: 600, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
});

let restoreCanvas = () => {};
beforeEach(async () => {
  downloads.length = 0;
  window.sessionStorage.clear();
  window.localStorage.clear();
  __resetValueHistoryCacheForTests();
  __resetSignPdfFeatureFlagsCacheForTests();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  restoreCanvas = installCanvasStubs(realSignaturePng());
  await clearVault();
});
afterEach(() => restoreCanvas());

async function signOneDocument(file: File): Promise<void> {
  const view = render(
    <LanguageProvider>
      <SignToolClient />
    </LanguageProvider>,
  );
  fireEvent.change(view.container.querySelector('input[type="file"][accept*="pdf"]')!, { target: { files: [file] } });
  await screen.findByRole("toolbar", { name: strings.paletteLabel });
  fireEvent.click(screen.getAllByRole("button", { name: strings.createSignature })[0]);
  fireEvent.click(await screen.findByRole("tab", { name: strings.modeType }));
  fireEvent.change(screen.getByLabelText(strings.typeLabel), { target: { value: "Ana" } });
  fireEvent.click(screen.getByRole("button", { name: strings.save }));
  const run = () =>
    screen.getAllByRole("button", { name: "Procesar" }).find((button) => !(button as HTMLButtonElement).disabled);
  await waitFor(() => expect(run()).toBeTruthy());
  fireEvent.click(run()!);
  await screen.findByRole("button", { name: "Descargar" });
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("Firmar PDF, un documento — registro .json aparte", () => {
  it("con los ajustes por defecto: sin boton de registro, y el PDF descargado tiene EXACTAMENTE las paginas del original y los metadatos de OptimusPDF", async () => {
    const { file } = await contractFile(3);
    await signOneDocument(file);
    expect(screen.queryByRole("button", { name: strings.signingRecordDownload })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Descargar" }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    const pdf = await PDFDocument.load(new Uint8Array(await downloads[0].blob.arrayBuffer()), { updateMetadata: false });
    expect(pdf.getPageCount()).toBe(3);
    expect(pdf.getProducer()).toBe("OptimusPDF");
    expect(pdf.getKeywords()).toContain("optimuspdf-signed");
  });

  it("con el interruptor activo: aparece «Descargar registro (.json)» y descarga registro-firmas.json con el hash REAL del PDF descargado", async () => {
    setSignPdfFeatureFlag("signingRecordFile", true);
    const { file } = await contractFile(3);
    await signOneDocument(file);

    const recordButton = await screen.findByRole("button", { name: strings.signingRecordDownload });
    expect(recordButton.textContent).toContain("Descargar registro (.json)");

    // El PDF y el registro son descargas independientes.
    fireEvent.click(screen.getByRole("button", { name: "Descargar" }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    fireEvent.click(recordButton);
    await waitFor(() => expect(downloads).toHaveLength(2));

    const [pdfDownload, recordDownload] = downloads;
    expect(recordDownload.name).toBe("registro-firmas.json");
    expect(recordDownload.blob.type).toBe("application/json");

    const pdfBytes = new Uint8Array(await pdfDownload.blob.arrayBuffer());
    const record = JSON.parse(await recordDownload.blob.text()) as {
      type: string;
      hashAlgorithm: string;
      documents: { file: string; sha256: string; pages: number; signers: string[]; signedAt: string }[];
    };
    expect(record.type).toBe("optimuspdf-signing-record");
    expect(record.hashAlgorithm).toBe("SHA-256");
    expect(record.documents).toHaveLength(1);
    const [row] = record.documents;
    expect(row.file).toBe(pdfDownload.name);
    expect(row.sha256).toBe(await sha256Of(pdfBytes));
    expect(row.pages).toBe(3);
    expect(row.signers).toEqual([]);
    expect(Number.isNaN(Date.parse(row.signedAt))).toBe(false);

    // El registro NUNCA va dentro del PDF: sigue teniendo las paginas del original.
    expect((await PDFDocument.load(pdfBytes, { updateMetadata: false })).getPageCount()).toBe(3);
  });
});
