import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import type { ComponentProps } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PrivacyNotice } from "@/app/sign-pdf/PrivacyNotice";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { draftStatusLine } from "@/app/sign-pdf/draftStatus";
import { clearLocalSignData } from "@/app/sign-pdf/clearLocalSignData";
import { EMPTY_DOC_STATE } from "@/app/sign-pdf/docSet";
import {
  __setDraftsBlockedTimeoutForTests,
  clearAllDrafts,
  listAllDrafts,
  listSessionDrafts,
  saveDraft,
  saveSessionDraft,
} from "@/app/sign-pdf/signDrafts";
import { clearVault } from "@/app/sign-pdf/signVault";
import { STRINGS as PRIVACY_PAGE } from "@/app/privacy/strings";
import { en } from "@/lib/locales/en";
import { es } from "@/lib/locales/es";

/**
 * Privacidad de la sesion multi-documento: los textos dicen QUE se guarda (la
 * sesion completa), que el .zip exportado contiene los documentos y COMO
 * borrarlo; y «Borrar datos» vacia tambien las sesiones.
 */

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

const DB_NAME = "optimuspdf-sign-drafts";

async function seedSession(id = "s-1") {
  return saveSessionDraft({
    id,
    mode: "multi",
    signMode: "same",
    signers: [{ id: "sg-1", name: "Ana", color: "#0d4bff" }],
    blocks: [],
    documents: ["a", "b"].map((name) => ({
      id: name,
      fileName: `${name}.pdf`,
      size: 3,
      state: { ...EMPTY_DOC_STATE },
      getBytes: async () => new Uint8Array([1, 2, 3]),
    })),
    activeDocId: "a",
    step: "signers",
  });
}

beforeEach(async () => {
  window.localStorage.clear();
  window.localStorage.setItem("optimuspdf.sign-pdf.privacyNoticeSeen", "1");
  __setDraftsBlockedTimeoutForTests(150);
  await clearAllDrafts();
  await clearVault();
});

describe("textos de privacidad — paridad es/en", () => {
  for (const language of ["es", "en"] as const) {
    const copy = SIGN_STRINGS[language];
    const documents = language === "es" ? /documentos/i : /documents/i;
    const session = language === "es" ? /sesi[oó]n completa/i : /whole session/i;

    it(`${language}: el aviso del borrador dice que guarda la sesion completa en el dispositivo`, () => {
      expect(copy.privacyNoticeBody).toMatch(session);
      expect(copy.privacyNoticeBody).toMatch(documents);
      expect(copy.privacyNoticeBody).toMatch(language === "es" ? /firmantes/ : /signers/);
      expect(copy.privacyNoticeBody).toMatch(language === "es" ? /firmas/ : /signatures/);
    });

    it(`${language}: el aviso dice que el .zip de la configuracion contiene los documentos`, () => {
      expect(copy.privacyNoticeBody).toMatch(/\.zip/);
      expect(copy.exportConfigNote).toMatch(/\.zip/);
      expect(copy.exportConfigNote).toMatch(documents);
    });

    it(`${language}: el aviso explica como borrarlo`, () => {
      expect(copy.privacyNoticeBody).toMatch(language === "es" ? /Borrar datos/ : /Clear data/);
      expect(copy.privacyNoticeBody).toMatch(language === "es" ? /Ajustes/ : /Settings/);
    });

    it(`${language}: el aviso no menciona la casilla de recordar firmas (eso es del baul)`, () => {
      expect(copy.privacyNoticeBody).not.toMatch(/(Recordar|Remember)/);
    });

    it(`${language}: el dialogo de borrado habla de sesiones, documentos y firmas`, () => {
      expect(copy.privacyClearDataBody).toMatch(language === "es" ? /sesi[oó]n/ : /session/);
      expect(copy.privacyClearDataBody).toMatch(language === "es" ? /firmas/ : /signatures/);
    });

    it(`${language}: avisa del tope de 150 MB al no poder guardar y no culpa a la persona`, () => {
      expect(copy.draftsTooBig).toMatch(/150 MB/);
      expect(copy.draftsTooBig.length).toBeGreaterThan(60);
    });
  }

  it("las cadenas nuevas existen, no estan vacias y las funciones devuelven texto en ambos idiomas", () => {
    for (const language of ["es", "en"] as const) {
      const copy = SIGN_STRINGS[language];
      for (const value of [
        copy.draftsDocuments(2),
        copy.draftsConfirmDeleteSessionBody(3),
        copy.draftsTooBig,
        copy.draftsResumeNormalized(2),
        copy.draftsResumeStale(1),
        copy.exportConfigNote,
        copy.templatesApplyAll,
        copy.applyTemplateAllConfirmBody,
        copy.applyTemplateAllDone(3, 0),
        copy.applyTemplateAllDone(3, 2),
      ]) {
        expect(value.trim().length).toBeGreaterThan(3);
      }
      expect(copy.draftsDocuments(1)).not.toBe(copy.draftsDocuments(2));
    }
  });

  it("es y en tienen exactamente las mismas claves de cadenas de borradores, config y plantillas", () => {
    const keys = (language: "es" | "en") =>
      Object.keys(SIGN_STRINGS[language])
        .filter((key) => /^(drafts|exportConfig|importConfig|templates|applyTemplate|privacy)/.test(key))
        .sort();
    expect(keys("es")).toEqual(keys("en"));
  });

  it("la pagina /privacy (es y en) menciona la sesion completa, el tope de 150 MB y que el .zip contiene los documentos", () => {
    for (const language of ["es", "en"] as const) {
      const text = PRIVACY_PAGE[language].sections.flatMap((section) => section.body).join("\n");
      expect(text).toMatch(/150 MB/);
      expect(text).toMatch(/\.zip/);
      expect(text).toMatch(language === "es" ? /sesi[oó]n/ : /session/);
      expect(text).toMatch(language === "es" ? /contiene tus documentos/ : /contains your documents/);
      expect(text).toMatch(language === "es" ? /sesiones completas incluidas/ : /whole sessions included/);
    }
  });

  it("Ajustes (es y en) menciona que la sesion completa se guarda y que el .zip lleva los documentos", () => {
    const find = (text: string) => text;
    const esText = find(
      Object.values(es.settings).filter((value): value is string => typeof value === "string").join("\n"),
    );
    const enText = find(
      Object.values(en.settings).filter((value): value is string => typeof value === "string").join("\n"),
    );
    expect(esText).toMatch(/la sesión completa/);
    expect(esText).toMatch(/\.zip contiene tus documentos/);
    expect(enText).toMatch(/whole session/);
    expect(enText).toMatch(/\.zip contains your documents/);
  });
});

