import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PrivacyNotice } from "@/app/sign-pdf/PrivacyNotice";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { StripSavedSignatures } from "@/app/sign-pdf/StripSavedSignatures";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { clearAllDrafts, listDrafts, listSessionDrafts, saveDraft, saveSessionDraft } from "@/app/sign-pdf/signDrafts";
import { EMPTY_DOC_STATE, type DocState } from "@/app/sign-pdf/docSet";
import { __resetSignPdfFeatureFlagsCacheForTests } from "@/app/sign-pdf/signFeatureFlags";
import type { SaveDraftParams } from "@/app/sign-pdf/signDrafts";

/**
 * «Quitar ahora las firmas de los borradores guardados» (F0-fix2, N2): el boton, su confirmacion y lo que anuncia. Ajustes lo
 * monta junto al interruptor (ver `SettingsView.signaturesInDraft.test.tsx`) y el aviso de privacidad de Firmar tambien.
 */

const SIGNER = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const STROKE = { dataUrl: "data:image/png;base64,iVBORw0KGgo=", ratio: 0.3 };

async function seedStrokes() {
  const doc = (id: string) => ({
    id,
    fileName: `${id}.pdf`,
    size: 4,
    state: { ...EMPTY_DOC_STATE } as DocState,
    getBytes: async () => new Uint8Array([1, 2, 3, 4]),
  });
  await saveSessionDraft({
    id: "s-strip-1",
    mode: "multi",
    signMode: "same",
    signers: [SIGNER],
    blocks: [{ id: "bk-1", signerId: SIGNER.id, appliesTo: ["d1", "d2"], signature: STROKE, initials: null, stamps: {}, auto: true }],
    documents: [doc("d1"), doc("d2")],
    activeDocId: "d1",
    step: "sign",
  });
  const params: SaveDraftParams = {
    id: "d-strip-1",
    fileBytes: new Uint8Array([9]),
    fileName: "solo.pdf",
    manifest: { mode: "multi", signers: [SIGNER], fields: [], textFields: [], textValues: {} },
    step: "sign",
    captures: { f: { signature: STROKE, initials: null, stamp: "x" } } as unknown as SaveDraftParams["captures"],
    textFieldsDetectedFor: null,
  };
  await saveDraft(params);
}

/**
 * `PrivacyNotice` trae el boton de «Datos recordados» (W3-A1), que lee el idioma del proveedor como en la app: se monta
 * dentro de `LanguageProvider` (el idioma se fija a es para que el aviso sea determinista).
 */
function renderNotice(noticeStrings: ComponentProps<typeof PrivacyNotice>["strings"]) {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  return render(
    <LanguageProvider>
      <PrivacyNotice strings={noticeStrings} />
    </LanguageProvider>,
  );
}

