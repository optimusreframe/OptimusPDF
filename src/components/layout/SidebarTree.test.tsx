import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Sidebar } from "@/components/layout/Sidebar";
import { setActiveSection } from "@/components/layout/activeSection";
import { SECTIONS_STORAGE_KEY, resetSidebarSectionsForTests } from "@/components/layout/SidebarTree";
import { LANGUAGE_STORAGE_KEY, LanguageProvider, useI18n, type Language } from "@/lib/i18n";
import { THEME_STORAGE_KEY, ThemeProvider } from "@/lib/theme";
import {
  CATEGORY_ORDER,
  DOWNLOADER_PLATFORMS,
  GROUP_ORDER,
  SECTION_ORDER,
  SUITE_ORDER,
  TOOL_SLUGS,
  getTool,
  getToolsByCategory,
  getToolsByGroup,
} from "@/lib/tools-registry";
import { es } from "@/lib/locales/es";
import { en } from "@/lib/locales/en";

/**
 * Barra lateral con suites (plan OptimusTOOLS): OptimusPDF con sus seis categorias desplegables, OptimusSCAN y OptimusTOOLS
 * con sus grupos; entradas «soon» con insignia, plataformas del Downloader deshabilitadas, idioma y tema al pie.
 */

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

/** El idioma vive en un store con cache: se fija por el propio contexto. */
function Lang({ code }: { code: Language }) {
  const { setLanguage } = useI18n();
  useEffect(() => setLanguage(code), [code, setLanguage]);
  return null;
}

function renderSidebar(language: Language = "es") {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  return render(
    <ThemeProvider>
      <LanguageProvider>
        <Lang code={language} />
        <Sidebar />
      </LanguageProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  pathname = "/";
  window.sessionStorage.clear();
  window.localStorage.removeItem("optimuspdf.sidebarCollapsed");
  resetSidebarSectionsForTests();
});

afterEach(() => {
  act(() => setActiveSection(null));
  cleanup();
});

const nav = () => screen.getByRole("navigation", { name: es.nav.primaryNav });
const toggle = (label: string) => screen.getByRole("button", { name: `${es.nav.toggleSection} ${label}` });

describe("Sidebar — suites", () => {
  it("las tres suites aparecen en orden, cada una con su lista nombrada", () => {
    renderSidebar();
    const lists = SUITE_ORDER.map((suite) => within(nav()).getByRole("list", { name: es.suites[suite].label }));
    expect(lists).toHaveLength(3);
    const order = lists.map((list) => list.compareDocumentPosition(lists[0]));
    expect(order[1] & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    // El rotulo «Categorías» nombra la lista de suites.
    expect(within(nav()).getByRole("list", { name: es.nav.categoriesLabel })).toBeTruthy();
  });

  it("OptimusPDF: sus seis categorias son desplegables, cerradas por defecto y con el estado en aria-expanded", () => {
    renderSidebar();
    for (const category of CATEGORY_ORDER) {
      const button = toggle(es.categories[category].label);
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("aria-expanded")).toBe("false");
      // nada controlado todavia: no hay idref colgado
      expect(button.hasAttribute("aria-controls")).toBe(false);
    }
    expect(screen.queryByRole("link", { name: "Unir PDF" })).toBeNull();
  });

  it("desplegar muestra sus herramientas, aria-controls apunta al panel real y volver a pulsar lo pliega", () => {
    renderSidebar();
    const button = toggle(es.categories.organize.label);
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(button.getAttribute("aria-controls")!)!;
    expect(panel).not.toBeNull();
    expect(within(panel).getAllByRole("link")).toHaveLength(getToolsByCategory("organize").length);
    expect(within(panel).getByRole("link", { name: "Unir PDF" }).getAttribute("href")).toBe("/merge-pdf");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.hasAttribute("aria-controls")).toBe(false);
    expect(screen.queryByRole("link", { name: "Unir PDF" })).toBeNull();
  });

  it("la eleccion de secciones abiertas se recuerda durante la sesion", () => {
    const first = renderSidebar();
    fireEvent.click(toggle(es.categories.security.label));
    expect(JSON.parse(window.sessionStorage.getItem(SECTIONS_STORAGE_KEY)!)).toEqual({ security: true });
    first.unmount();
    resetSidebarSectionsForTests(); // «recarga»: vuelve a leer del almacenamiento
    renderSidebar();
    expect(toggle(es.categories.security.label).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: "Proteger PDF" })).toBeTruthy();
  });

  it("en la ruta de una herramienta su seccion arranca abierta y la herramienta es la pagina actual", () => {
    pathname = "/merge-pdf";
    renderSidebar();
    expect(toggle(es.categories.organize.label).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: "Unir PDF" }).getAttribute("aria-current")).toBe("page");
    expect(toggle(es.categories.security.label).getAttribute("aria-expanded")).toBe("false");
    // y se puede cerrar aunque contenga la pagina actual
    fireEvent.click(toggle(es.categories.organize.label));
    expect(screen.queryByRole("link", { name: "Unir PDF" })).toBeNull();
  });

  it("las dos listas guardadas no se mezclan: «audio-studio» como herramienta y como grupo son entradas distintas", () => {
    pathname = "/audio-studio";
    renderSidebar();
    const group = document.querySelector("a[href='/#audio-studio']")!;
    const tool = document.querySelector("a[href='/audio-studio']")!;
    expect(group).not.toBe(tool);
    expect(group.getAttribute("aria-current")).toBeNull();
    expect(tool.getAttribute("aria-current")).toBe("page");
  });
});