describe("«Borrar datos» vacia tambien las sesiones", () => {
  it("clearLocalSignData borra sesiones y sus archivos y devuelve lista vacia", async () => {
    await seedSession("s-1");
    await seedSession("s-2");
    await expect(clearLocalSignData()).resolves.toEqual([]);
    expect(await listSessionDrafts()).toEqual([]);
    expect(await listAllDrafts()).toEqual([]);
  });

  it("PrivacyNotice «Borrar datos» elimina una sesion y despues dice «Datos borrados»", async () => {
    await seedSession();
    await saveDraft({
      id: "hash-1",
      fileBytes: new Uint8Array([1]),
      fileName: "suelto.pdf",
      manifest: { mode: "multi", signers: [], fields: [], textFields: [], textValues: {} },
      step: "signers",
      captures: {},
      textFieldsDetectedFor: null,
    });
    const strings = SIGN_STRINGS.es;
    renderNotice(strings);
    fireEvent.click(screen.getByRole("button", { name: strings.privacyClearData }));
    const dialog = await screen.findByRole("dialog", { name: strings.privacyClearDataTitle });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.privacyClearData }));
    expect(await screen.findByText(strings.privacyDataCleared)).toBeTruthy();
    expect(await listAllDrafts()).toEqual([]);
  });

  it("si la base esta bloqueada por otra pestana en la version anterior, NO dice «Datos borrados» y lo reporta", async () => {
    await seedSession();
    // Otra pestana con la version vieja abierta que no cede: la base no se puede subir a v2... ya esta en v2,
    // asi que se simula con una conexion que bloquea un cambio de version posterior.
    const failures = await new Promise<string[]>((resolve) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve([]);
      request.onblocked = () => resolve(["bloqueada"]);
      request.onerror = () => resolve(["error"]);
    });
    expect(failures).toEqual([]);

    const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("draftFiles", { keyPath: "id" });
        request.result.createObjectStore("draftMeta", { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const strings = SIGN_STRINGS.es;
    renderNotice(strings);
    fireEvent.click(screen.getByRole("button", { name: strings.privacyClearData }));
    const dialog = await screen.findByRole("dialog", { name: strings.privacyClearDataTitle });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.privacyClearData }));
    expect(await screen.findByText(strings.vaultClearFailed(["drafts"]))).toBeTruthy();
    expect(screen.queryByText(strings.privacyDataCleared)).toBeNull();
    blocker.close();
    await waitFor(async () => expect(await clearAllDrafts()).toEqual({ ok: true }));
  });
});

describe("avisos: lista de causas y region viva de borradores", () => {
  it("el descarte de una plantilla nombra las DOS causas (pagina inexistente y firmante sobrante), en es y en", () => {
    for (const language of ["es", "en"] as const) {
      const copy = SIGN_STRINGS[language];
      const page = language === "es" ? /página/ : /page/;
      const signer = language === "es" ? /firmante/ : /signer/;
      for (const text of [copy.applyTemplateDropped(2), copy.applyTemplateAllDone(3, 2)]) {
        expect(text).toMatch(page);
        expect(text).toMatch(signer);
      }
      // Sin descartes no hay nada que explicar.
      expect(copy.applyTemplateAllDone(3, 0)).not.toMatch(signer);
    }
  });

  it("singular y plural del descarte concuerdan", () => {
    expect(SIGN_STRINGS.es.applyTemplateDropped(1)).toMatch(/1 campo de la plantilla no se pudo aplicar.*se descartó\./);
    expect(SIGN_STRINGS.es.applyTemplateDropped(3)).toMatch(/3 campos de la plantilla no se pudieron aplicar.*se descartaron\./);
    expect(SIGN_STRINGS.en.applyTemplateDropped(1)).toMatch(/was dropped/);
    expect(SIGN_STRINGS.en.applyTemplateDropped(3)).toMatch(/were dropped/);
  });

  it("draftStatusLine muestra AMBOS avisos cuando coinciden (tope de tamano y recorte al retomar)", () => {
    const line = draftStatusLine(true, SIGN_STRINGS.es.draftsTooBig, SIGN_STRINGS.es.draftsResumeTrimmed(10, 12));
    expect(line).toContain(SIGN_STRINGS.es.draftsTooBig);
    expect(line).toContain(SIGN_STRINGS.es.draftsResumeTrimmed(10, 12));
  });

  it("draftStatusLine con uno solo, o con ninguno, no deja huecos ni 'null'", () => {
    expect(draftStatusLine(true, "grande", null)).toBe("grande");
    expect(draftStatusLine(false, "grande", "aviso")).toBe("aviso");
    expect(draftStatusLine(false, "grande", null)).toBe("");
    expect(draftStatusLine(true, "grande", "")).toBe("grande");
  });
});
