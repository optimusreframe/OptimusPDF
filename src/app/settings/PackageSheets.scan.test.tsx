import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ExportPackageSheet } from "@/app/settings/ExportPackageSheet";
import { ImportPackageSheet } from "@/app/settings/ImportPackageSheet";
import { clearVault } from "@/app/sign-pdf/signVault";
import { __resetSignPdfFeatureFlagsCacheForTests } from "@/app/sign-pdf/signFeatureFlags";
import { LAST_BACKUP_PARTS_KEY } from "@/lib/backup/lastBackup";
import { readPackage } from "@/lib/backup/package";
import { exportEverything } from "@/lib/backup/globalPackage";
import { __resetScanSessionsSizeMemoForTests, __setScanSessionsPackageBudgetForTests, summarizeScanSessions } from "@/lib/backup/modules/scanSessions";
import { clearAllLocalDrafts } from "@/lib/backup/__fixtures__/draftsKit";
import { bytesBlob, resetScanStore, scanPage, scanSession, seedScanSession, seedSimpleSession } from "@/lib/backup/__fixtures__/scanKit";
import { asFile } from "@/lib/backup/__fixtures__/testKit";
import { __resetLibraryForTests, clearLibrary } from "@/lib/docLibrary/store";
import { useEffect } from "react";
import { LanguageProvider, useI18n } from "@/lib/i18n";
import { downloadBlob } from "@/lib/pdf/core";
import { listScanSessionSummaries, scanSessionStore } from "@/lib/scan/sessionStore";
import { en } from "@/lib/locales/en";
import { es } from "@/lib/locales/es";

/**
 * «Exportar mi paquete» e «Importar paquete» con los ESCANEOS EN CURSO (jsdom + fake-indexeddb sobre el almacen REAL del
 * Escaner): la casilla con su recuento y peso, la lista para elegir sesiones, los avisos de lo grande y lo que no cabe, la vista
 * previa con sus decisiones y el resultado. El E2E repite lo esencial en Chromium con la interfaz de verdad.
 */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, downloadBlob: vi.fn() };
});
vi.mock("@/lib/pdf/inputGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/inputGuard")>();
  return { ...actual, browserInputGuard: vi.fn(async () => ({ status: "ok" })) };
});
vi.mock("@/lib/image/pngImportGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/image/pngImportGuard")>();
  return { ...actual, validatePngForImport: vi.fn(async () => ({ ok: true })) };
});
vi.mock("@/app/settings/pageReload", () => ({ reloadPage: vi.fn() }));

const copy = es.settings.backup;
const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (m, k: string) => String(values[k] ?? m));

beforeEach(async () => {
  window.localStorage.clear();
  __resetSignPdfFeatureFlagsCacheForTests();
  __resetLibraryForTests();
  await clearLibrary();
  await clearVault();
  await clearAllLocalDrafts();
  await resetScanStore();
  __setScanSessionsPackageBudgetForTests(undefined);
  window.localStorage.clear();
  // Español sin guardar nada (si no, «Ajustes» entraria en los resumenes): el idioma sale del navegador.
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["es-ES"]);
  vi.mocked(downloadBlob).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __setScanSessionsPackageBudgetForTests(undefined);
  cleanup();
});

const statusText = () => within(screen.getByRole("dialog")).getByRole("status").textContent ?? "";
const box = (name: string | RegExp) => screen.findByRole("checkbox", { name }) as Promise<HTMLInputElement>;
const summary = () => document.querySelector("[data-backup-summary]")?.textContent ?? "";
const waitSummary = (pattern: RegExp) => waitFor(() => expect(summary()).toMatch(pattern));
const scanList = () => document.querySelector("[data-backup-scan-list]") as HTMLElement | null;

/* ------------------------------------------------------------------ *
 * Exportar
 * ------------------------------------------------------------------ */

function renderExport() {
  const onDone = vi.fn();
  render(
    <LanguageProvider>
      <ExportPackageSheet open onClose={vi.fn()} onDone={onDone} />
    </LanguageProvider>,
  );
  return { onDone };
}