describe("Sidebar — OptimusSCAN", () => {
  it("«Escanear a PDF» es un enlace directo de OptimusSCAN y ya no esta dentro de «Convertir a PDF»", () => {
    renderSidebar();
    const scanList = within(nav()).getByRole("list", { name: es.suites.scan.label });
    expect(within(scanList).getByRole("link", { name: es.tools["scan-to-pdf"].name }).getAttribute("href")).toBe("/scan-to-pdf");
    fireEvent.click(toggle(es.categories["convert-to"].label));
    const panel = document.getElementById(toggle(es.categories["convert-to"].label).getAttribute("aria-controls")!)!;
    expect(panel.querySelector("a[href='/scan-to-pdf']")).toBeNull();
  });

  it("en /scan-to-pdf la entrada es la pagina actual", () => {
    pathname = "/scan-to-pdf";
    renderSidebar();
    expect(screen.getByRole("link", { name: es.tools["scan-to-pdf"].name }).getAttribute("aria-current")).toBe("page");
  });

  it("en Inicio, cuando el scroll-spy dice «scan», la entrada se marca como actual", () => {
    renderSidebar();
    expect(screen.getByRole("link", { name: es.tools["scan-to-pdf"].name }).getAttribute("aria-current")).toBeNull();
    act(() => setActiveSection("scan"));
    expect(screen.getByRole("link", { name: es.tools["scan-to-pdf"].name }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: es.nav.home }).getAttribute("aria-current")).toBeNull();
  });
});