beforeEach(async () => {
  window.localStorage.clear();
  __resetSignPdfFeatureFlagsCacheForTests();
  await clearAllDrafts();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

for (const language of ["es", "en"] as const) {
  const strings = SIGN_STRINGS[language];
  const privacy = strings.draftPrivacy;

  describe(`StripSavedSignatures (${language})`, () => {
    it("es un boton secundario de 44 px que NO actua hasta confirmar: cancelar no toca nada", async () => {
      await seedStrokes();
      render(<StripSavedSignatures strings={strings} />);
      const button = screen.getByRole("button", { name: privacy.clearStrokesButton });
      expect(button.className).toContain("min-h-11");
      expect(button.className).toContain("material-thin");
      fireEvent.click(button);
      const dialog = await screen.findByRole("dialog", { name: privacy.clearStrokesTitle });
      expect(within(dialog).getByText(privacy.clearStrokesBody)).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: strings.confirmCancel }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(JSON.stringify(await listSessionDrafts())).toContain("data:image");
      expect(screen.getByRole("status").textContent).toBe("");
    });

    it("al confirmar quita los trazos de la sesion y del documento suelto, conserva el resto, y lo anuncia", async () => {
      await seedStrokes();
      render(<StripSavedSignatures strings={strings} />);
      fireEvent.click(screen.getByRole("button", { name: privacy.clearStrokesButton }));
      const dialog = await screen.findByRole("dialog", { name: privacy.clearStrokesTitle });
      fireEvent.click(within(dialog).getByRole("button", { name: privacy.clearStrokesConfirm }));
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe(privacy.clearStrokesDone));
      const [session] = await listSessionDrafts();
      const [document] = await listDrafts();
      expect(JSON.stringify([session, document])).not.toContain("data:image");
      expect(session.documents).toHaveLength(2);
      expect(session.signers).toEqual([SIGNER]);
      expect(document.fileName).toBe("solo.pdf");
      expect(document.signers).toEqual([SIGNER]);
    });

    it("sin ninguna firma guardada lo dice (no afirma que quito algo)", async () => {
      render(<StripSavedSignatures strings={strings} />);
      fireEvent.click(screen.getByRole("button", { name: privacy.clearStrokesButton }));
      const dialog = await screen.findByRole("dialog", { name: privacy.clearStrokesTitle });
      fireEvent.click(within(dialog).getByRole("button", { name: privacy.clearStrokesConfirm }));
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe(privacy.clearStrokesNone));
    });

    it("si no se pudo, lo dice y NO dice «Listo»", async () => {
      vi.spyOn(indexedDB, "open").mockImplementation(() => {
        throw new DOMException("bloqueado (simulado)", "SecurityError");
      });
      render(<StripSavedSignatures strings={strings} />);
      fireEvent.click(screen.getByRole("button", { name: privacy.clearStrokesButton }));
      const dialog = await screen.findByRole("dialog", { name: privacy.clearStrokesTitle });
      fireEvent.click(within(dialog).getByRole("button", { name: privacy.clearStrokesConfirm }));
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe(privacy.clearStrokesFailed));
      expect(screen.queryByText(privacy.clearStrokesDone)).toBeNull();
    });

    it("sin claves crudas ni «undefined»", () => {
      render(<StripSavedSignatures strings={strings} />);
      expect(document.body.textContent).not.toMatch(/clearStrokes|draftPrivacy|undefined/);
    });
  });
}

describe("el aviso de privacidad de Firmar trae el boton", () => {
  const strings = SIGN_STRINGS.es;

  it("esta dentro del aviso abierto, junto al interruptor, con el interruptor encendido y apagado", () => {
    window.localStorage.removeItem("optimuspdf.sign-pdf.privacyNoticeSeen");
    const { container } = renderNotice(strings);
    fireEvent.click(screen.getByRole("button", { name: strings.privacyReadFull }));
    const card = container.querySelector(".surface-card")!;
    const button = screen.getByRole("button", { name: strings.draftPrivacy.clearStrokesButton });
    expect(card.contains(button)).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: strings.draftPrivacy.signaturesLabel }));
    expect(screen.getByRole("button", { name: strings.draftPrivacy.clearStrokesButton })).toBeTruthy();
  });

  it("con el interruptor apagado el texto dice que lo ya guardado conserva sus firmas hasta que caduquen o las quites", () => {
    window.localStorage.removeItem("optimuspdf.sign-pdf.privacyNoticeSeen");
    renderNotice(strings);
    fireEvent.click(screen.getByRole("button", { name: strings.privacyReadFull }));
    fireEvent.click(screen.getByRole("checkbox", { name: strings.draftPrivacy.signaturesLabel }));
    expect(document.body.textContent).toContain("Los borradores ya guardados conservan sus firmas hasta que caduquen o las quites");
  });

  it("con el aviso cerrado no hay boton (solo vive dentro del aviso)", () => {
    window.localStorage.setItem("optimuspdf.sign-pdf.privacyNoticeSeen", "1");
    renderNotice(strings);
    expect(screen.queryByRole("button", { name: strings.draftPrivacy.clearStrokesButton })).toBeNull();
  });
});
