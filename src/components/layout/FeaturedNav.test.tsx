import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Header } from "@/components/layout/Header";
import { Sidebar } from "@/components/layout/Sidebar";
import { resetSidebarSectionsForTests } from "@/components/layout/SidebarTree";
import { closeMobileMenu } from "@/components/layout/mobileMenu";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { ThemeProvider } from "@/lib/theme";
import { CATEGORY_ORDER, GROUP_ORDER, getToolsByCategory, getToolsByGroup } from "@/lib/tools-registry";
import { es } from "@/lib/locales/es";

/** Menus con PDF Pro: primer item del menu movil/tablet (hoja) y de la barra lateral, tras «Inicio» y «Recientes» (plan OptimusTOOLS). */

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

beforeEach(() => {
  window.sessionStorage.clear();
  resetSidebarSectionsForTests();
});

afterEach(() => {
  act(() => closeMobileMenu());
  cleanup();
  pathname = "/";
});

async function renderMenu(): Promise<HTMLElement> {
  render(
    <ThemeProvider>
      <LanguageProvider>
        <Header />
      </LanguageProvider>
    </ThemeProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: es.nav.menu }));
  return screen.findByRole("dialog");
}

function renderSidebar() {
  return render(
    <ThemeProvider>
      <LanguageProvider>
        <Sidebar />
      </LanguageProvider>
    </ThemeProvider>,
  );
}