describe("Sidebar — OptimusTOOLS", () => {
  it("lleva Downloader, Audio Studio y Converter (anclas de Inicio) y una entrada «Próximamente…» deshabilitada", () => {
    renderSidebar();
    const toolsList = within(nav()).getByRole("list", { name: es.suites.tools.label });
    for (const group of GROUP_ORDER) {
      const link = toolsList.querySelector(`a[href='/#${group}']`)!;
      expect(link.textContent?.startsWith(es.groups[group].label)).toBe(true);
      expect(toggle(es.groups[group].label).getAttribute("aria-expanded")).toBe("false");
    }
    // «Próximamente…» es una nota: ni enlace ni boton.
    const more = within(toolsList).getByText(es.nav.moreSoon);
    expect(more.closest("a")).toBeNull();
    expect(more.closest("button")).toBeNull();
  });

  it("el Downloader es «Pronto» tambien en su fila", () => {
    renderSidebar();
    const row = document.querySelector("a[href='/#downloader']")!;
    expect(row.textContent).toContain(es.nav.soonShort);
  });

  it("las seis plataformas del Downloader son entradas DESHABILITADAS: sin enlace, sin foco, con «Pronto»", () => {
    renderSidebar();
    fireEvent.click(toggle(es.groups.downloader.label));
    expect([...DOWNLOADER_PLATFORMS]).toEqual(["Instagram", "Facebook", "TikTok", "X", "Threads", "Telegram"]);
    for (const name of DOWNLOADER_PLATFORMS) {
      const entry = screen.getByText(name).closest("[aria-disabled]") as HTMLElement;
      expect(entry, name).not.toBeNull();
      expect(entry.getAttribute("aria-disabled")).toBe("true");
      expect(entry.hasAttribute("href")).toBe(false);
      expect(entry.closest("a[href]")).toBeNull();
      expect(entry.hasAttribute("tabindex")).toBe(false);
      expect(entry.textContent).toContain(es.nav.soonShort);
    }
  });

  it("la pagina del Downloader si es un enlace (con «Pronto»), asi nunca hay un 404 desde la barra", () => {
    renderSidebar();
    fireEvent.click(toggle(es.groups.downloader.label));
    const link = document.querySelector("aside a[href='/downloader']") as HTMLElement;
    expect(link).not.toBeNull();
    expect(link.textContent).toContain(es.nav.soonShort);
  });

  it("cada herramienta del grupo se muestra segun su status: live = enlace normal, soon = enlace con «Pronto»", () => {
    renderSidebar();
    for (const group of GROUP_ORDER) fireEvent.click(toggle(es.groups[group].label));
    for (const group of GROUP_ORDER) {
      for (const tool of getToolsByGroup(group)) {
        const link = document.querySelector(`a[href='/${tool.slug}']`) as HTMLAnchorElement;
        expect(link, tool.slug).not.toBeNull();
        expect(link.textContent?.includes(es.nav.soonShort), tool.slug).toBe(tool.status === "soon");
      }
    }
  });

  it("el orden de los grupos sigue el plan: Extraer audio antes que Audio Studio; Audio, Imagen, Video en Converter", () => {
    renderSidebar();
    for (const group of GROUP_ORDER) fireEvent.click(toggle(es.groups[group].label));
    const hrefs = Array.from(within(nav()).getByRole("list", { name: es.suites.tools.label }).querySelectorAll("a[href]"))
      .map((a) => a.getAttribute("href"))
      .filter((href) => href && !href.startsWith("/#"));
    expect(hrefs).toEqual([
      "/downloader",
      "/audio-extractor",
      "/audio-studio",
      "/audio-converter",
      "/image-converter",
      "/video-converter",
    ]);
  });
});

describe("Sidebar — sin enlaces rotos", () => {
  it("con todas las secciones abiertas, cada enlace apunta a una ruta o ancla que existe", () => {
    renderSidebar();
    for (const button of screen.getAllByRole("button", { name: new RegExp(`^${es.nav.toggleSection} `) })) {
      if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
    }
    const pages = new Set(["/", "/recent", "/documents", "/settings", "/pricing", "/about", "/licenses"]);
    const links = Array.from(document.querySelectorAll("aside a[href]"));
    expect(links.length).toBeGreaterThan(40);
    for (const link of links) {
      const href = link.getAttribute("href")!;
      const ok =
        pages.has(href) ||
        (href.startsWith("/#") && (SECTION_ORDER as string[]).includes(href.slice(2))) ||
        (TOOL_SLUGS as readonly string[]).includes(href.slice(1));
      expect(ok, href).toBe(true);
    }
    // ninguna entrada deshabilitada se ha colado como enlace
    for (const name of DOWNLOADER_PLATFORMS) {
      expect(screen.queryByRole("link", { name: new RegExp(`^${name}`) })?.hasAttribute("href") ?? false).toBe(false);
    }
  });

  it("cada herramienta del registro es alcanzable desde la barra (abiertas todas las secciones)", () => {
    renderSidebar();
    for (const button of screen.getAllByRole("button", { name: new RegExp(`^${es.nav.toggleSection} `) })) {
      if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
    }
    for (const slug of TOOL_SLUGS) {
      expect(document.querySelector(`aside a[href='/${slug}']`), slug).not.toBeNull();
    }
  });
});

