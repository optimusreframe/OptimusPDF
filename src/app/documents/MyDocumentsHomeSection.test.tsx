import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { freshLibrary, minuteClock, noIndexedDb, seedDocument, seedReadyTemplate, seedSingleTemplate } from "@/app/documents/documents.testkit";
import { getDocument, replaceDocumentBytes } from "@/lib/docLibrary/store";
import { sampleBytes, sampleFingerprint } from "@/lib/docLibrary/testing/sampleDocs";
import { __clearThumbnailCacheForTests } from "@/app/documents/useDocumentThumbnail";
import { Header } from "@/components/layout/Header";
import { MobileTabBar } from "@/components/layout/MobileTabBar";
import { Sidebar } from "@/components/layout/Sidebar";
import { HomeView } from "@/components/views/HomeView";
import { resetSignHandoffForTests, SIGN_HANDOFF_KEY } from "@/lib/docLibrary/signHandoff";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { ThemeProvider } from "@/lib/theme";
import { es } from "@/lib/locales/es";
import { addRecentEntry, clearRecentEntries } from "@/lib/recent";

/** Seccion «Mis documentos» de Inicio y su acceso desde la navegacion (barra lateral, cabecera y barra movil). */

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("@/app/pdf-pro/ops/previewRender", () => ({ renderPreviewDataUrl: vi.fn(async () => null) }));

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
beforeEach(() => {
  freshLibrary();
  resetSignHandoffForTests();
  __clearThumbnailCacheForTests();
  clearRecentEntries();
  push.mockClear();
});
afterEach(cleanup);

const renderHome = () =>
  render(
    <LanguageProvider>
      <HomeView />
    </LanguageProvider>,
  );
const section = () => document.querySelector("[data-home-documents]") as HTMLElement | null;

describe("Inicio — plantilla desactualizada (F2-fix · MAYOR 3)", () => {
  it("tras reemplazar el PDF por otro contrato la tarjeta de Inicio avisa (no ✓) y «sigue valiendo» lo quita", async () => {
    await seedDocument("a", { name: "Contrato A", seed: 7 });
    await seedReadyTemplate("a");
    await replaceDocumentBytes("a", sampleBytes(60, 3), { fingerprinter: async () => sampleFingerprint(6, 99) });
    renderHome();
    await waitFor(() => expect(section()?.querySelector('[data-template-state="stale"]') ?? null).not.toBeNull());
    expect(section()!.querySelector('[data-template-state="ready"]')).toBeNull();
    expect(within(section()!).getByText(es.documents.statusStale)).toBeTruthy();
    fireEvent.click(within(section()!).getByRole("button", { name: `La plantilla de Contrato A sigue valiendo` }));
    await waitFor(() => expect(section()?.querySelector('[data-template-state="ready"]') ?? null).not.toBeNull());
    expect((await getDocument("a"))!.templateStale).toBeUndefined();
  });
});

describe("Inicio — sección «Mis documentos»", () => {
  it("vacía: invita a subir el primer contrato con un enlace a /documents", async () => {
    renderHome();
    const empty = await waitFor(() => {
      const el = document.querySelector("[data-home-documents-empty]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(within(empty).getByText(es.documents.emptyTitle)).toBeTruthy();
    expect(within(empty).getByRole("link", { name: es.documents.add }).getAttribute("href")).toBe("/documents");
    expect(within(section()!).getByRole("heading", { level: 2, name: es.documents.title })).toBeTruthy();
    expect(within(section()!).getByRole("link", { name: es.documents.seeAll }).getAttribute("href")).toBe("/documents");
  });

  it("muestra hasta 4 documentos (los más recientes) con ✓ / ✓ parcial / ✗ y «Ver todos»", async () => {
    const clock = minuteClock();
    for (const id of ["d1", "d2", "d3", "d4", "d5", "d6"]) await seedDocument(id, { name: `Contrato ${id}`, now: clock });
    await seedReadyTemplate("d6");
    await seedSingleTemplate("d5");
    renderHome();
    await waitFor(() => expect(section()?.querySelectorAll("[data-document-id]").length).toBe(4));
    const ids = Array.from(section()!.querySelectorAll("[data-document-id]")).map((li) => li.getAttribute("data-document-id"));
    expect(ids).toEqual(["d6", "d5", "d4", "d3"]);
    await waitFor(() => {
      const states = Array.from(section()!.querySelectorAll("[data-template-state]")).map((el) => el.getAttribute("data-template-state"));
      expect(states).toEqual(["ready", "single", "none", "none"]);
    });
    expect(within(section()!).getByText(es.documents.statusReady)).toBeTruthy();
    expect(within(section()!).getByText(es.documents.statusSingle)).toBeTruthy();
    // La página completa es para gestionar: aquí no hay casillas ni menú.
    expect(within(section()!).queryAllByRole("checkbox")).toHaveLength(0);
    expect(within(section()!).queryByRole("button", { name: /Más acciones/ })).toBeNull();
  });

  it("«Firmar» y «Configurar plantilla» dejan el traspaso y navegan a Firmar", async () => {
    await seedDocument("d1", { name: "Contrato d1" });
    renderHome();
    const sign = await screen.findByRole("button", { name: `${es.documents.sign} Contrato d1` });
    fireEvent.click(sign);
    expect(push).toHaveBeenLastCalledWith("/sign-pdf");
    expect(JSON.parse(window.sessionStorage.getItem(SIGN_HANDOFF_KEY)!)).toMatchObject({ documentIds: ["d1"], mode: "sign" });
    fireEvent.click(screen.getByRole("button", { name: es.documents.configureNamed.replace("{name}", "Contrato d1") }));
    expect(JSON.parse(window.sessionStorage.getItem(SIGN_HANDOFF_KEY)!)).toMatchObject({ documentIds: ["d1"], mode: "configure" });
  });

  it("va ANTES de «Más usadas» y se oculta mientras se busca", async () => {
    await seedDocument("d1", { name: "Contrato d1" });
    addRecentEntry("merge-pdf", "viejo.pdf");
    renderHome();
    await waitFor(() => expect(section()).not.toBeNull());
    const mostUsed = screen.getByRole("heading", { name: es.home.mostUsedTitle });
    expect(section()!.compareDocumentPosition(mostUsed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: es.home.searchPlaceholder }), { target: { value: "unir" } });
    expect(section()).toBeNull();
  });

  it("sin IndexedDB no pinta nada (la página completa lo explica) y no rompe Inicio", async () => {
    noIndexedDb();
    renderHome();
    expect(await screen.findByRole("heading", { level: 1, name: es.home.title })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(section()).toBeNull();
  });

  it("se mantiene al día cuando la biblioteca cambia", async () => {
    renderHome();
    await waitFor(() => expect(document.querySelector("[data-home-documents-empty]")).not.toBeNull());
    await seedDocument("d1", { name: "Contrato d1" });
    await waitFor(() => expect(section()?.querySelectorAll("[data-document-id]").length).toBe(1));
    expect(document.querySelector("[data-home-documents-empty]")).toBeNull();
  });
});

describe("navegación a /documents", () => {
  it("la barra lateral, la cabecera y la barra móvil enlazan a Mis documentos", () => {
    render(
      <ThemeProvider>
        <LanguageProvider>
          <Sidebar />
          <Header />
          <MobileTabBar />
        </LanguageProvider>
      </ThemeProvider>,
    );
    const links = screen.getAllByRole("link", { name: es.nav.documents });
    expect(links).toHaveLength(3);
    for (const link of links) expect(link.getAttribute("href")).toBe("/documents");
  });
});
