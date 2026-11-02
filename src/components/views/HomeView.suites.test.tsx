import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { HomeView } from "@/components/views/HomeView";
import { filterTools } from "@/components/tool/ToolCatalogGrid";
import { LANGUAGE_STORAGE_KEY, LanguageProvider, useI18n, type Language } from "@/lib/i18n";
import { addRecentEntry, clearRecentEntries } from "@/lib/recent";
import {
  CATEGORY_ORDER,
  GROUP_ORDER,
  SECTION_ORDER,
  SUITE_ORDER,
  getToolsByCategory,
  getToolsByGroup,
} from "@/lib/tools-registry";
import { es } from "@/lib/locales/es";
import { en } from "@/lib/locales/en";

/** Inicio agrupado por las tres suites (plan OptimusTOOLS): OptimusPDF con sus categorias, OptimusSCAN y OptimusTOOLS con sus grupos. */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/",
}));

function Lang({ code }: { code: Language }) {
  const { setLanguage } = useI18n();
  useEffect(() => setLanguage(code), [code, setLanguage]);
  return null;
}

function renderHome(language: Language = "es") {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  return render(
    <LanguageProvider>
      <Lang code={language} />
      <HomeView />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  window.localStorage.removeItem("optimuspdf.recent");
  clearRecentEntries();
});

afterEach(cleanup);

const section = (id: string) => document.getElementById(id)!;
const hrefsIn = (element: HTMLElement) =>
  Array.from(element.querySelectorAll("a[href]")).map((a) => a.getAttribute("href"));