describe("Sidebar — parte alta, pie y teclado", () => {
  it("arriba: Inicio, Recientes y PDF Pro; luego CATEGORIAS; abajo Exportar/Importar, Ajustes, Precios, Proyecto y Licencias", () => {
    renderSidebar();
    const hrefs = Array.from(nav().querySelectorAll("a[href]")).map((a) => a.getAttribute("href"));
    expect(hrefs.slice(0, 3)).toEqual(["/", "/recent", "/pdf-pro"]);
    expect(hrefs.slice(-5)).toEqual(["/documents", "/settings", "/pricing", "/about", "/licenses"]);
    expect(screen.getByText(es.nav.backupLabel)).toBeTruthy();
    expect(hrefs.indexOf("/#organize")).toBeGreaterThan(hrefs.indexOf("/pdf-pro"));
  });

  it("Recientes se marca como actual en /recent", () => {
    pathname = "/recent";
    renderSidebar();
    expect(screen.getByRole("link", { name: es.nav.recent }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: es.nav.home }).getAttribute("aria-current")).toBeNull();
  });

  it("el pie lleva el idioma ES/EN y Claro/Oscuro/Sistema; elegir tema lo aplica y lo guarda", () => {
    renderSidebar();
    const footer = screen.getByRole("group", { name: es.common.language }).closest("div[class*='border-t']")!;
    expect(within(footer as HTMLElement).getByRole("button", { name: "ES" })).toBeTruthy();
    const themes = screen.getByRole("tablist", { name: es.nav.themeLabel });
    expect(within(themes).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Claro", "Oscuro", "Sistema"]);
    fireEvent.click(within(themes).getByRole("tab", { name: "Oscuro" }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(within(themes).getByRole("tab", { name: "Oscuro" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(within(themes).getByRole("tab", { name: "Claro" }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("cambiar el idioma de la barra la traduce entera (ES -> EN)", () => {
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "EN" }));
    expect(screen.getByRole("list", { name: en.suites.tools.label })).toBeTruthy();
    expect(screen.getByText(en.nav.backupLabel)).toBeTruthy();
    expect(screen.getByText(en.nav.moreSoon)).toBeTruthy();
    expect(screen.getByRole("button", { name: `${en.nav.toggleSection} ${en.categories.organize.label}` })).toBeTruthy();
    expect(screen.getByRole("tablist", { name: en.nav.themeLabel })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ES" }));
  });

  it("los desplegables son botones nativos alcanzables con Tab (Enter/Espacio los activan de serie)", () => {
    renderSidebar();
    for (const button of screen.getAllByRole("button", { name: new RegExp(`^${es.nav.toggleSection} `) })) {
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("type")).toBe("button");
      expect(button.tabIndex).toBeGreaterThanOrEqual(0);
    }
  });

  it("el buscador encuentra el Downloader por una plataforma («instagram») y marca «Pronto»", () => {
    renderSidebar();
    const search = screen.getByRole("searchbox", { name: es.nav.searchPlaceholder });
    fireEvent.change(search, { target: { value: "downl" } });
    const results = document.getElementById(search.getAttribute("aria-controls")!)!;
    const link = within(results).getByRole("link", { name: /Downloader/ });
    expect(link.getAttribute("href")).toBe("/downloader");
    expect(link.textContent).toContain(es.nav.soonShort);
  });

  it("el buscador sigue encontrando «Escanear a PDF» y las herramientas nuevas", () => {
    renderSidebar();
    const search = screen.getByRole("searchbox", { name: es.nav.searchPlaceholder });
    fireEvent.change(search, { target: { value: "escanear" } });
    expect(within(document.getElementById(search.getAttribute("aria-controls")!)!).getByRole("link").getAttribute("href")).toBe("/scan-to-pdf");
    fireEvent.change(search, { target: { value: "convertidor" } });
    const hrefs = within(document.getElementById(search.getAttribute("aria-controls")!)!)
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(expect.arrayContaining(["/image-converter", "/audio-converter", "/video-converter"]));
  });
});

describe("Sidebar — plegada (riel de iconos)", () => {
  it("solo quedan iconos-enlace con title; sin desplegables ni entradas deshabilitadas; scan y los grupos siguen alcanzables", () => {
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: es.nav.collapseSidebar }));
    try {
      expect(screen.queryAllByRole("button", { name: new RegExp(`^${es.nav.toggleSection} `) })).toHaveLength(0);
      expect(screen.queryByText(es.nav.moreSoon)).toBeNull();
      expect(screen.queryByText("Instagram")).toBeNull();
      expect(screen.getByRole("link", { name: new RegExp(es.tools["scan-to-pdf"].name) }).getAttribute("href")).toBe("/scan-to-pdf");
      for (const section of SECTION_ORDER.filter((id) => id !== "scan")) {
        const link = document.querySelector(`aside a[href='/#${section}']`) as HTMLElement;
        expect(link, section).not.toBeNull();
        expect(link.getAttribute("title")).toBeTruthy();
      }
    } finally {
      fireEvent.click(screen.getByRole("button", { name: es.nav.expandSidebar }));
    }
  });
});

describe("Sidebar — datos del registro", () => {
  it("Downloader es siempre «soon» (decision del usuario: no se construye)", () => {
    expect(getTool("downloader").status).toBe("soon");
  });
});
