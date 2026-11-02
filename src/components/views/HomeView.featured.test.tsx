import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { HomeView } from "@/components/views/HomeView";
import { filterTools } from "@/components/tool/ToolCatalogGrid";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { addRecentEntry, clearRecentEntries } from "@/lib/recent";
import { CATEGORY_ORDER, TOOLS } from "@/lib/tools-registry";
import { es } from "@/lib/locales/es";
import { en } from "@/lib/locales/en";

/** Home con PDF Pro: tarjeta destacada primera y grande, fuera de las categorias, contada en «Mas usadas». */

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/",
}));

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

beforeEach(() => {
  push.mockClear();
  window.localStorage.removeItem("optimuspdf.recent");
  clearRecentEntries();
});

afterEach(cleanup);

function renderHome() {
  return render(
    <LanguageProvider>
      <HomeView />
    </LanguageProvider>,
  );
}

const featured = () => document.querySelector<HTMLAnchorElement>("[data-featured-tool='pdf-pro']")!;

describe("Home — tarjeta destacada de PDF Pro", () => {
  it("existe, enlaza a /pdf-pro y muestra nombre, descripcion y llamada a la accion", () => {
    renderHome();
    expect(featured()).toBeTruthy();
    expect(featured().getAttribute("href")).toBe("/pdf-pro");
    expect(within(featured()).getByText("PDF Pro")).toBeTruthy();
    expect(within(featured()).getByText(es.tools["pdf-pro"].description)).toBeTruthy();
    expect(within(featured()).getByText(es.home.featuredCta)).toBeTruthy();
    expect(within(featured()).getByText(es.home.featuredBadge)).toBeTruthy();
  });

  it("es un unico enlace con nombre y descripcion accesibles", () => {
    renderHome();
    const link = screen.getByRole("link", { name: /^PDF Pro/ });
    expect(link).toBe(featured());
    expect(link.getAttribute("aria-labelledby")).toBeTruthy();
    const description = document.getElementById(link.getAttribute("aria-describedby")!);
    expect(description?.textContent).toBe(es.tools["pdf-pro"].description);
    expect(link.querySelectorAll("a, button")).toHaveLength(0);
  });

  it("va ANTES del catalogo: precede a la primera categoria y a «Unir PDF»", () => {
    renderHome();
    const organize = document.getElementById("organize")!;
    expect(featured().compareDocumentPosition(organize) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const merge = screen.getAllByRole("link", { name: /Unir PDF/ })[0];
    expect(featured().compareDocumentPosition(merge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("va despues del buscador (el campo no se mueve)", () => {
    renderHome();
    const search = screen.getByRole("searchbox", { name: "Buscar herramienta" });
    expect(search.compareDocumentPosition(featured()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("es la primera tarjeta de herramienta de toda la pagina", () => {
    renderHome();
    const toolLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href^='/']")).filter((a) =>
      TOOLS.some((tool) => a.getAttribute("href") === `/${tool.slug}`),
    );
    expect(toolLinks[0].getAttribute("href")).toBe("/pdf-pro");
  });

  it("NO aparece dentro de ninguna seccion de categoria (sin categoria nueva)", () => {
    renderHome();
    for (const category of CATEGORY_ORDER) {
      const section = document.getElementById(category)!;
      expect(section.querySelector("a[href='/pdf-pro']")).toBeNull();
    }
    expect(document.querySelectorAll("a[href='/pdf-pro']")).toHaveLength(1);
  });

  it("las seis categorias siguen siendo las de siempre", () => {
    renderHome();
    expect(CATEGORY_ORDER).toHaveLength(6);
    for (const category of CATEGORY_ORDER) expect(document.getElementById(category)).not.toBeNull();
  });

  it("lista lo que cubre (Paginas, Editar, Firmar, Proteger, Convertir) como decoracion oculta al lector", () => {
    renderHome();
    const decorative = Array.from(featured().querySelectorAll("[aria-hidden='true']")).filter(
      (node) => /Páginas/.test(node.textContent ?? "") && /Convertir/.test(node.textContent ?? ""),
    );
    expect(decorative.length).toBeGreaterThan(0);
    for (const word of ["Páginas", "Editar", "Firmar", "Proteger", "Convertir"]) {
      expect(decorative[0].textContent).toContain(word);
    }
  });

  it("es una tarjeta GRANDE: ancho completo del contenido y mayor que una tarjeta normal", () => {
    renderHome();
    expect(featured().className).toMatch(/rounded-ios-lg/);
    expect(featured().className).toMatch(/p-5/);
    expect(featured().className).toMatch(/md:p-7/);
    const normal = screen.getAllByRole("link", { name: /Unir PDF/ })[0];
    expect(normal.className).not.toMatch(/rounded-ios-lg/);
  });

  it("el recuento de disponibles incluye PDF Pro", () => {
    renderHome();
    const live = TOOLS.filter((tool) => tool.status === "live").length;
    expect(screen.getByText(`${live} disponibles ahora`)).toBeTruthy();
    // 37 desde «Extraer elementos» (`extract-assets`): 38 slugs de PDF menos `powerpoint-to-pdf`, que sigue «en camino». Las de
    // OptimusTOOLS se cuentan aparte: sus duenas las pasan a `live` al integrar y este numero no debe depender de ello.
    expect(TOOLS.filter((tool) => tool.suite !== "tools" && tool.status === "live")).toHaveLength(37);
  });

  it("la region tiene nombre accesible", () => {
    renderHome();
    expect(screen.getByRole("region", { name: es.home.featuredLabel })).toBeTruthy();
  });
});

describe("Home — la tarjeta destacada y el buscador", () => {
  const searchbox = () => screen.getByRole("searchbox", { name: "Buscar herramienta" }) as HTMLInputElement;

  it("mientras se busca, la tarjeta grande se retira y PDF Pro compite como una herramienta mas", () => {
    renderHome();
    fireEvent.change(searchbox(), { target: { value: "pro" } });
    expect(featured()).toBeNull();
    expect(screen.getAllByRole("link", { name: /PDF Pro/ }).length).toBeGreaterThan(0);
  });

  it("buscar «pdf pro» o «todo en uno» encuentra PDF Pro la primera", () => {
    expect(filterTools("pdf pro", es)[0].slug).toBe("pdf-pro");
    expect(filterTools("todo en uno", es)[0].slug).toBe("pdf-pro");
    expect(filterTools("all in one", en)[0].slug).toBe("pdf-pro");
  });

  it("buscar «firma» o «organiza» tambien la ofrece (esta en su descripcion)", () => {
    expect(filterTools("firma", es).map((t) => t.slug)).toContain("pdf-pro");
    expect(filterTools("organiza", es).map((t) => t.slug)).toContain("pdf-pro");
  });

  it("Enter con «pro» abre /pdf-pro", () => {
    renderHome();
    fireEvent.change(searchbox(), { target: { value: "pdf pro" } });
    fireEvent.submit(searchbox().closest("form")!);
    expect(push).toHaveBeenCalledWith("/pdf-pro");
  });

  it("al limpiar la busqueda vuelve la tarjeta destacada", () => {
    renderHome();
    fireEvent.change(searchbox(), { target: { value: "zzz" } });
    expect(featured()).toBeNull();
    fireEvent.keyDown(searchbox(), { key: "Escape" });
    expect(featured()).not.toBeNull();
  });

  it("una consulta vacia devuelve TODO el catalogo con PDF Pro la primera", () => {
    const all = filterTools("", es);
    expect(all).toEqual(TOOLS);
    expect(all[0].slug).toBe("pdf-pro");
  });
});

describe("Home — «Mas usadas» cuenta PDF Pro", () => {
  it("una entrada reciente de pdf-pro aparece en «Mas usadas» con su archivo", () => {
    act(() => addRecentEntry("pdf-pro", "contrato.pdf"));
    renderHome();
    const section = screen.getByRole("heading", { name: es.home.mostUsedTitle }).closest("section")!;
    expect(within(section).getByText("PDF Pro")).toBeTruthy();
    expect(within(section).getByText("contrato.pdf")).toBeTruthy();
    expect(within(section).getByRole("link", { name: /PDF Pro/ }).getAttribute("href")).toBe("/pdf-pro");
  });

  it("se ordena por uso real: PDF Pro usada mas veces va antes que otra con menos", () => {
    act(() => {
      addRecentEntry("merge-pdf", "a.pdf");
      addRecentEntry("pdf-pro", "b.pdf");
      addRecentEntry("pdf-pro", "c.pdf");
    });
    renderHome();
    const section = screen.getByRole("heading", { name: es.home.mostUsedTitle }).closest("section")!;
    const links = within(section).getAllByRole("link").filter((l) => l.getAttribute("href") !== "/recent");
    expect(links[0].getAttribute("href")).toBe("/pdf-pro");
  });

  it("sin uso previo no hay seccion «Mas usadas»", () => {
    renderHome();
    expect(screen.queryByRole("heading", { name: es.home.mostUsedTitle })).toBeNull();
  });
});
