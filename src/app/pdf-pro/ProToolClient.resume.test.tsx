import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProToolClient } from "@/app/pdf-pro/ProToolClient";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { clearHandoff } from "@/app/pdf-pro/proHandoff";
import { __resetProFeatureFlagsCacheForTests } from "@/app/pdf-pro/proFeatureFlags";
import {
  __closeWarmProDraftsConnectionForTests,
  __resetProDraftsMemoryForTests,
  clearAllProDrafts,
  saveProDraft,
} from "@/app/pdf-pro/proDrafts";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { makePdfBytes, pdfFile } from "@/app/pdf-pro/proTestUtils";
import { __clearRegisteredCommandsForTests } from "@/app/pdf-pro/shell/proCommands";
import { __clearProActionsForTests } from "@/app/pdf-pro/shell/proActions";
import { __clearDraftThumbnailCacheForTests } from "@/app/pdf-pro/session/useDraftThumbnails";
import { clearRecentEntries } from "@/lib/recent";
import { es } from "@/lib/locales/es";
import { resetReducedMotionPrefCache } from "@/hooks/useReducedMotionPref";
import { installLayoutEnv, pdfMocks, resetViewerGlobals, type LayoutEnv } from "@/app/pdf-pro/viewer/viewerTestUtils";

/**
 * `/pdf-pro?resume=pro:<id>` (Recientes -> Continuar, U0.6): abre ESE borrador con su historial, limpia la URL y, si ya
 * no existe, avisa («Este trabajo ya no se puede recuperar...») sin tocar la unica region viva de la pagina. pdf.js se simula.
 */

const downloaded = vi.hoisted(() => ({ blobs: [] as { blob: Blob; name: string }[] }));
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  const utils = await import("@/app/pdf-pro/viewer/viewerMocks");
  return {
    ...actual,
    downloadBlob: (blob: Blob, name: string) => downloaded.blobs.push({ blob, name }),
    openPdfDocument: utils.pdfMocks.open,
    closePdfDocument: utils.pdfMocks.close,
    renderPageToDataUrl: utils.pdfMocks.thumb,
  };
});
vi.mock("@/lib/pdf/pageRaster", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/pageRaster")>();
  const utils = await import("@/app/pdf-pro/viewer/viewerMocks");
  return { ...actual, renderPageRaster: utils.pdfMocks.render };
});
vi.mock("@/app/pdf-pro/ops/previewRender", () => ({ renderPreviewDataUrl: vi.fn(async () => "data:image/png;base64,AAAA") }));

const S = PRO_STRINGS.es;
let env: LayoutEnv;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

beforeEach(async () => {
  env = installLayoutEnv({ width: 1100, height: 700 });
  resetViewerGlobals();
  downloaded.blobs.length = 0;
  clearHandoff();
  clearRecentEntries();
  window.localStorage.removeItem("optimuspdf.pro.featureFlags");
  __resetProFeatureFlagsCacheForTests();
  __resetProDraftsMemoryForTests();
  __closeWarmProDraftsConnectionForTests();
  __clearDraftThumbnailCacheForTests();
  await clearAllProDrafts();
  __clearRegisteredCommandsForTests();
  __clearProActionsForTests();
});

afterEach(() => {
  cleanup();
  env.restore();
  vi.unstubAllGlobals();
  resetReducedMotionPrefCache();
  document.documentElement.removeAttribute("data-pro-suite");
});

function renderPro() {
  return render(
    <LanguageProvider>
      <ProToolClient />
    </LanguageProvider>,
  );
}
const dropzoneInput = (container: HTMLElement) => container.querySelector('input[type="file"]') as HTMLInputElement;

const idOf = (n: number) => n.toString(16).padStart(64, "0");
async function seedDraft(n: number, fileName = `reciente-${n}.pdf`) {
  const result = await saveProDraft({
    id: idOf(n),
    fileName,
    bytes: await makePdfBytes(2),
    snapshotId: `snap-${n}`,
    history: [
      { label: "Original", createdAt: 1, source: "open" },
      { label: "Rotar", createdAt: 2, source: "operation" },
    ],
    pageCount: 2,
    currentPage: 0,
  });
  expect(result.ok).toBe(true);
}

