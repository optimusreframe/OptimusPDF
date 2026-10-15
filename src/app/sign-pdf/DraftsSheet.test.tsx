import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DraftsSheet, draftDocumentNames } from "@/app/sign-pdf/DraftsSheet";
import { EMPTY_DOC_STATE } from "@/app/sign-pdf/docSet";
import {
  clearAllDrafts,
  listAllDrafts,
  saveDraft,
  saveSessionDraft,
  type DraftEntry,
  type SaveSessionParams,
} from "@/app/sign-pdf/signDrafts";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { LanguageProvider, LANGUAGE_STORAGE_KEY } from "@/lib/i18n";

/**
 * La hoja de borradores lista documentos sueltos (v1) y SESIONES (una fila por
 * ronda, con «N documentos»), con objetivos de al menos 44 px.
 */

const strings = SIGN_STRINGS.es;

function session(id: string, names: string[]): SaveSessionParams {
  return {
    id,
    mode: "multi",
    signMode: "same",
    signers: [{ id: "sg-1", name: "Ana", color: "#0d4bff" }],
    blocks: [],
    documents: names.map((name, index) => ({
      id: `doc-${index + 1}`,
      fileName: name,
      size: 1024,
      state: { ...EMPTY_DOC_STATE },
      getBytes: async () => new Uint8Array([index]),
    })),
    activeDocId: "doc-1",
    step: "signers",
  };
}

async function saveV1(id: string, name: string) {
  await saveDraft({
    id,
    fileBytes: new Uint8Array([1, 2, 3]),
    fileName: name,
    manifest: { mode: "multi", signers: [], fields: [], textFields: [], textValues: {} },
    step: "signers",
    captures: {},
    textFieldsDetectedFor: null,
  });
}

/** Un clic de navegador real enfoca el boton antes de pulsarlo (jsdom no lo hace). */
function press(button: HTMLElement) {
  button.focus();
  fireEvent.click(button);
}

function renderSheet(onResume = vi.fn(), onClose = vi.fn()) {
  render(
    <LanguageProvider>
      <DraftsSheet open onClose={onClose} onResume={onResume} strings={strings} />
    </LanguageProvider>,
  );
  return { onResume, onClose };
}

beforeEach(async () => {
  window.localStorage.clear();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  await clearAllDrafts();
});

