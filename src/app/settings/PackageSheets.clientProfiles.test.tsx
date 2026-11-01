import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ExportPackageSheet } from "@/app/settings/ExportPackageSheet";
import { ImportPackageSheet } from "@/app/settings/ImportPackageSheet";
import { __resetSignPdfFeatureFlagsCacheForTests } from "@/app/sign-pdf/signFeatureFlags";
import { LAST_BACKUP_PARTS_KEY } from "@/lib/backup/lastBackup";
import { readPackage } from "@/lib/backup/package";
import { exportEverything } from "@/lib/backup/globalPackage";
import { KIT_AT, kitProfile, seedProfiles, storedProfilesRaw, wipeProfiles } from "@/lib/backup/__fixtures__/clientProfilesKit";
import { asFile } from "@/lib/backup/__fixtures__/testKit";
import { __resetLibraryForTests, clearLibrary } from "@/lib/docLibrary/store";
import { LanguageProvider } from "@/lib/i18n";
import { listClientProfiles, MAX_CLIENT_PROFILES } from "@/lib/clientProfile/store";
import { downloadBlob } from "@/lib/pdf/core";
import { es } from "@/lib/locales/es";

/**
 * «Exportar mi paquete» e «Importar paquete» con los PERFILES DE CLIENTE (jsdom): la casilla con su recuento, la lista para
 * elegir perfiles, el aviso de que son datos de clientes (cifrado recomendado), la vista previa con una tarjeta por perfil (sin
 * mostrar sus valores), las decisiones, los limites y el resultado.
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
  wipeProfiles();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["es-ES"]);
  vi.mocked(downloadBlob).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  cleanup();
});

const box = (name: string | RegExp) => screen.findByRole("checkbox", { name }) as Promise<HTMLInputElement>;
const summary = () => document.querySelector("[data-backup-summary]")?.textContent ?? "";
const waitSummary = (pattern: RegExp) => waitFor(() => expect(summary()).toMatch(pattern));
const profileList = () => document.querySelector("[data-backup-profile-list]") as HTMLElement | null;

function renderExport() {
  const onDone = vi.fn();
  render(
    <LanguageProvider>
      <ExportPackageSheet open onClose={vi.fn()} onDone={onDone} />
    </LanguageProvider>,
  );
  return { onDone };
}

const ANA = () => kitProfile("cp-ana", "Pérez, Ana", { email: "ana@ejemplo.test" });
const LUIS = () => kitProfile("cp-luis", "Gómez, Luis", { claimNumber: "CLM-0001" }, "2026-10-21T10:00:00.000Z");

describe("Exportar mi paquete · perfiles de cliente", () => {
  it("la casilla lleva su recuento y viene marcada; con dos perfiles hay lista para elegir y el resumen los cuenta", async () => {
    seedProfiles([ANA(), LUIS()]);
    renderExport();
    const check = await box(/^Perfiles de cliente \(2 perfiles de cliente\)$/);
    await waitFor(() => expect(check.checked).toBe(true));
    await waitSummary(/^Se exportará: 2 perfiles de cliente\. Tamaño aproximado: /);
    const list = profileList();
    expect(list?.getAttribute("role")).toBe("group");
    expect(list?.getAttribute("aria-label")).toBe(copy.profilesListLegend);
    expect(within(list as HTMLElement).getAllByRole("checkbox").map((item) => (item as HTMLInputElement).checked)).toEqual([true, true]);
    expect(within(list as HTMLElement).getByRole("checkbox", { name: /^Pérez, Ana/ })).toBeTruthy();
    // Datos de clientes: se recomienda cifrar y la contraseña viene marcada.
    expect((await box(copy.protect)).checked).toBe(true);
    // La hoja nunca pinta los valores guardados.
    expect(document.body.textContent).not.toContain("555-0100");
  });

  it("quitar un perfil lo saca del resumen y del paquete; quitarlos todos desmarca la casilla", async () => {
    seedProfiles([ANA(), LUIS()]);
    const { onDone } = renderExport();
    await waitSummary(/2 perfiles de cliente/);
    fireEvent.click(await box(/^Pérez, Ana/));
    await waitSummary(/^Se exportará: 1 perfil de cliente\./);
    fireEvent.change(screen.getByLabelText(copy.password), { target: { value: "una-clave-larga" } });
    fireEvent.change(screen.getByLabelText(copy.confirmPassword), { target: { value: "una-clave-larga" } });
    fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    const [blob] = vi.mocked(downloadBlob).mock.calls[0] as [Blob, string];
    const read = await readPackage(blob, "una-clave-larga");
    const json = JSON.parse(new TextDecoder().decode(read.modules.find((m) => m.name === "client-profiles")?.files.get("client-profiles/profiles.json")?.bytes as Uint8Array));
    expect(json.profiles.map((p: { id: string }) => p.id)).toEqual(["cp-luis"]);
    await waitFor(() => expect(document.querySelector("[data-backup-result]")?.textContent).toContain("1 perfil de cliente"));
    expect(onDone).toHaveBeenCalledWith(fill(copy.announceExported, { parts: "1 perfil de cliente" }));
    expect(Object.keys(JSON.parse(window.localStorage.getItem(LAST_BACKUP_PARTS_KEY) as string))).toContain("clientProfiles");
  });

  it("quitar todos los perfiles de la lista desmarca la casilla general y volver a marcarla los ofrece todos", async () => {
    seedProfiles([ANA(), LUIS()]);
    renderExport();
    const general = await box(/^Perfiles de cliente \(2 perfiles de cliente\)$/);
    await waitFor(() => expect(general.checked).toBe(true));
    fireEvent.click(await box(/^Pérez, Ana/));
    fireEvent.click(await box(/^Gómez, Luis/));
    await waitFor(() => expect(general.checked).toBe(false));
    expect(profileList()).toBeNull();
    fireEvent.click(general);
    await waitFor(() => expect(general.checked).toBe(true));
    await waitSummary(/^Se exportará: 2 perfiles de cliente\./);
    expect(within(profileList() as HTMLElement).getAllByRole("checkbox").map((item) => (item as HTMLInputElement).checked)).toEqual([true, true]);
  });

  it("sin perfiles la casilla esta deshabilitada y sin lista", async () => {
    renderExport();
    const check = await box(/^Perfiles de cliente/);
    await waitFor(() => expect(check.disabled).toBe(true));
    expect(check.checked).toBe(false);
    expect(profileList()).toBeNull();
  });
});

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

async function packageThenWipe(password?: string) {
  const result = await exportEverything({ modules: { clientProfiles: true }, password });
  if (!result.ok) throw new Error(result.reason);
  expect(result.included).toEqual(["clientProfiles"]);
  wipeProfiles();
  return asFile(result.blob, result.filename);
}

describe("Importar paquete · perfiles de cliente", () => {
  it("una tarjeta por perfil (nombre, cuantos datos, fecha, «Nuevo»), sin mostrar valores; al confirmar, un resultado y todo restaurado", async () => {
    seedProfiles([ANA(), LUIS()]);
    const file = await packageThenWipe("una-clave-larga");
    const { onDone } = renderImport();
    await pickZip(file);
    fireEvent.change(await screen.findByLabelText(copy.passwordLabel), { target: { value: "una-clave-larga" } });
    fireEvent.click(screen.getByRole("button", { name: copy.passwordOpen }));
    await waitFor(() => expect(moduleOf("clientProfiles")).toBeTruthy());
    expect(document.querySelector("[data-backup-preview-intro]")?.textContent).toBe("El paquete trae: 2 perfiles de cliente (estaba cifrado).");
    expect(within(moduleOf("clientProfiles")).getByRole("heading", { name: "Perfiles de cliente" })).toBeTruthy();
    const cards = [...moduleOf("clientProfiles").querySelectorAll("[data-backup-item]")] as HTMLElement[];
    expect(cards.map((card) => card.getAttribute("data-backup-item")).sort()).toEqual(["profile:cp-ana", "profile:cp-luis"]);
    expect(cards.every((card) => card.getAttribute("data-status") === "new")).toBe(true);
    const ana = cards.find((card) => card.getAttribute("data-backup-item") === "profile:cp-ana") as HTMLElement;
    expect(within(ana).getByText("Pérez, Ana")).toBeTruthy();
    expect(within(ana).getByText(/^3 valores · Guardado el /)).toBeTruthy();
    expect(within(ana).getByRole("radio", { name: copy.decisionImport }).getAttribute("aria-checked")).toBe("true");
    expect(moduleOf("clientProfiles").textContent).not.toContain("555-0100");
    expect(document.querySelector('[data-backup-limits="clientProfiles"]')?.textContent).toBe(copy.limitProfiles);
    expect(confirmButton().textContent).toBe(fill(copy.importConfirmMany, { n: 2 }));
    expect(listClientProfiles()).toEqual([]);

    fireEvent.click(confirmButton());
    await screen.findByText(fill(copy.resultProfiles, { n: 2 }));
    expect(onDone).toHaveBeenCalledWith(copy.announceImported);
    expect(listClientProfiles().map((p) => p.name).sort()).toEqual(["Gómez, Luis", "Pérez, Ana"]);
  });

  it("un perfil distinto cuya copia local es mas reciente lo dice, no se pisa por defecto y «Conservar ambos» crea una copia marcada", async () => {
    seedProfiles([ANA()]);
    const file = await packageThenWipe();
    seedProfiles([{ ...ANA(), updatedAt: "2026-12-30T10:00:00.000Z", values: { phone: { value: "555-9999", updatedAt: "2026-12-30T10:00:00.000Z", source: "typed" } } }]);
    renderImport();
    await pickZip(file);
    await waitFor(() => expect(moduleOf("clientProfiles")).toBeTruthy());
    const card = moduleOf("clientProfiles").querySelector("[data-backup-item]") as HTMLElement;
    expect(card.getAttribute("data-status")).toBe("different");
    expect(within(card).getByText(copy.statusDifferent)).toBeTruthy();
    expect(card.querySelector("[data-backup-hint]")?.textContent).toMatch(/^Tu copia de este dispositivo es más reciente \(/);
    expect(within(card).getByRole("radio", { name: copy.decisionKeepBoth }).getAttribute("aria-checked")).toBe("true");
    expect(within(card).getAllByRole("radio").map((radio) => radio.textContent)).toEqual([copy.decisionReplace, copy.decisionKeepBoth, copy.decisionOmit]);
    fireEvent.click(confirmButton());
    await screen.findByText(fill(copy.resultProfiles, { n: 1 }));
    expect(listClientProfiles().map((p) => p.name).sort()).toEqual(["Pérez, Ana", "Pérez, Ana (importado)"]);
    expect(listClientProfiles().find((p) => p.id === "cp-ana")?.values.phone.value).toBe("555-9999");
  });

  it("si no caben (20 locales + 1) lo dice con las cifras, bloquea el boton y se arregla omitiendo", async () => {
    seedProfiles([ANA()]);
    const file = await packageThenWipe();
    seedProfiles(Array.from({ length: MAX_CLIENT_PROFILES }, (_, i) => kitProfile(`cp-local-${i}`, `Local ${i}`)));
    const raw = storedProfilesRaw();
    renderImport();
    await pickZip(file);
    await waitFor(() => expect(moduleOf("clientProfiles")).toBeTruthy());
    await waitFor(() => expect(document.querySelector('[data-backup-limits="clientProfiles"]')?.textContent).toBe(fill(copy.limitProfilesExceeded, { max: 20, total: 21 })));
    expect(document.querySelector("[data-backup-blocked]")?.textContent).toContain("Perfiles de cliente");
    expect(confirmButton().disabled).toBe(true);
    fireEvent.click(within(moduleOf("clientProfiles")).getByRole("radio", { name: copy.decisionOmit }));
    await waitFor(() => expect(confirmButton().textContent).toBe(copy.importNothing));
    expect(document.querySelector("[data-backup-blocked]")).toBeNull();
    expect(storedProfilesRaw()).toBe(raw);
  });

  it("un paquete de solo perfiles: los demas modulos se dicen «no incluye» en UNA linea", async () => {
    seedProfiles([ANA()]);
    const file = await packageThenWipe();
    renderImport();
    await pickZip(file);
    await waitFor(() => expect(moduleOf("clientProfiles")).toBeTruthy());
    expect([...document.querySelectorAll("[data-backup-module]")].map((node) => node.getAttribute("data-backup-module"))).toEqual(["clientProfiles"]);
    fireEvent.click(confirmButton());
    await screen.findByText(fill(copy.resultProfiles, { n: 1 }));
    expect(document.querySelector("[data-backup-result]")?.textContent).toContain("El paquete no incluye: Firmas, Plantillas y documentos, Borradores, Escaneos en curso, Ajustes.");
    expect(KIT_AT).toBeTruthy();
  });
});