async function scanIndexOf(blob: Blob, password?: string): Promise<{ sessions: Array<{ id: string; name: string; pages: unknown[] }> }> {
  const read = await readPackage(blob, password);
  const scanModule = read.modules.find((m) => m.name === "scan-sessions");
  const index = scanModule?.files.get("scan-sessions/index.json")?.bytes;
  if (!index) throw new Error("sin indice de escaneos");
  return JSON.parse(new TextDecoder().decode(index));
}

describe("Exportar mi paquete · escaneos en curso", () => {
  it("la casilla lleva su recuento y peso; con pocos escaneos viene marcada, con su lista para elegir y el resumen los cuenta", async () => {
    await seedSimpleSession("Contrato A", 3, 1);
    await seedSimpleSession("Recibo B", 2, 20);
    renderExport();
    const scan = await box(/^Escaneos en curso \(2 escaneos, /);
    await waitFor(() => expect(scan.checked).toBe(true));
    await waitSummary(/^Se exportará: 2 escaneos \(5 páginas\)\. Tamaño aproximado: /);
    const list = scanList();
    expect(list?.getAttribute("role")).toBe("group");
    expect(list?.getAttribute("aria-label")).toBe(copy.scanListLegend);
    expect(within(list as HTMLElement).getAllByRole("checkbox").map((item) => (item as HTMLInputElement).checked)).toEqual([true, true]);
    expect(within(list as HTMLElement).getByRole("checkbox", { name: /^Recibo B/ })).toBeTruthy();
    expect(within(list as HTMLElement).getByText(/^3 páginas · /)).toBeTruthy();
    // Son fotos de documentos: se recomienda cifrar y la contraseña viene marcada.
    expect((await box(copy.protect)).checked).toBe(true);
    expect(document.querySelector("[data-backup-scan-large]")).toBeNull();
  });

  it("quitar una sesión la saca del resumen y del paquete; quitarlas todas desmarca la casilla y volver a marcarla ofrece todas", async () => {
    const a = await seedSimpleSession("Contrato A", 3, 1);
    const b = await seedSimpleSession("Recibo B", 2, 20);
    const { onDone } = renderExport();
    await waitSummary(/2 escaneos \(5 páginas\)/);
    fireEvent.click(await box(/^Contrato A/));
    await waitSummary(/^Se exportará: 1 escaneo \(2 páginas\)\./);
    fireEvent.change(screen.getByLabelText(copy.password), { target: { value: "una-clave-larga" } });
    fireEvent.change(screen.getByLabelText(copy.confirmPassword), { target: { value: "una-clave-larga" } });
    fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    const [blob] = vi.mocked(downloadBlob).mock.calls[0] as [Blob, string];
    const index = await scanIndexOf(blob, "una-clave-larga");
    expect(index.sessions.map((s) => s.id)).toEqual([b.id]);
    expect(index.sessions.map((s) => s.id)).not.toContain(a.id);
    await waitFor(() => expect(document.querySelector("[data-backup-result]")?.textContent).toContain("1 escaneo (2 páginas)"));
    expect(onDone).toHaveBeenCalledWith(fill(copy.announceExported, { parts: "1 escaneo (2 páginas)" }));
    // El respaldo anota «escaneos en curso» como parte que viajó.
    expect(Object.keys(JSON.parse(window.localStorage.getItem(LAST_BACKUP_PARTS_KEY) as string))).toContain("scanSessions");
  });

  it("quitar todas las sesiones de la lista desmarca la casilla general (no hay nada que llevar) y volver a marcarla las ofrece todas", async () => {
    await seedSimpleSession("Contrato A", 1, 1);
    await seedSimpleSession("Recibo B", 1, 20);
    renderExport();
    const scan = await box(/^Escaneos en curso \(2 escaneos, /);
    await waitFor(() => expect(scan.checked).toBe(true));
    fireEvent.click(await box(/^Contrato A/));
    fireEvent.click(await box(/^Recibo B/));
    await waitFor(() => expect(scan.checked).toBe(false));
    expect(scanList()).toBeNull();
    await waitSummary(/^Marca al menos una casilla que tenga contenido\.$/);
    fireEvent.click(scan);
    await waitSummary(/^Se exportará: 2 escaneos \(2 páginas\)\./);
    expect(within(scanList() as HTMLElement).getAllByRole("checkbox").every((item) => (item as HTMLInputElement).checked)).toBe(true);
  });

  it("lo que no cabe en un solo paquete: desmarcada, con su aviso; al marcarla dice cuánto sobra y se arregla quitando sesiones", async () => {
    const a = await seedSimpleSession("Contrato A", 4, 1);
    await seedSimpleSession("Recibo B", 1, 30);
    const sizes = await summarizeScanSessions();
    if (!sizes.ok) throw new Error("esperaba ok");
    const smallBytes = sizes.sessions.find((s) => s.name === "Recibo B")?.bytes ?? 0;
    __setScanSessionsPackageBudgetForTests(smallBytes + 50);
    __resetScanSessionsSizeMemoForTests();
    renderExport();
    const scan = await box(/^Escaneos en curso \(2 escaneos, /);
    await waitFor(() => expect(document.querySelector("[data-backup-scan-excluded]")).toBeTruthy());
    expect(scan.checked).toBe(false);
    expect(document.querySelector("[data-backup-scan-excluded]")?.textContent).toMatch(/^Tus escaneos en curso pesan .* no se incluyen salvo que marques la casilla\.$/);
    fireEvent.click(scan);
    await waitFor(() => expect(document.querySelector("[data-backup-too-large]")).toBeTruthy());
    expect(document.querySelector("[data-backup-too-large]")?.textContent).toMatch(/no cabe en un solo paquete/);
    expect((screen.getByRole("button", { name: copy.exportConfirm }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(await box(/^Contrato A/));
    await waitFor(() => expect(document.querySelector("[data-backup-too-large]")).toBeNull());
    await waitSummary(/^Se exportará: 1 escaneo \(1 página\)\./);
    expect((screen.getByRole("button", { name: copy.exportConfirm }) as HTMLButtonElement).disabled).toBe(false);
    expect(a.id).toBeTruthy();
  });

  it("lo grande (más de 100 MB) avisa de que tardará y sigue siendo una elección: desmarcada por defecto, con la nota de que no se incluye", async () => {
    await seedSimpleSession("Contrato A", 2, 1);
    // Sin fabricar 150 MB: el almacen mide con el tamano de los Blob, que aqui se sustituye por uno grande.
    const load = scanSessionStore.load;
    vi.spyOn(scanSessionStore, "load").mockImplementation(async (id) => {
      const session = await load(id);
      if (!session) return session;
      return { ...session, pages: session.pages.map((page) => ({ ...page, original: { size: 75 * 1024 * 1024 } as unknown as Blob })) };
    });
    __resetScanSessionsSizeMemoForTests();
    renderExport();
    const scan = await box(/^Escaneos en curso \(1 escaneo, 150 MB\)/);
    expect(scan.checked).toBe(false);
    await waitFor(() => expect(document.querySelector("[data-backup-scan-excluded]")?.textContent).toContain("150 MB"));
    fireEvent.click(scan);
    await waitFor(() => expect(document.querySelector("[data-backup-scan-large]")?.textContent).toMatch(/pesan 150 MB\. El paquete tardará en crearse/));
    // Sigue cabiendo en un paquete: no hay bloqueo, solo el aviso.
    expect(document.querySelector("[data-backup-too-large]")).toBeNull();
  });

  it("una foto dañada no impide exportar: la página se queda fuera y se dice al terminar", async () => {
    await seedScanSession(scanSession([scanPage(1), scanPage(2, { original: bytesBlob(new TextEncoder().encode("no soy una foto"), "image/jpeg") })], { name: "Mixta" }));
    renderExport();
    await waitSummary(/1 escaneo \(2 páginas\)/);
    fireEvent.click(await box(copy.protect));
    fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.querySelector("[data-backup-note]")?.textContent).toBe(copy.scanSkippedOne));
    expect(document.querySelector("[data-backup-result]")?.textContent).toContain("1 escaneo (1 página)");
  });

  it("sin escaneos la casilla está deshabilitada («No hay nada que exportar aquí») y no se carga ninguna sesión", async () => {
    renderExport();
    const scan = await box(/^Escaneos en curso/);
    await waitFor(() => expect(scan.disabled).toBe(true));
    expect(scan.checked).toBe(false);
    expect(scanList()).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Importar
 * ------------------------------------------------------------------ */

function renderImport() {
  const onDone = vi.fn();
  render(
    <LanguageProvider>
      <ImportPackageSheet open onClose={vi.fn()} onDone={onDone} />
    </LanguageProvider>,
  );
  return { onDone };
}

const zipInput = () => document.querySelector("[data-backup-file-input]") as HTMLInputElement;
async function pickZip(file: File) {
  await screen.findByRole("button", { name: copy.pickZip });
  fireEvent.change(zipInput(), { target: { files: [file] } });
}
const moduleOf = (name: string) => document.querySelector(`[data-backup-module="${name}"]`) as HTMLElement;
const confirmButton = () => document.querySelector("[data-backup-confirm]") as HTMLButtonElement;

async function packageThenWipe(options: { password?: string } = {}) {
  const result = await exportEverything({ modules: { scanSessions: true }, password: options.password });
  if (!result.ok) throw new Error(result.reason);
  await resetScanStore();
  return asFile(result.blob, result.filename);
}

describe("Importar paquete · escaneos en curso", () => {
  it("vista previa con una tarjeta por escaneo (nombre, páginas, peso, fecha, «Nuevo») y, al confirmar, un resultado y todo restaurado", async () => {
    const a = await seedSimpleSession("Contrato A", 3, 1);
    const b = await seedSimpleSession("Recibo B", 2, 20);
    const file = await packageThenWipe({ password: "una-clave-larga" });
    const { onDone } = renderImport();
    await pickZip(file);
    fireEvent.change(await screen.findByLabelText(copy.passwordLabel), { target: { value: "una-clave-larga" } });
    fireEvent.click(screen.getByRole("button", { name: copy.passwordOpen }));
    await waitFor(() => expect(moduleOf("scanSessions")).toBeTruthy());
    expect(document.querySelector("[data-backup-preview-intro]")?.textContent).toBe("El paquete trae: 2 escaneos (estaba cifrado).");
    expect(within(moduleOf("scanSessions")).getByRole("heading", { name: "Escaneos en curso" })).toBeTruthy();
    const cards = [...moduleOf("scanSessions").querySelectorAll("[data-backup-item]")] as HTMLElement[];
    expect(cards.map((card) => card.getAttribute("data-backup-item"))).toEqual([`scan:${a.id}`, `scan:${b.id}`]);
    expect(cards.every((card) => card.getAttribute("data-status") === "new")).toBe(true);
    expect(within(cards[0]).getByText("Contrato A")).toBeTruthy();
    expect(within(cards[0]).getByText(/^3 páginas · .* · Guardado el /)).toBeTruthy();
    expect(within(cards[0]).getByText(copy.statusNew)).toBeTruthy();
    expect(within(cards[0]).getByRole("radio", { name: copy.decisionImport }).getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector('[data-backup-limits="scanSessions"]')?.textContent).toBe(copy.limitScan);
    expect(confirmButton().textContent).toBe(fill(copy.importConfirmMany, { n: 2 }));
    // Nada se ha escrito todavía.
    expect(await listScanSessionSummaries()).toEqual([]);

    // El Blob del navegador (jsdom) no se clona en fake-indexeddb: al guardar se usa el de Node.
    vi.stubGlobal("Blob", NodeBlob);
    fireEvent.click(confirmButton());
    await screen.findByText(fill(copy.resultScan, { n: 2 }));
    expect(onDone).toHaveBeenCalledWith(copy.announceImported);
    expect((await listScanSessionSummaries()).map((s) => s.name).sort()).toEqual(["Contrato A", "Recibo B"]);
    expect((await scanSessionStore.load(a.id))?.pages).toHaveLength(3);
  });

  it("una sesión distinta cuya copia local es más reciente lo dice, no se pisa por defecto y «Conservar ambos» crea una copia marcada", async () => {
    const a = await seedSimpleSession("Contrato A", 2, 1);
    const file = await packageThenWipe();
    // Local: mismo id, otro contenido y MÁS reciente.
    await seedScanSession({ ...a.session, updatedAt: "2026-12-30T10:00:00.000Z", name: "Contrato A (local)", pages: [scanPage(90)] });
    renderImport();
    await pickZip(file);
    await waitFor(() => expect(moduleOf("scanSessions")).toBeTruthy());
    const card = moduleOf("scanSessions").querySelector("[data-backup-item]") as HTMLElement;
    expect(card.getAttribute("data-status")).toBe("different");
    expect(within(card).getByText(copy.statusDifferent)).toBeTruthy();
    expect(card.querySelector("[data-backup-hint]")?.textContent).toMatch(/^Tu copia de este dispositivo es más reciente \(/);
    // Sugerido: conservar ambos (nunca pisar lo más nuevo).
    expect(within(card).getByRole("radio", { name: copy.decisionKeepBoth }).getAttribute("aria-checked")).toBe("true");
    expect(within(card).getAllByRole("radio").map((radio) => radio.textContent)).toEqual([copy.decisionReplace, copy.decisionKeepBoth, copy.decisionOmit]);
    vi.stubGlobal("Blob", NodeBlob);
    fireEvent.click(confirmButton());
    await screen.findByText(fill(copy.resultScan, { n: 1 }));
    const names = (await listScanSessionSummaries()).map((s) => s.name).sort();
    expect(names).toEqual(["Contrato A (importado)", "Contrato A (local)"]);
    expect((await scanSessionStore.load(a.id))?.name).toBe("Contrato A (local)");
  });

  it("una sesión caducada en el paquete es «No se puede importar» con su motivo y no se escribe", async () => {
    const a = await seedSimpleSession("Contrato A", 1, 1);
    const result = await exportEverything({ modules: { scanSessions: true } });
    if (!result.ok) throw new Error(result.reason);
    await resetScanStore();
    // Un paquete cuya sesion se guardo hace 20 dias.
    const { rewriteZip } = await import("@/lib/backup/__fixtures__/testKit");
    const old = await rewriteZip(result.blob, async (zip) => {
      const raw = (await zip.file("scan-sessions/index.json")!.async("string")).replace(/"savedAt":"[^"]+"/, `"savedAt":"${new Date(Date.now() - 20 * 86_400_000).toISOString()}"`);
      zip.file("scan-sessions/index.json", raw);
      const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
      const entry = manifest.files.find((file: { path: string }) => file.path === "scan-sessions/index.json");
      const { sha256Hex } = await import("@/lib/crypto/sha256");
      const data = new TextEncoder().encode(raw);
      entry.sha256 = await sha256Hex(data);
      entry.bytes = data.length;
      zip.file("manifest.json", JSON.stringify(manifest));
    });
    renderImport();
    await pickZip(asFile(old));
    await waitFor(() => expect(moduleOf("scanSessions")).toBeTruthy());
    const card = moduleOf("scanSessions").querySelector("[data-backup-item]") as HTMLElement;
    expect(card.getAttribute("data-status")).toBe("invalid");
    expect(within(card).getByText(copy.statusInvalid)).toBeTruthy();
    expect(within(card).getByText(copy.scanInvalidReasons.expired)).toBeTruthy();
    expect(confirmButton().disabled).toBe(true);
    expect(confirmButton().textContent).toBe(copy.importNothing);
    expect(await listScanSessionSummaries()).toEqual([]);
    expect(a.id).toBeTruthy();
  });

  it("si no hay sitio en el navegador lo dice con las cifras, bloquea el botón y se arregla omitiendo", async () => {
    await seedSimpleSession("Contrato A", 3, 1);
    const file = await packageThenWipe();
    vi.stubGlobal("navigator", { ...navigator, storage: { estimate: async () => ({ usage: 1000, quota: 1100 }) } });
    renderImport();
    await pickZip(file);
    await waitFor(() => expect(moduleOf("scanSessions")).toBeTruthy());
    await waitFor(() => expect(document.querySelector('[data-backup-limits="scanSessions"]')?.textContent).toMatch(/^No caben todos los escaneos elegidos: necesitan .* y en este navegador quedan /));
    expect(document.querySelector("[data-backup-blocked]")?.textContent).toContain("Escaneos en curso");
    expect(confirmButton().disabled).toBe(true);
    fireEvent.click(within(moduleOf("scanSessions")).getByRole("radio", { name: copy.decisionOmit }));
    await waitFor(() => expect(confirmButton().textContent).toBe(copy.importNothing));
    expect(document.querySelector("[data-backup-blocked]")).toBeNull();
  });

  it("páginas dañadas del paquete se cuentan en la tarjeta y el resto de la sesión entra", async () => {
    await seedScanSession(scanSession([scanPage(1), scanPage(2)], { name: "Mixta" }));
    const result = await exportEverything({ modules: { scanSessions: true } });
    if (!result.ok) throw new Error(result.reason);
    await resetScanStore();
    const { rewriteZip } = await import("@/lib/backup/__fixtures__/testKit");
    const damaged = await rewriteZip(result.blob, async (zip) => {
      const bytes = (await zip.file("scan-sessions/s1-p2.jpg")!.async("uint8array")).slice();
      bytes[bytes.length - 6] ^= 0xff;
      zip.file("scan-sessions/s1-p2.jpg", bytes);
    });
    renderImport();
    await pickZip(asFile(damaged));
    await waitFor(() => expect(moduleOf("scanSessions")).toBeTruthy());
    const card = moduleOf("scanSessions").querySelector("[data-backup-item]") as HTMLElement;
    expect(card.querySelector("[data-backup-scan-discarded]")?.textContent).toBe(copy.scanDiscardedOne);
    expect(within(card).getByText(/^1 página · /)).toBeTruthy();
    vi.stubGlobal("Blob", NodeBlob);
    fireEvent.click(confirmButton());
    await screen.findByText(fill(copy.resultScan, { n: 1 }));
    const [summary] = await listScanSessionSummaries();
    expect((await scanSessionStore.load(summary.id))?.pages).toHaveLength(1);
  });

  it("un paquete de solo escaneos entra por la misma vía y los demás módulos se dicen como «no incluye»", async () => {
    await seedSimpleSession("Contrato A", 1, 1);
    const file = await packageThenWipe();
    renderImport();
    await pickZip(file);
    await waitFor(() => expect(moduleOf("scanSessions")).toBeTruthy());
    expect([...document.querySelectorAll("[data-backup-module]")].map((node) => node.getAttribute("data-backup-module"))).toEqual(["scanSessions"]);
    vi.stubGlobal("Blob", NodeBlob);
    fireEvent.click(confirmButton());
    await screen.findByText(fill(copy.resultScan, { n: 1 }));
    expect(document.querySelector("[data-backup-result]")?.textContent).toContain("El paquete no incluye: Firmas, Plantillas y documentos, Borradores, Perfiles de cliente, Ajustes.");
    expect(statusText()).toContain("Escaneos en curso: 1 importados.");
  });
});

/* El cambio de idioma se queda en el almacen de i18n del archivo: va el ultimo. */
function SetLanguage({ language }: { language: "es" | "en" }) {
  const { setLanguage } = useI18n();
  useEffect(() => setLanguage(language), [language, setLanguage]);
  return null;
}

describe("Exportar mi paquete · escaneos en curso · inglés", () => {
  it("en inglés", async () => {
    await seedSimpleSession("Contract A", 2, 1);
    render(
      <LanguageProvider>
        <SetLanguage language="en" />
        <ExportPackageSheet open onClose={vi.fn()} />
      </LanguageProvider>,
    );
    await box(/^Scans in progress \(1 scan, /);
    await waitFor(() => expect(summary()).toMatch(/^Will be exported: 1 scan \(2 pages\)/));
    expect(screen.getByText(en.settings.backup.scanHint)).toBeTruthy();
  });
});