describe("DraftsSheet — sesiones y borradores v1", () => {
  it("sin borradores muestra el aviso de vacio", async () => {
    renderSheet();
    expect(await screen.findByText(strings.draftsEmpty)).toBeTruthy();
  });

  it("una sesion es UNA fila con «N documentos» y los nombres juntos", async () => {
    await saveSessionDraft(session("s-1", ["Contrato A.pdf", "Anexo B.pdf", "Acta C.pdf"]));
    renderSheet();
    expect(await screen.findByText(/3 documentos/)).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Contrato A.pdf, Anexo B.pdf, Acta C.pdf")).toBeTruthy();
  });

  it("«1 documento» en singular", async () => {
    expect(strings.draftsDocuments(1)).toBe("1 documento");
    expect(strings.draftsDocuments(2)).toBe("2 documentos");
    expect(SIGN_STRINGS.en.draftsDocuments(1)).toBe("1 document");
    expect(SIGN_STRINGS.en.draftsDocuments(4)).toBe("4 documents");
  });

  it("los nombres se truncan con CSS y el nombre COMPLETO queda en el tooltip", async () => {
    const long = "Contrato de arrendamiento con clausulas adicionales y anexos de garantia.pdf";
    await saveSessionDraft(session("s-2", [long, "Otro documento muy largo del mismo paquete de firma.pdf"]));
    renderSheet();
    const names = await screen.findByText(new RegExp(`^${long.slice(0, 20)}`));
    expect(names.className).toContain("truncate");
    expect(names.getAttribute("title")).toBe(
      `${long}, Otro documento muy largo del mismo paquete de firma.pdf`,
    );
  });

  it("mezcla sesiones y documentos sueltos, los mas recientes primero", async () => {
    await saveV1("hash-1", "suelto.pdf");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await saveSessionDraft(session("s-3", ["a.pdf", "b.pdf"]));
    renderSheet();
    await screen.findByText(/2 documentos/);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("a.pdf, b.pdf")).toBeTruthy();
    expect(within(rows[1]).getByText("suelto.pdf")).toBeTruthy();
    expect(within(rows[1]).queryByText(/documentos?\b/)).toBeNull();
  });

  it("Reanudar entrega la entrada completa (tipo + metadatos) a quien la retoma", async () => {
    await saveSessionDraft(session("s-4", ["a.pdf", "b.pdf"]));
    await saveV1("hash-2", "suelto.pdf");
    const { onResume } = renderSheet();
    await screen.findByText(/2 documentos/);
    const buttons = screen.getAllByRole("button", { name: strings.draftsResume });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) fireEvent.click(button);
    const calls = onResume.mock.calls.map(([entry]) => entry as DraftEntry);
    expect(calls.map((entry) => `${entry.kind}:${entry.meta.id}`).sort()).toEqual([
      "document:hash-2",
      "session:s-4",
    ]);
  });

  it("Reanudar y Borrar miden al menos 44 px de alto (size-11 / h-11)", async () => {
    await saveSessionDraft(session("s-5", ["a.pdf", "b.pdf"]));
    renderSheet();
    await screen.findByText(/2 documentos/);
    const resume = screen.getByRole("button", { name: strings.draftsResume });
    expect(resume.className).toContain("h-11");
    const del = screen.getByRole("button", { name: strings.draftsDelete("a.pdf, b.pdf") });
    expect(del.className).toContain("size-11");
  });

  it("el nombre accesible de Borrar nombra TODOS los documentos de la sesion", async () => {
    await saveSessionDraft(session("s-6", ["uno.pdf", "dos.pdf"]));
    renderSheet();
    expect(
      await screen.findByRole("button", { name: "Borrar el borrador de uno.pdf, dos.pdf" }),
    ).toBeTruthy();
  });

  it("Reanudar describe su fila por aria-describedby sin cambiar su nombre accesible", async () => {
    await saveSessionDraft(session("s-7", ["uno.pdf", "dos.pdf"]));
    renderSheet();
    const resume = await screen.findByRole("button", { name: strings.draftsResume });
    const describedBy = resume.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toContain("uno.pdf, dos.pdf");
  });

  it("borrar una sesion pide confirmacion con el numero de documentos y la elimina entera", async () => {
    await saveSessionDraft(session("s-8", ["a.pdf", "b.pdf", "c.pdf"]));
    renderSheet();
    fireEvent.click(await screen.findByRole("button", { name: strings.draftsDelete("a.pdf, b.pdf, c.pdf") }));
    expect(await screen.findByText(strings.draftsConfirmDeleteSessionBody(3))).toBeTruthy();
    const confirm = screen
      .getAllByRole("button", { name: strings.draftsDelete("a.pdf, b.pdf, c.pdf") })
      .at(-1)!;
    fireEvent.click(confirm);
    await waitFor(async () => expect(await listAllDrafts()).toEqual([]));
    expect(await screen.findByText(strings.draftsEmpty)).toBeTruthy();
  });

  it("cancelar el borrado no toca la sesion", async () => {
    await saveSessionDraft(session("s-9", ["a.pdf", "b.pdf"]));
    renderSheet();
    fireEvent.click(await screen.findByRole("button", { name: strings.draftsDelete("a.pdf, b.pdf") }));
    fireEvent.click(await screen.findByRole("button", { name: strings.confirmCancel }));
    expect(await listAllDrafts()).toHaveLength(1);
  });

  it("un documento suelto sigue usando el texto de confirmacion de siempre", async () => {
    await saveV1("hash-3", "suelto.pdf");
    renderSheet();
    fireEvent.click(await screen.findByRole("button", { name: strings.draftsDelete("suelto.pdf") }));
    expect(await screen.findByText(strings.draftsConfirmDeleteBody)).toBeTruthy();
  });

  it("tras borrar, el foco no cae a <body>: va al siguiente boton de la lista o al aviso de vacio", async () => {
    await saveSessionDraft(session("s-10", ["a.pdf", "b.pdf"]));
    renderSheet();
    press(await screen.findByRole("button", { name: strings.draftsDelete("a.pdf, b.pdf") }));
    const confirm = (await screen.findAllByRole("button", { name: strings.draftsDelete("a.pdf, b.pdf") })).at(-1)!;
    press(confirm);
    await screen.findByText(strings.draftsEmpty);
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement?.hasAttribute("data-drafts-empty")).toBe(true);
  });

  it("tras borrar uno de varios, el foco pasa al primer boton de la lista que queda", async () => {
    await saveSessionDraft(session("s-11", ["a.pdf", "b.pdf"]));
    await saveV1("hash-4", "suelto.pdf");
    renderSheet();
    press(await screen.findByRole("button", { name: strings.draftsDelete("a.pdf, b.pdf") }));
    const confirm = (await screen.findAllByRole("button", { name: strings.draftsDelete("a.pdf, b.pdf") })).at(-1)!;
    press(confirm);
    // La fila de la sesion desaparece de la LISTA al refrescarse (el texto
    // «2 documentos» tambien esta en el cuerpo de la confirmacion, que sigue
    // saliendo con su animacion: no sirve de senal).
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active).not.toBe(document.body);
      expect(active?.closest("li")?.textContent).toContain("suelto.pdf");
    });
  });

  it("se refresca solo cuando otra pestana guarda una sesion", async () => {
    renderSheet();
    await screen.findByText(strings.draftsEmpty);
    await saveSessionDraft(session("s-12", ["nueva.pdf", "otra.pdf"]));
    expect(await screen.findByText(/2 documentos/)).toBeTruthy();
  });
});

