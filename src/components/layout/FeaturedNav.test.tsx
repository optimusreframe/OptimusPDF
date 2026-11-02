import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Header } from "@/components/layout/Header";
import { Sidebar } from "@/components/layout/Sidebar";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { ThemeProvider } from "@/lib/theme";
import { CATEGORY_ORDER, GROUP_ORDER, getToolsByCategory, getToolsByGroup } from "@/lib/tools-registry";
import { es } from "@/lib/locales/es";

/** Menus con PDF Pro: primer item de la cabecera tablet; en la barra lateral va tras «Inicio» y «Recientes» (plan OptimusTOOLS). */

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

afterEach(() => {
  cleanup();
  pathname = "/";
});

function renderHeader() {
  render(
    <LanguageProvider>
      <Header />
    </LanguageProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Herramientas" }));
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

describe("Header — menu Herramientas", () => {
  it("PDF Pro es el PRIMER enlace de herramienta del menu, antes de cualquier categoria", () => {
    renderHeader();
    const menu = document.getElementById(screen.getByRole("button", { name: "Herramientas" }).getAttribute("aria-controls")!)!;
    const toolLinks = within(menu).getAllByRole("link");
    expect(toolLinks[0].getAttribute("href")).toBe("/pdf-pro");
    const firstCategoryHeading = within(menu).getAllByRole("heading", { level: 3 })[0];
    expect(toolLinks[0].compareDocumentPosition(firstCategoryHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("muestra nombre, descripcion y la etiqueta «Nuevo»", () => {
    renderHeader();
    const link = screen.getByRole("link", { name: /PDF Pro/ });
    expect(link.textContent).toContain("PDF Pro");
    expect(link.textContent).toContain(es.tools["pdf-pro"].description);
    expect(link.textContent).toContain(es.home.featuredBadge);
  });

  it("esta en su propia lista con nombre accesible y NO dentro de una categoria", () => {
    renderHeader();
    expect(screen.getByRole("list", { name: es.home.featuredLabel })).toBeTruthy();
    for (const category of CATEGORY_ORDER) {
      const heading = screen.getByRole("heading", { name: es.categories[category].label });
      const section = heading.closest("section")!;
      expect(section.querySelector("a[href='/pdf-pro']")).toBeNull();
      expect(within(section).getAllByRole("link")).toHaveLength(getToolsByCategory(category).length);
    }
  });

  it("tres suites (h3) con las seis categorias de PDF y los tres grupos de OptimusTOOLS (h4)", () => {
    renderHeader();
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      es.suites.pdf.label,
      es.suites.scan.label,
      es.suites.tools.label,
    ]);
    expect(screen.getAllByRole("heading", { level: 4 })).toHaveLength(CATEGORY_ORDER.length + GROUP_ORDER.length);
  });

  it("Escanear a PDF vive en OptimusSCAN y deja de estar en «Convertir a PDF»; los grupos listan sus herramientas", () => {
    renderHeader();
    const convertTo = screen.getByRole("heading", { name: es.categories["convert-to"].label }).closest("section")!;
    expect(convertTo.querySelector("a[href='/scan-to-pdf']")).toBeNull();
    const scanHeading = screen.getByRole("heading", { name: es.suites.scan.label });
    expect(scanHeading.nextElementSibling?.querySelector("a[href='/scan-to-pdf']")).not.toBeNull();
    for (const group of GROUP_ORDER) {
      const section = screen.getByRole("heading", { name: es.groups[group].label }).closest("section")!;
      expect(within(section).getAllByRole("link")).toHaveLength(getToolsByGroup(group).length);
    }
  });

  it("elegir PDF Pro cierra el menu", () => {
    renderHeader();
    const trigger = screen.getByRole("button", { name: "Herramientas" });
    fireEvent.click(screen.getByRole("link", { name: /PDF Pro/ }));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("el objetivo tactil del enlace destacado mide al menos 44 px de alto minimo", () => {
    renderHeader();
    expect(screen.getByRole("link", { name: /PDF Pro/ }).className).toMatch(/min-h-11/);
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