describe("Menu movil/tablet (hoja) — PDF Pro", () => {
  it("PDF Pro es el PRIMER enlace de herramienta del menu, tras «Inicio» y «Recientes» y antes de cualquier categoria", async () => {
    const dialog = await renderMenu();
    const nav = within(dialog).getByRole("navigation", { name: es.nav.menu });
    const links = within(nav).getAllByRole("link");
    expect(links.slice(0, 3).map((l) => l.getAttribute("href"))).toEqual(["/", "/recent", "/pdf-pro"]);
    const firstCategory = nav.querySelector("a[href='/#organize']")!;
    expect(links[2].compareDocumentPosition(firstCategory) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("lleva el acento propio de PDF Pro y NO esta dentro de ninguna categoria ni grupo", async () => {
    const dialog = await renderMenu();
    expect(within(dialog).getByRole("link", { name: "PDF Pro" }).querySelector("svg")?.getAttribute("class")).toMatch(/text-accent-pro/);
    const nav = within(dialog).getByRole("navigation", { name: es.nav.menu });
    // Se despliega todo: PDF Pro solo aparece una vez (arriba).
    for (const toggle of within(nav).getAllByRole("button", { name: new RegExp(es.nav.toggleSection) })) fireEvent.click(toggle);
    expect(nav.querySelectorAll("a[href='/pdf-pro']")).toHaveLength(1);
    for (const category of CATEGORY_ORDER) {
      const panel = document.getElementById(
        within(nav).getByRole("button", { name: `${es.nav.toggleSection} ${es.categories[category].label}` }).getAttribute("aria-controls")!,
      )!;
      expect(within(panel).getAllByRole("link")).toHaveLength(getToolsByCategory(category).length);
      expect(panel.querySelector("a[href='/pdf-pro']")).toBeNull();
    }
    for (const group of GROUP_ORDER) {
      const panel = document.getElementById(
        within(nav).getByRole("button", { name: `${es.nav.toggleSection} ${es.groups[group].label}` }).getAttribute("aria-controls")!,
      )!;
      // El grupo lista sus herramientas (mas, en el Downloader, las plataformas deshabilitadas: `role=link` pero sin `href`).
      expect(panel.querySelectorAll("a[href]")).toHaveLength(getToolsByGroup(group).length);
    }
  });

  it("Escanear a PDF vive en OptimusSCAN y deja de estar en «Convertir a PDF»", async () => {
    const dialog = await renderMenu();
    const nav = within(dialog).getByRole("navigation", { name: es.nav.menu });
    const scanList = within(nav).getByRole("list", { name: es.suites.scan.label });
    expect(scanList.querySelector("a[href='/scan-to-pdf']")).not.toBeNull();
    fireEvent.click(within(nav).getByRole("button", { name: `${es.nav.toggleSection} ${es.categories["convert-to"].label}` }));
    const panel = document.getElementById(
      within(nav).getByRole("button", { name: `${es.nav.toggleSection} ${es.categories["convert-to"].label}` }).getAttribute("aria-controls")!,
    )!;
    expect(panel.querySelector("a[href='/scan-to-pdf']")).toBeNull();
  });

  it("elegir PDF Pro cierra el menu", async () => {
    const dialog = await renderMenu();
    const trigger = screen.getByRole("button", { name: es.nav.menu });
    fireEvent.click(within(dialog).getByRole("link", { name: "PDF Pro" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("el objetivo tactil de la entrada mide al menos 44 px con puntero grueso (pointer-coarse:h-11)", async () => {
    const dialog = await renderMenu();
    expect(within(dialog).getByRole("link", { name: "PDF Pro" }).className).toMatch(/pointer-coarse:h-11/);
  });
});

describe("Sidebar — barra lateral", () => {
  it("el orden de arriba es «Inicio», «Recientes» y PDF Pro (plan OptimusTOOLS)", () => {
    renderSidebar();
    const nav = screen.getByRole("navigation", { name: es.nav.primaryNav });
    const links = within(nav).getAllByRole("link");
    expect(links.slice(0, 3).map((l) => l.getAttribute("href"))).toEqual(["/", "/recent", "/pdf-pro"]);
    expect(links[2].textContent).toBe("PDF Pro");
  });

  it("las seis categorias de PDF y los tres grupos de OptimusTOOLS son anclas de Home", () => {
    renderSidebar();
    for (const category of CATEGORY_ORDER) {
      expect(screen.getByRole("link", { name: es.categories[category].label }).getAttribute("href")).toBe(`/#${category}`);
    }
    for (const group of GROUP_ORDER) {
      // El nombre accesible puede llevar la insignia «Pronto» (Downloader): se comprueba que EMPIEZA por la etiqueta.
      const link = document.querySelector(`a[href='/#${group}']`)!;
      expect(link.textContent?.startsWith(es.groups[group].label)).toBe(true);
    }
    const nav = screen.getByRole("navigation", { name: es.nav.primaryNav });
    expect(within(nav).getAllByRole("link").filter((l) => l.getAttribute("href")?.startsWith("/#"))).toHaveLength(
      CATEGORY_ORDER.length + GROUP_ORDER.length,
    );
  });

  it("en /pdf-pro la entrada esta marcada como pagina actual", () => {
    pathname = "/pdf-pro";
    renderSidebar();
    expect(screen.getByRole("link", { name: "PDF Pro" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: es.nav.home }).getAttribute("aria-current")).toBeNull();
  });

  it("en otra herramienta no esta marcada", () => {
    pathname = "/merge-pdf";
    renderSidebar();
    expect(screen.getByRole("link", { name: "PDF Pro" }).getAttribute("aria-current")).toBeNull();
  });

  it("en Home solo «Inicio» esta marcada", () => {
    renderSidebar();
    expect(screen.getByRole("link", { name: "PDF Pro" }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("link", { name: es.nav.home }).getAttribute("aria-current")).toBe("page");
  });

  it("el icono de la entrada lleva el acento propio de PDF Pro", () => {
    renderSidebar();
    expect(screen.getByRole("link", { name: "PDF Pro" }).querySelector("svg")?.getAttribute("class")).toMatch(/text-accent-pro/);
  });

  it("el buscador (Spotlight) ofrece PDF Pro la primera al escribir «pdf»", () => {
    renderSidebar();
    const search = screen.getByRole("searchbox", { name: "Buscar herramienta…" });
    fireEvent.change(search, { target: { value: "pdf" } });
    const results = document.getElementById(search.getAttribute("aria-controls")!)!;
    expect(within(results).getAllByRole("link")[0].getAttribute("href")).toBe("/pdf-pro");
  });

  it("el buscador encuentra PDF Pro por su nombre exacto", () => {
    renderSidebar();
    const search = screen.getByRole("searchbox", { name: "Buscar herramienta…" });
    fireEvent.change(search, { target: { value: "pro" } });
    const results = document.getElementById(search.getAttribute("aria-controls")!)!;
    expect(within(results).getByRole("link", { name: "PDF Pro" })).toBeTruthy();
  });

  it("colapsada, la entrada sigue siendo un enlace con nombre accesible (title)", () => {
    window.localStorage.setItem("optimuspdf.sidebarCollapsed", "1");
    // El store de colapso se lee una vez por modulo: se acciona el boton real.
    renderSidebar();
    const button = screen.getByRole("button", { name: /Colapsar|Expandir/ });
    if (button.getAttribute("aria-expanded") === "true") fireEvent.click(button);
    const link = screen.getByRole("link", { name: "PDF Pro" });
    expect(link.getAttribute("title")).toBe("PDF Pro");
    fireEvent.click(screen.getByRole("button", { name: es.nav.expandSidebar }));
  });
});
