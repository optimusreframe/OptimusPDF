import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ExportBackupSheet } from "@/app/documents/ExportBackupSheet";
import { ImportBackupSheet } from "@/app/documents/ImportBackupSheet";
import { LAST_BACKUP_KEY } from "@/lib/backup/lastBackup";
import { buildPackage, readPackage } from "@/lib/backup/package";
import { hostileCorpus } from "@/lib/backup/__fixtures__/hostileCorpus";
import { asFile } from "@/lib/backup/__fixtures__/testKit";
import { exportBlob, freshLibrary, seedDoc, seedTemplate, singleSignerDraft } from "@/lib/backup/__fixtures__/libraryKit";
import { clearLibrary, getDocument, listDocuments, replaceDocumentBytes } from "@/lib/docLibrary/store";
import { listTemplates } from "@/lib/docLibrary/templatesStore";
import { sampleFingerprint } from "@/lib/docLibrary/testing/sampleDocs";
import { sha256Hex } from "@/lib/crypto/sha256";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { downloadBlob } from "@/lib/pdf/core";
import { browserInputGuard } from "@/lib/pdf/inputGuard";
import { es } from "@/lib/locales/es";
import { en } from "@/lib/locales/en";
import { fakePdf } from "@/lib/backup/__fixtures__/libraryKit";

/**
 * Hojas «Exportar plantillas y documentos» e «Importar» de Mis documentos (U4.5 + U4.2), jsdom + fake-indexeddb sobre el
 * almacén REAL. Solo se simulan la descarga del navegador y la puerta de entrada de los PDF (pdf.js no corre en jsdom).
 */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, downloadBlob: vi.fn() };
});
vi.mock("@/lib/pdf/inputGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/inputGuard")>();
  return { ...actual, browserInputGuard: vi.fn(async () => ({ status: "ok" })) };
});