describe("draftDocumentNames", () => {
  it("v1: el nombre del archivo; sesion: los de todos los documentos en orden", async () => {
    await saveV1("hash-5", "suelto.pdf");
    await saveSessionDraft(session("s-13", ["x.pdf", "y.pdf"]));
    const entries = await listAllDrafts();
    const byKind = Object.fromEntries(entries.map((entry) => [entry.kind, draftDocumentNames(entry)]));
    expect(byKind.document).toEqual(["suelto.pdf"]);
    expect(byKind.session).toEqual(["x.pdf", "y.pdf"]);
  });
});

describe("DraftsSheet · distinguir borradores del mismo PDF (F0-fix, D1 y D3)", () => {
  async function saveWithSigners(id: string, signers: string[], extra: Record<string, unknown> = {}) {
    await saveDraft({
      id,
      fingerprint: "a".repeat(64),
      fileBytes: new Uint8Array([1, 2, 3]),
      fileName: "Plantilla.pdf",
      manifest: {
        mode: "multi",
        signers: signers.map((name, index) => ({ id: `sg-${index + 1}`, name, color: "#0d4bff" })),
        fields: [],
        textFields: [],
        textValues: {},
      },
      step: "signers",
      captures: {},
      textFieldsDetectedFor: null,
      ...extra,
    });
  }

  it("dos borradores del mismo PDF salen como dos filas, cada una con la fecha y los firmantes que la distinguen", async () => {
    await saveWithSigners("1".repeat(64), ["Ana", "Luis"]);
    await saveWithSigners("2".repeat(64), ["Maria", "Pedro"]);
    renderSheet();
    await screen.findAllByText(/Guardado el /);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const text = rows.map((row) => row.textContent ?? "").join("|");
    expect(text).toContain("Firmantes: Ana, Luis");
    expect(text).toContain("Firmantes: Maria, Pedro");
    for (const row of rows) expect(within(row).getByText(/Guardado el /)).toBeTruthy();
  });

  it("un firmante sin nombre sale como «Firmante N»", async () => {
    await saveWithSigners("3".repeat(64), ["", "Luis"]);
    renderSheet();
    expect(await screen.findByText("Firmantes: Firmante 1, Luis")).toBeTruthy();
  });

  it("la copia que una pestana guardo aparte lleva la etiqueta «Copia aparte»; el original, no", async () => {
    await saveWithSigners("4".repeat(64), ["Ana"]);
    await saveSessionDraft(session("s-copia-1", ["a.pdf", "b.pdf"]));
    // Marca una sesion como copia a mano (lo hace `saveSessionDraft` al detectar la version nueva de otra pestana).
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("optimuspdf-sign-drafts");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("sessionMeta", "readwrite");
      const store = tx.objectStore("sessionMeta");
      const get = store.get("s-copia-1");
      get.onsuccess = () => store.put({ ...get.result, copyOf: "s-original" });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    renderSheet();
    await screen.findAllByText(/Guardado el /);
    const tags = screen.getAllByText("Copia aparte");
    expect(tags).toHaveLength(1);
    expect(tags[0].closest("li")?.textContent).toContain("a.pdf, b.pdf");
  });
});
