import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PrivacyNotice } from "@/app/sign-pdf/PrivacyNotice";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { clearAllDrafts, listDrafts, saveDraft } from "@/app/sign-pdf/signDrafts";
import {
  __resetSignTemplatesCacheForTests,
  listTemplates,
  saveTemplate,
} from "@/app/sign-pdf/signTemplates";
import {
  SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
  __resetSignPdfFeatureFlagsCacheForTests,
} from "@/app/sign-pdf/signFeatureFlags";
import { clearVault, listVault, saveVaultEntry } from "@/app/sign-pdf/signVault";
import { vaultInput } from "@/app/sign-pdf/vaultTestUtils";
import { clearValueHistory, recordValue, suggestValues } from "@/lib/valueHistory";

/**
 * «Borrar datos» de «Varios firmantes»: ahora tambien vacia el baul de firmas,
 * y solo dice «Datos borrados» cuando terminaron los borrados asincronos.
 */

vi.mock("@/app/sign-pdf/signDrafts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/sign-pdf/signDrafts")>();
  return { ...actual, clearAllDrafts: vi.fn(actual.clearAllDrafts) };
});

vi.mock("@/app/sign-pdf/signVault", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/sign-pdf/signVault")>();
  return { ...actual, clearVault: vi.fn(actual.clearVault) };
});

const strings = SIGN_STRINGS.es;

beforeEach(async () => {
  window.localStorage.clear();
  window.localStorage.setItem("optimuspdf.sign-pdf.privacyNoticeSeen", "1");
  __resetSignTemplatesCacheForTests();
  clearValueHistory();
  await clearAllDrafts();
  await clearVault();
  vi.mocked(clearVault).mockClear();
  vi.mocked(clearAllDrafts).mockClear();
});

async function seedEverything() {
  recordValue("nombre", "Ana Perez");
  saveTemplate({
    name: "Contrato tipo",
    pageCount: 1,
    signers: [{ id: "sg-1", name: "Ana Pérez", color: "#0d4bff" }],
    fields: [],
    textFields: [],
  });
  await saveDraft({
    id: "doc-1",
    fileBytes: new Uint8Array([1, 2, 3]),
    fileName: "doc-1.pdf",
    manifest: { mode: "multi", signers: [], fields: [], textFields: [], textValues: {} },
    step: "signers",
    captures: {},
    textFieldsDetectedFor: null,
  });
  expect((await saveVaultEntry(vaultInput("Ana Pérez"))).ok).toBe(true);
}

async function confirmClear() {
  fireEvent.click(screen.getByRole("button", { name: strings.privacyClearData }));
  const dialog = await screen.findByRole("dialog", { name: strings.privacyClearDataTitle });
  fireEvent.click(within(dialog).getByRole("button", { name: strings.privacyClearData }));
}

describe("PrivacyNotice — «Borrar datos»", () => {
  it("vacia valores, plantillas, borradores y firmas guardadas, y solo despues dice «Datos borrados»", async () => {
    await seedEverything();
    render(<PrivacyNotice strings={strings} />);
    await confirmClear();
    expect(await screen.findByText(strings.privacyDataCleared)).toBeTruthy();

    expect(suggestValues("nombre", "")).toHaveLength(0);
    expect(listTemplates()).toHaveLength(0);
    expect(await listDrafts()).toHaveLength(0);
    expect((await listVault()).entries).toHaveLength(0);
  });

  it("no afirma el borrado mientras el del baul siga en marcha", async () => {
    await seedEverything();
    const actual = await vi.importActual<typeof import("@/app/sign-pdf/signVault")>(
      "@/app/sign-pdf/signVault",
    );
    let release: () => void = () => {};
    vi.mocked(clearVault).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => void actual.clearVault().then(resolve);
        }),
    );
    render(<PrivacyNotice strings={strings} />);
    await confirmClear();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(strings.privacyDataCleared)).toBeNull();

    release();
    expect(await screen.findByText(strings.privacyDataCleared)).toBeTruthy();
  });

  it("baul bloqueado: NO dice «Datos borrados», dice que fallo (role=status) y se puede reintentar", async () => {
    await seedEverything();
    vi.mocked(clearVault).mockResolvedValueOnce({ ok: false, reason: "unavailable" });
    render(<PrivacyNotice strings={strings} />);
    await confirmClear();
    const message = await screen.findByText(strings.vaultClearFailed(["vault"]));
    expect(message.getAttribute("role")).toBe("status");
    expect(screen.queryByText(strings.privacyDataCleared)).toBeNull();
    expect((await listVault()).entries).toHaveLength(1);

    // Reintento: espera a que la hoja de confirmacion anterior termine de salir.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 5000 });
    await confirmClear();
    expect(await screen.findByText(strings.privacyDataCleared)).toBeTruthy();
    expect(screen.queryByText(strings.vaultClearFailed(["vault"]))).toBeNull();
    expect((await listVault()).entries).toHaveLength(0);
  });

  it("borradores que no se pueden borrar: tambien se dice, y no se muestra el exito", async () => {
    vi.mocked(clearAllDrafts).mockResolvedValueOnce({ ok: false, reason: "unavailable" });
    render(<PrivacyNotice strings={strings} />);
    await confirmClear();
    expect(await screen.findByText(strings.vaultClearFailed(["drafts"]))).toBeTruthy();
    expect(screen.queryByText(strings.privacyDataCleared)).toBeNull();
  });

  it("el aviso vive en un role=status siempre montado (vacio antes de borrar)", () => {
    render(<PrivacyNotice strings={strings} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");
  });

  it("el texto de la confirmacion menciona las firmas guardadas y la nota del baul habla de «Recordar» y del archivo en claro", () => {
    for (const language of ["es", "en"] as const) {
      const copy = SIGN_STRINGS[language];
      expect(copy.privacyNoticeVaultNote).toMatch(/(Recordar|Remember)/);
      expect(copy.privacyNoticeVaultNote).toMatch(/(claro|in the clear)/);
      // El cuerpo general ya no habla de una casilla que puede no existir.
      expect(copy.privacyNoticeBody).not.toMatch(/(Recordar|Remember)/);
      expect(copy.privacyClearDataBody).toMatch(/(firmas|signatures)/);
    }
  });

  describe("la nota de «Recordar en este dispositivo» solo sale con el baul encendido", () => {
    function openNotice(language: "es" | "en") {
      // Sin la marca de «aviso visto» el aviso arranca abierto.
      window.localStorage.removeItem("optimuspdf.sign-pdf.privacyNoticeSeen");
      __resetSignPdfFeatureFlagsCacheForTests();
      render(<PrivacyNotice strings={SIGN_STRINGS[language]} />);
    }

    for (const language of ["es", "en"] as const) {
      it(`flag encendido (${language}): el aviso incluye la nota`, () => {
        openNotice(language);
        const copy = SIGN_STRINGS[language];
        expect(screen.getByText(new RegExp(copy.privacyNoticeVaultNote.slice(0, 40)))).toBeTruthy();
      });

      it(`flag apagado (${language}): el aviso NO menciona la casilla`, () => {
        window.localStorage.setItem(
          SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
          JSON.stringify({ signatureVault: false }),
        );
        openNotice(language);
        const copy = SIGN_STRINGS[language];
        expect(screen.getByText(new RegExp(copy.privacyNoticeBody.slice(0, 40)))).toBeTruthy();
        expect(screen.queryByText(/(Recordar en este dispositivo|Remember on this device)/)).toBeNull();
      });
    }
  });
});