const copy = es.documents.backup;
const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (m, k: string) => String(values[k] ?? m));

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  freshLibrary();
  vi.mocked(downloadBlob).mockClear();
  vi.mocked(browserInputGuard).mockClear();
  vi.mocked(browserInputGuard).mockImplementation(async () => ({ status: "ok" }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function seedLibrary() {
  await seedDoc("doc-a", 1, { name: "Contrato A", pages: 4 });
  await seedDoc("doc-b", 2, { name: "Contrato B", pages: 3 });
  await seedTemplate("doc-a", {}, "tpl-a");
}

const statusText = () => within(screen.getByRole("dialog")).getByRole("status").textContent ?? "";

/* ------------------------------------------------------------------ *
 * Exportar
 * ------------------------------------------------------------------ */

function renderExport() {
  const onClose = vi.fn();
  const onDone = vi.fn();
  render(
    <LanguageProvider>
      <ExportBackupSheet open onClose={onClose} onDone={onDone} />
    </LanguageProvider>,
  );
  return { onClose, onDone };
}

const typePassword = (value: string, repeat = value) => {
  fireEvent.change(screen.getByLabelText(copy.password), { target: { value } });
  fireEvent.change(screen.getByLabelText(copy.confirmPassword), { target: { value: repeat } });
};

describe("Exportar plantillas y documentos", () => {
  it("biblioteca vacía: lo dice y «Crear respaldo» queda deshabilitado", async () => {
    renderExport();
    expect(await screen.findByText(copy.exportEmpty)).toBeTruthy();
    expect((screen.getByRole("button", { name: copy.exportConfirm }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("resumen previo «N documentos, M plantillas, X», contraseña marcada por defecto y medidor", async () => {
    await seedLibrary();
    renderExport();
    const summary = await screen.findByText(/Se exportará:/);
    expect(summary.textContent).toMatch(/^Se exportará: 2 documentos, 1 plantilla, \d+(,\d)? (B|KB)\.$/);
    const protect = (await screen.findByRole("checkbox", { name: copy.protect })) as HTMLInputElement;
    expect(protect.checked).toBe(true);
    const meter = screen.getByRole("meter", { name: copy.strengthLabel });
    expect(meter.getAttribute("aria-valuenow")).toBe("0");
    fireEvent.change(screen.getByLabelText(copy.password), { target: { value: "correcto-caballo" } });
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("3");
    expect(copy.exportNever).toMatch(/nunca firmas, borradores ni datos de clientes/);
    expect(screen.getByText(copy.exportNever)).toBeTruthy();
  });

  it("contraseña corta o que no coincide: error claro y no se exporta nada", async () => {
    await seedLibrary();
    renderExport();
    await screen.findByText(/Se exportará:/);
    typePassword("corta");
    fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
    await waitFor(() => expect(statusText()).toBe(copy.passwordTooShort));
    typePassword("una-clave-larga", "otra-clave-larga");
    fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
    await waitFor(() => expect(statusText()).toBe(copy.passwordMismatch));
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LAST_BACKUP_KEY)).toBeNull();
  });

  it("con contraseña: descarga OptimusPDF-documentos.optimuspdf.zip cifrado, anota «Último respaldo» y confirma", async () => {
    await seedLibrary();
    const { onDone } = renderExport();
    await screen.findByText(/Se exportará:/);
    typePassword("una-clave-larga");
    fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    const [blob, filename] = vi.mocked(downloadBlob).mock.calls[0] as [Blob, string];
    expect(filename).toBe("OptimusPDF-documentos.optimuspdf.zip");
    await expect(readPackage(blob)).rejects.toMatchObject({ code: "needsPassword" });
    const read = await readPackage(blob, "una-clave-larga");
    expect(read.modules.map((m) => [m.name, m.meta])).toEqual([["library", { documents: 2, templates: 1 }]]);
    const done = fill(copy.doneEncrypted, { docs: "2 documentos", templates: "1 plantilla" });
    expect((await screen.findByText(new RegExp(done.replace(/[().]/g, "\\$&")), { selector: "p.text-subheadline" })).textContent).toContain(
      fill(copy.doneFile, { name: "OptimusPDF-documentos.optimuspdf.zip" }),
    );
    expect(onDone).toHaveBeenCalledWith(fill(copy.announceExported, { docs: "2 documentos", templates: "1 plantilla" }));
    expect(Date.parse(window.localStorage.getItem(LAST_BACKUP_KEY) ?? "")).toBeGreaterThan(Date.now() - 60_000);
  });

  it("sin contraseña: avisa de que queda sin cifrar y el archivo se lee sin ella", async () => {
    await seedLibrary();
    renderExport();
    await screen.findByText(/Se exportará:/);
    fireEvent.click(await screen.findByRole("checkbox", { name: copy.protect }));
    expect(screen.getByText(copy.plainWarning)).toBeTruthy();
    expect(screen.queryByLabelText(copy.password)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    const read = await readPackage(vi.mocked(downloadBlob).mock.calls[0][0] as Blob);
    expect(read.encrypted).toBe(false);
    expect((await screen.findAllByText(/sin cifrar/)).length).toBeGreaterThan(0);
  });

  it("sin WebCrypto (http): la casilla queda desmarcada y deshabilitada con su explicación", async () => {
    await seedLibrary();
    vi.stubGlobal("crypto", { ...globalThis.crypto, subtle: undefined, getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    renderExport();
    const protect = (await screen.findByRole("checkbox", { name: copy.protect })) as HTMLInputElement;
    expect(protect.checked).toBe(false);
    expect(protect.disabled).toBe(true);
    expect(screen.getByText(copy.encryptionUnavailable)).toBeTruthy();
  });

  it("una sola región de estado", async () => {
    await seedLibrary();
    renderExport();
    await screen.findByText(/Se exportará:/);
    expect(within(screen.getByRole("dialog")).getAllByRole("status")).toHaveLength(1);
  });

  describe("iPad: hoja de compartir del sistema", () => {
    function stubTouchShare(share: ReturnType<typeof vi.fn>) {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query.includes("pointer: coarse"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
      vi.stubGlobal("navigator", { ...navigator, share, canShare: () => true });
    }

    async function toReady() {
      await seedLibrary();
      const view = renderExport();
      await screen.findByText(/Se exportará:/);
      fireEvent.click(await screen.findByRole("checkbox", { name: copy.protect }));
      fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
      await screen.findByRole("button", { name: copy.shareButton });
      return view;
    }

    it("primero «archivo listo» y comparte en un segundo toque; cerrar la hoja sin elegir NO cuenta como exportado", async () => {
      const share = vi.fn().mockRejectedValueOnce(new DOMException("cancel", "AbortError")).mockResolvedValue(undefined);
      stubTouchShare(share);
      await toReady();
      expect(downloadBlob).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: copy.shareButton }));
      await waitFor(() => expect(statusText()).toBe(copy.shareCancelled));
      expect(window.localStorage.getItem(LAST_BACKUP_KEY)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: copy.shareButton }));
      await waitFor(() => expect(share).toHaveBeenCalledTimes(2));
      const data = share.mock.calls[1][0] as { files: File[] };
      expect(data.files[0].name).toBe("OptimusPDF-documentos.optimuspdf.zip");
      await screen.findByRole("button", { name: copy.doneClose });
      expect(window.localStorage.getItem(LAST_BACKUP_KEY)).not.toBeNull();
    });

    it("si compartir falla de verdad cae a la descarga", async () => {
      stubTouchShare(vi.fn().mockRejectedValue(new DOMException("no", "NotAllowedError")));
      await toReady();
      fireEvent.click(screen.getByRole("button", { name: copy.shareButton }));
      await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    });

    it("«Descargar» también está disponible", async () => {
      stubTouchShare(vi.fn());
      await toReady();
      fireEvent.click(screen.getByRole("button", { name: copy.downloadButton }));
      expect(downloadBlob).toHaveBeenCalledTimes(1);
    });

    it("en escritorio (sin puntero táctil) descarga directamente aunque exista share", async () => {
      vi.stubGlobal("navigator", { ...navigator, share: vi.fn(), canShare: () => true });
      await seedLibrary();
      renderExport();
      await screen.findByText(/Se exportará:/);
      fireEvent.click(await screen.findByRole("checkbox", { name: copy.protect }));
      fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
      await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    });
  });
});

/* ------------------------------------------------------------------ *
 * Importar
 * ------------------------------------------------------------------ */

function renderImport() {
  const onClose = vi.fn();
  const onDone = vi.fn();
  render(
    <LanguageProvider>
      <ImportBackupSheet open onClose={onClose} onDone={onDone} />
    </LanguageProvider>,
  );
  return { onClose, onDone };
}

const zipInput = () => document.querySelector("[data-backup-file-input]") as HTMLInputElement;
async function pickZip(file: File) {
  await screen.findByRole("button", { name: copy.pickZip });
  fireEvent.change(zipInput(), { target: { files: [file] } });
}
const itemOf = (key: string) => document.querySelector(`[data-backup-item="${key}"]`) as HTMLElement;
const confirmButton = () => document.querySelector("[data-backup-confirm]") as HTMLButtonElement;

/** Un paquete de la biblioteca actual y la biblioteca vaciada: «archivo en mano, biblioteca nueva». */
async function packageThenClear(password?: string) {
  const blob = await exportBlob(password);
  await clearLibrary();
  return asFile(blob, "OptimusPDF-documentos.optimuspdf.zip");
}

describe("Importar", () => {
  it("elegir el .zip muestra la vista previa con cada elemento «Nuevo»; al confirmar: recuento y biblioteca restaurada", async () => {
    await seedLibrary();
    const file = await packageThenClear();
    const { onDone } = renderImport();
    await pickZip(file);
    await screen.findByRole("button", { name: copy.importConfirmMany.replace("{n}", "2") });
    expect(screen.getByText("El archivo trae 2 documentos, 1 plantilla.")).toBeTruthy();
    expect(itemOf("doc-a").getAttribute("data-status")).toBe("new");
    expect(within(itemOf("doc-a")).getByText(copy.statusNew)).toBeTruthy();
    expect(within(itemOf("doc-a")).getByText(/4 páginas/)).toBeTruthy();
    expect(within(itemOf("doc-a")).getByText(fill(copy.templateLine, { name: "Contrato de servicio", state: copy.templateNew }))).toBeTruthy();
    expect(within(itemOf("doc-b")).getByText(copy.templatesNone, { exact: false })).toBeTruthy();
    expect(document.querySelector("[data-backup-limits]")?.textContent).toBe(
      fill(copy.limitOk, { docs: 2, maxDocs: 50, templates: 1, maxTemplates: 200 }),
    );
    // La decisión sugerida está marcada.
    expect(within(itemOf("doc-a")).getByRole("radio", { name: copy.decisionImport }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(confirmButton());
    await waitFor(() => expect(document.querySelector("[data-backup-result]")).toBeTruthy());
    expect(document.querySelector("[data-backup-result]")?.textContent).toContain("Importación terminada: 2 documentos, 1 plantilla.");
    expect((await listDocuments()).documents.map((d) => d.id).sort()).toEqual(["doc-a", "doc-b"]);
    expect((await listTemplates()).templates.map((t) => t.id)).toEqual(["tpl-a"]);
    expect(onDone).toHaveBeenCalledWith(fill(copy.announceImported, { docs: "2 documentos", templates: "1 plantilla" }));
  });

  it("archivo cifrado: pide la contraseña, la incorrecta lo dice y deja reintentar, la correcta abre la vista previa", async () => {
    await seedLibrary();
    const file = await packageThenClear("dorada-2026");
    renderImport();
    await pickZip(file);
    const field = await screen.findByLabelText(copy.passwordLabel);
    fireEvent.change(field, { target: { value: "mala" } });
    fireEvent.click(screen.getByRole("button", { name: copy.passwordOpen }));
    await waitFor(() => expect(statusText()).toBe(copy.wrongPassword));
    fireEvent.change(await screen.findByLabelText(copy.passwordLabel), { target: { value: "dorada-2026" } });
    fireEvent.click(screen.getByRole("button", { name: copy.passwordOpen }));
    await screen.findByText(/El archivo trae 2 documentos, 1 plantilla \(estaba cifrado\)\./);
    expect((await listDocuments()).documents).toHaveLength(0);
  });

  it("importar sobre lo existente: «Ya lo tienes», sin duplicar y con el botón deshabilitado", async () => {
    await seedLibrary();
    const blob = await exportBlob();
    renderImport();
    await pickZip(asFile(blob));
    await waitFor(() => expect(itemOf("doc-a")).toBeTruthy());
    for (const key of ["doc-a", "doc-b"]) {
      expect(itemOf(key).getAttribute("data-status")).toBe("identical");
      expect(within(itemOf(key)).getByText(copy.statusIdentical)).toBeTruthy();
      expect(within(itemOf(key)).queryAllByRole("radio")).toHaveLength(0);
    }
    expect(confirmButton().textContent).toBe(copy.importNothing);
    expect(confirmButton().disabled).toBe(true);
    expect((await listDocuments()).documents).toHaveLength(2);
  });

  it("«Distinto»: ofrece Reemplazar / Conservar ambos / Omitir; lo sugerido no pierde nada; Omitir no escribe", async () => {
    await seedDoc("doc-a", 1, { name: "Original" });
    const blob = await exportBlob();
    const other = fakePdf(99);
    await replaceDocumentBytes("doc-a", other, { fingerprinter: async (bytes) => ({ ...sampleFingerprint(3, 99), exact: await sha256Hex(bytes) }) });
    renderImport();
    await pickZip(asFile(blob));
    await waitFor(() => expect(itemOf("doc-a")).toBeTruthy());
    const card = itemOf("doc-a");
    expect(card.getAttribute("data-status")).toBe("different");
    expect(within(card).getAllByRole("radio").map((r) => r.textContent)).toEqual([copy.decisionReplace, copy.decisionKeepBoth, copy.decisionOmit]);
    expect(within(card).getByRole("radio", { name: copy.decisionKeepBoth }).getAttribute("aria-checked")).toBe("true");
    expect(card.querySelector("[data-backup-hint]")?.textContent).toContain("Ya tienes «Original»");
    expect(within(card).getByRole("radiogroup", { name: fill(copy.decisionGroup, { name: "Original" }) })).toBeTruthy();
    fireEvent.click(within(card).getByRole("radio", { name: copy.decisionOmit }));
    expect(confirmButton().textContent).toBe(copy.importNothing);
    fireEvent.click(within(card).getByRole("radio", { name: copy.decisionKeepBoth }));
    expect(confirmButton().textContent).toBe(copy.importConfirmOne);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(document.querySelector("[data-backup-result]")).toBeTruthy());
    expect((await listDocuments()).documents).toHaveLength(2);
    expect(document.querySelector("[data-backup-result]")?.textContent).toContain(fill(copy.resultReassigned, { n: 1 }));
  });

  it("Reemplazar actualiza el PDF del documento que ya tenías", async () => {
    await seedDoc("doc-a", 1, { name: "Del archivo" });
    const blob = await exportBlob();
    const other = fakePdf(99);
    await replaceDocumentBytes("doc-a", other, { fingerprinter: async (bytes) => ({ ...sampleFingerprint(3, 99), exact: await sha256Hex(bytes) }) });
    renderImport();
    await pickZip(asFile(blob));
    await waitFor(() => expect(itemOf("doc-a")).toBeTruthy());
    fireEvent.click(within(itemOf("doc-a")).getByRole("radio", { name: copy.decisionReplace }));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(document.querySelector("[data-backup-result]")).toBeTruthy());
    expect(document.querySelector("[data-backup-result]")?.textContent).toContain(fill(copy.resultReplaced, { n: 1 }));
    expect((await getDocument("doc-a"))?.name).toBe("Del archivo");
  });

  it("mismo PDF con plantillas nuevas: se ofrece «Añadir plantillas» (no Reemplazar)", async () => {
    await seedDoc("doc-a", 1);
    await seedTemplate("doc-a", {}, "tpl-a");
    await seedTemplate("doc-a", singleSignerDraft, "tpl-b");
    const blob = await exportBlob();
    const { deleteTemplate } = await import("@/lib/docLibrary/templatesStore");
    await deleteTemplate("tpl-b");
    renderImport();
    await pickZip(asFile(blob));
    await waitFor(() => expect(itemOf("doc-a")).toBeTruthy());
    const card = itemOf("doc-a");
    expect(within(card).getAllByRole("radio").map((r) => r.textContent)).toEqual([copy.decisionAdd, copy.decisionOmit]);
    expect(card.querySelector("[data-backup-hint]")?.textContent).toBe(copy.hintTemplatesNew);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(document.querySelector("[data-backup-result]")).toBeTruthy());
    expect((await listTemplates()).templates).toHaveLength(2);
  });

  it("límites comprobados ANTES: «Solo caben 2 de los 5…» y el botón queda bloqueado", async () => {
    for (let i = 0; i < 5; i += 1) await seedDoc(`n${i}`, 100 + i, { size: 80 });
    const blob = await exportBlob();
    await clearLibrary();
    for (let i = 0; i < 48; i += 1) await seedDoc(`e${i}`, 500 + i, { size: 80 });
    renderImport();
    await pickZip(asFile(blob));
    await waitFor(() => expect(document.querySelector("[data-backup-limits]")).toBeTruthy());
    expect(document.querySelector("[data-backup-limits]")?.textContent).toBe(
      fill(copy.limitExceeded, { fits: 2, wanted: 5, reason: fill(copy.limitReasons.documents, { max: 50 }) }),
    );
    expect(confirmButton().disabled).toBe(true);
    // Omitiendo tres, caben y se habilita.
    for (const key of ["n2", "n3", "n4"]) fireEvent.click(within(itemOf(key)).getByRole("radio", { name: copy.decisionOmit }));
    expect(confirmButton().disabled).toBe(false);
    expect(document.querySelector("[data-backup-limits]")?.textContent).toContain("50 de 50 documentos");
  });

  it("un PDF que la puerta de entrada rechaza es «No se puede importar» con su motivo y no se escribe", async () => {
    await seedLibrary();
    const file = await packageThenClear();
    vi.mocked(browserInputGuard).mockImplementation(async () => ({ status: "problem", code: "corrupt" }));
    renderImport();
    await pickZip(file);
    await waitFor(() => expect(itemOf("doc-a")).toBeTruthy());
    expect(itemOf("doc-a").getAttribute("data-status")).toBe("invalid");
    expect(within(itemOf("doc-a")).getByText(copy.invalidReasons.invalidPdf)).toBeTruthy();
    expect(within(itemOf("doc-a")).queryAllByRole("radio")).toHaveLength(0);
    expect(confirmButton().disabled).toBe(true);
    expect((await listDocuments()).documents).toHaveLength(0);
  });

  it("un PDF con solo restricciones de permisos (sin contraseña de apertura) se admite", async () => {
    await seedLibrary();
    const file = await packageThenClear();
    vi.mocked(browserInputGuard).mockImplementation(async () => ({ status: "encrypted", needsPassword: false }));
    renderImport();
    await pickZip(file);
    await waitFor(() => expect(itemOf("doc-a")).toBeTruthy());
    expect(itemOf("doc-a").getAttribute("data-status")).toBe("new");
  });

  it("zips hostiles: error claro, vuelve a elegir archivo y no se escribe nada", async () => {
    renderImport();
    for (const hostile of hostileCorpus()) {
      await pickZip(asFile(new Blob([hostile.bytes as unknown as BlobPart]), "hostil.optimuspdf.zip"));
      await waitFor(() => expect(statusText()).not.toBe(""), { timeout: 8000 });
      expect(Object.values(copy.readErrors)).toContain(statusText());
      expect(screen.getByRole("button", { name: copy.pickZip })).toBeTruthy();
    }
    expect((await listDocuments()).documents).toHaveLength(0);
  });

  it("un respaldo de otra cosa (sin biblioteca) o de versión más nueva se dice con claridad", async () => {
    await seedLibrary();
    const noLibrary = await buildPackage({ modules: [{ name: "signatures", schemaVersion: 1, files: [{ path: "signatures/index.json", data: new Uint8Array(new TextEncoder().encode("[]")), type: "application/json" }] }] });
    renderImport();
    await pickZip(asFile(noLibrary));
    await waitFor(() => expect(statusText()).toBe(copy.readErrors.noLibrary));
    const { editManifest } = await import("@/lib/backup/__fixtures__/testKit");
    const newer = await editManifest(await exportBlob(), (manifest) => {
      manifest.modules.library.schemaVersion = 9;
    });
    await pickZip(asFile(newer));
    await waitFor(() => expect(statusText()).toBe(copy.readErrors.newer));
    await waitFor(() => expect(statusText()).toContain("versión más nueva"));
  });

  it("si la biblioteca cambió mientras se revisaba: no escribe, avisa y enseña la vista previa nueva", async () => {
    await seedDoc("doc-a", 1);
    const file = await packageThenClear();
    renderImport();
    await pickZip(file);
    await waitFor(() => expect(itemOf("doc-a")).toBeTruthy());
    expect(itemOf("doc-a").getAttribute("data-status")).toBe("new");
    // Otra pestaña guarda el MISMO PDF antes de confirmar.
    await seedDoc("copia", 1);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(statusText()).toBe(copy.applyFailed.changed));
    await waitFor(() => expect(itemOf("doc-a")?.getAttribute("data-status")).toBe("identical"));
    expect((await listDocuments()).documents.map((d) => d.id)).toEqual(["copia"]);
  });

  it("una sola región de estado y sin ningún elemento con dangerouslySetInnerHTML (nombres con HTML se ven como texto)", async () => {
    await seedDoc("doc-a", 1, { name: "<img src=x onerror=alert(1)> Contrato" });
    const file = await packageThenClear();
    renderImport();
    await pickZip(file);
    await waitFor(() => expect(itemOf("doc-a")).toBeTruthy());
    expect(within(screen.getByRole("dialog")).getAllByRole("status")).toHaveLength(1);
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect(itemOf("doc-a").textContent).toContain("<img src=x onerror=alert(1)> Contrato");
  });

  it("el progreso dice «Revisando PDF 1 de 2…» mientras la puerta revisa", async () => {
    await seedLibrary();
    const file = await packageThenClear();
    let release: (() => void) | undefined;
    let first = true;
    vi.mocked(browserInputGuard).mockImplementation(async () => {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { status: "ok" };
    });
    renderImport();
    await pickZip(file);
    await waitFor(() => expect(release).toBeDefined());
    expect(statusText()).toBe(copy.reading);
    release?.();
    await waitFor(() => expect(itemOf("doc-a")).toBeTruthy());
  });
});

describe("textos ES/EN", () => {
  const paths = (value: unknown, prefix = ""): string[] =>
    typeof value === "string" ? [prefix] : Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => paths(child, prefix ? `${prefix}.${key}` : key));
  const read = (root: unknown, path: string): string =>
    path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], root) as string;

  it("el bloque documents.backup tiene las mismas claves y los mismos marcadores en español e inglés, y ninguna vacía", () => {
    const esPaths = paths(es.documents.backup).sort();
    expect(paths(en.documents.backup).sort()).toEqual(esPaths);
    for (const path of esPaths) {
      const markers = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
      expect(markers(read(en.documents.backup, path)), path).toEqual(markers(read(es.documents.backup, path)));
      expect(read(en.documents.backup, path).trim().length, path).toBeGreaterThan(0);
      expect(read(es.documents.backup, path).trim().length, path).toBeGreaterThan(0);
    }
  });

  it("los motivos de rechazo cubren todos los códigos de la librería", () => {
    expect(Object.keys(es.documents.backup.invalidReasons).sort()).toEqual(
      ["documentInvalid", "duplicateId", "fingerprint", "integrity", "invalidEntry", "invalidPdf", "noDocument", "noPdf", "tooLarge"].sort(),
    );
  });
});