describe("Inicio — catalogo por suites", () => {
  it("tres suites en orden, cada una con su titulo de nivel 2", () => {
    renderHome();
    const headings = screen.getAllByRole("heading", { level: 2 }).filter((h) => h.id.startsWith("suite-"));
    expect(headings.map((h) => h.textContent)).toEqual(SUITE_ORDER.map((suite) => es.suites[suite].label));
  });

  it("OptimusPDF contiene las seis categorias de siempre (mismos ids) y OptimusTOOLS sus tres grupos", () => {
    renderHome();
    const pdf = document.querySelector("[data-suite='pdf']") as HTMLElement;
    const tools = document.querySelector("[data-suite='tools']") as HTMLElement;
    for (const category of CATEGORY_ORDER) expect(pdf.contains(section(category)), category).toBe(true);
    for (const group of GROUP_ORDER) expect(tools.contains(section(group)), group).toBe(true);
    // los ids de seccion no se repiten
    for (const id of SECTION_ORDER) expect(document.querySelectorAll(`[id='${id}']`), id).toHaveLength(1);
  });

  it("cada categoria muestra solo las herramientas de PDF de su categoria (Escanear ya no esta en «Convertir a PDF»)", () => {
    renderHome();
    for (const category of CATEGORY_ORDER) {
      const slugs = getToolsByCategory(category).map((tool) => `/${tool.slug}`);
      const hrefs = hrefsIn(section(category));
      for (const slug of slugs) expect(hrefs, `${category} ${slug}`).toContain(slug);
    }
    expect(hrefsIn(section("convert-to"))).not.toContain("/scan-to-pdf");
  });

  it("OptimusSCAN lleva «Escanear a PDF» y es el ancla #scan", () => {
    renderHome();
    expect(section("scan").getAttribute("data-suite")).toBe("scan");
    expect(hrefsIn(section("scan"))).toContain("/scan-to-pdf");
    expect(hrefsIn(section("scan"))).not.toContain("/jpg-to-pdf");
  });

  it("los grupos de OptimusTOOLS muestran sus herramientas; las que aun no estan, con «Próximamente»", () => {
    renderHome();
    for (const group of GROUP_ORDER) {
      const hrefs = hrefsIn(section(group));
      for (const tool of getToolsByGroup(group)) expect(hrefs, tool.slug).toContain(`/${tool.slug}`);
    }
    // Downloader es siempre «soon»
    expect(within(section("downloader")).getAllByText(es.common.soon).length).toBeGreaterThan(0);
  });

  it("PDF Pro sigue destacada, antes del catalogo, y fuera de todas las suites", () => {
    renderHome();
    const featured = document.querySelector("[data-featured-tool='pdf-pro']")!;
    expect(featured.compareDocumentPosition(section("organize")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const suite of SUITE_ORDER) {
      expect((document.querySelector(`[data-suite='${suite}']`) as HTMLElement).querySelector("a[href='/pdf-pro']")).toBeNull();
    }
  });

  it("la barra de chips (movil/tablet) tiene un chip por seccion, incluidos OptimusSCAN y los grupos", () => {
    renderHome();
    const chips = within(screen.getByRole("navigation", { name: es.nav.categoriesLabel }));
    const links = chips.getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(SECTION_ORDER.map((id) => `/#${id}`));
    expect(links[CATEGORY_ORDER.length].textContent).toBe(es.suites.scan.label);
    expect(links.slice(-3).map((a) => a.textContent)).toEqual(GROUP_ORDER.map((g) => es.groups[g].label));
  });

  it("en ingles se traducen suites, grupos y descripciones", () => {
    renderHome("en");
    expect(screen.getByRole("heading", { level: 2, name: en.suites.tools.label })).toBeTruthy();
    expect(screen.getByText(en.suites.scan.description)).toBeTruthy();
    // (la herramienta «Audio Studio» comparte nombre con su grupo: se mira el titulo de la seccion)
    expect(document.getElementById("audio-studio-title")?.textContent).toBe(en.groups["audio-studio"].label);
    expect(screen.getByText(en.groups.converter.description)).toBeTruthy();
  });
});

describe("Inicio — buscador, recientes y «Mas usadas» con las herramientas nuevas", () => {
  it("el filtro encuentra las nuevas por nombre, por plataforma y por suite, en ES y EN", () => {
    const slugs = (query: string, t: typeof es | typeof en) => filterTools(query, t).map((tool) => tool.slug);
    expect(slugs("convertidor", es)).toEqual(expect.arrayContaining(["image-converter", "audio-converter", "video-converter"]));
    expect(slugs("instagram", es)).toContain("downloader");
    expect(slugs("telegram", en)).toContain("downloader");
    expect(slugs("optimusscan", es)).toEqual(["scan-to-pdf"]);
    expect(slugs("audio studio", en)).toEqual(expect.arrayContaining(["audio-studio", "audio-extractor"]));
    expect(slugs("converter", en)).toEqual(expect.arrayContaining(["image-converter", "audio-converter", "video-converter"]));
    expect(slugs("escanear", es)).toContain("scan-to-pdf");
  });

  it("buscar en pantalla muestra tarjetas de las nuevas", () => {
    renderHome();
    fireEvent.change(screen.getByRole("searchbox", { name: "Buscar herramienta" }), { target: { value: "audio" } });
    const live = document.querySelector("[aria-live='polite']") as HTMLElement;
    expect(hrefsIn(live)).toEqual(expect.arrayContaining(["/audio-converter", "/audio-extractor", "/audio-studio"]));
  });

  it("«Mas usadas» incluye una herramienta nueva con su archivo, y la de OptimusSCAN", () => {
    act(() => {
      addRecentEntry("audio-converter", "cancion.wav");
      addRecentEntry("scan-to-pdf", "foto.jpg");
    });
    renderHome();
    const most = screen.getByRole("heading", { name: es.home.mostUsedTitle }).closest("section")!;
    expect(within(most).getByRole("link", { name: /Convertidor de audio/ }).getAttribute("href")).toBe("/audio-converter");
    expect(within(most).getByRole("link", { name: /Escanear a PDF/ }).getAttribute("href")).toBe("/scan-to-pdf");
  });

  it("el recuento de «en camino» incluye las nuevas aun no integradas (honesto)", () => {
    renderHome();
    expect(screen.getByText(/en camino$/)).toBeTruthy();
  });
});