const setUrl = (path: string) => window.history.replaceState(null, "", path);
const heading = (name: string) => screen.findByRole("heading", { level: 1, name: new RegExp(name.replace(".", "\\.")) });

afterEach(() => setUrl("/"));

describe("?resume=pro:<id>", () => {
  it("abre el borrador pedido (no otro), con su historial, y limpia la URL sin anadir historial", async () => {
    await seedDraft(1);
    await seedDraft(2);
    setUrl(`/pdf-pro?resume=pro:${idOf(2)}`);
    const historyBefore = window.history.length;
    renderPro();

    await heading("reciente-2.pdf");
    expect(screen.queryByRole("heading", { level: 1, name: /reciente-1\.pdf/ })).toBeNull();
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(window.location.pathname).toBe("/pdf-pro");
    expect(window.history.length).toBe(historyBefore);
    // Restaurado de verdad: el documento se abre como trabajo con cambios (el borrador lleva un paso aplicado).
    expect(await screen.findByText(S.suite.unsaved)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("al abrirlo, el historial apunta al borrador (solo tipo e id) para no repetirlo en Recientes", async () => {
    await seedDraft(1);
    setUrl(`/pdf-pro?resume=pro:${idOf(1)}`);
    renderPro();
    await heading("reciente-1.pdf");
    const stored = JSON.parse(window.localStorage.getItem("optimuspdf.recent") ?? "[]");
    expect(stored[0]).toMatchObject({ slug: "pdf-pro", fileName: "reciente-1.pdf", resume: { kind: "pro", id: idOf(1) } });
  });

  it("si el borrador ya no existe: aviso con «Abrir de nuevo», sin el error generico y con UNA sola region viva", async () => {
    await seedDraft(1);
    setUrl(`/pdf-pro?resume=pro:${idOf(9)}`);
    renderPro();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(es.resume.gone);
    expect(within(alert).getByRole("button", { name: es.resume.reopen })).toBeTruthy();
    expect(screen.queryByText(S.drafts.failed)).toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByRole("heading", { level: 1, name: /reciente-1/ })).toBeNull();
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("«Abrir de nuevo» abre el selector de PDF y elegir un archivo retira el aviso", async () => {
    setUrl(`/pdf-pro?resume=pro:${idOf(9)}`);
    const { container } = renderPro();
    const alert = await screen.findByRole("alert");
    const input = dropzoneInput(container);
    const click = vi.spyOn(input, "click");
    fireEvent.click(within(alert).getByRole("button", { name: es.resume.reopen }));
    // (la zona de carga reenvia el clic de su selector: la plataforma ignora la reentrada, aqui basta con que se abra)
    expect(click).toHaveBeenCalled();

    pdfMocks.state.defaultPages = 2;
    fireEvent.change(input, { target: { files: [pdfFile(await makePdfBytes(2), "nuevo.pdf")] } });
    await heading("nuevo.pdf");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["tipo de otra herramienta (aunque el id exista)", () => `edit:${idOf(1)}`],
    ["tipo fuera de la lista blanca", () => `delete:${idOf(1)}`],
    ["id manipulado", () => "pro:../../etc/passwd"],
    ["id corto", () => `pro:${idOf(1).slice(1)}`],
    ["etiqueta", () => "<img src=x onerror=alert(1)>"],
    ["prototipo", () => `__proto__:${idOf(1)}`],
  ])("%s: no abre nada, no avisa y limpia la URL", async (_label, value) => {
    await seedDraft(1);
    setUrl(`/pdf-pro?resume=${encodeURIComponent(value())}`);
    renderPro();
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(screen.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1, name: /reciente-1/ })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sin ?resume= no hay aviso ni se abre nada", async () => {
    await seedDraft(1);
    renderPro();
    expect(await screen.findByRole("heading", { level: 1, name: "PDF Pro" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("heading", { level: 1, name: /reciente-1/ })).toBeNull();
  });
});
