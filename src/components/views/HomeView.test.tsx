import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { HomeView } from "@/components/views/HomeView";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { CATEGORY_ORDER, TOOLS } from "@/lib/tools-registry";

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
});

function renderHome() {
  return render(
    <LanguageProvider>
      <HomeView />
    </LanguageProvider>,
  );
}

function searchbox(): HTMLInputElement {
  return screen.getByRole("searchbox", { name: "Buscar herramienta" });
}

/**
 * Buscador de Home: atajos, limpieza y resultados en vivo. El filtro puro
 * esta cubierto en ToolCatalogGrid.test.tsx; aqui se prueba la pantalla.
 */
describe("HomeView — buscador", () => {
  it("pinta el catalogo completo por categorias cuando no hay consulta", () => {
    renderHome();
    for (const category of CATEGORY_ORDER) {
      expect(document.getElementById(category)).not.toBeNull();
    }
    expect(searchbox().value).toBe("");
    expect(searchbox().getAttribute("aria-controls")).toBeTruthy();
    expect(
      document.getElementById(searchbox().getAttribute("aria-controls")!),
    ).not.toBeNull();
  });

  it("'/' enfoca el buscador y Cmd/Ctrl+K tambien", () => {
    renderHome();
    expect(document.activeElement).not.toBe(searchbox());
    fireEvent.keyDown(window, { key: "/" });
    expect(document.activeElement).toBe(searchbox());
    searchbox().blur();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(document.activeElement).toBe(searchbox());
    searchbox().blur();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(document.activeElement).toBe(searchbox());
  });

  it("'/' no roba el foco si se esta escribiendo en otro campo", () => {
    renderHome();
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    fireEvent.keyDown(other, { key: "/" });
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it("filtra en vivo, anuncia el numero de resultados y Escape limpia", () => {
    renderHome();
    fireEvent.change(searchbox(), { target: { value: "compr" } });
    const live = document.querySelector("[aria-live='polite']")!;
    expect(live.textContent).toMatch(/1 resultado/);
    expect(live.textContent).toContain("«compr»");
    expect(screen.getAllByRole("link", { name: /Comprimir PDF/ }).length).toBeGreaterThan(0);
    // Las secciones por categoria dejan de pintarse mientras se busca.
    expect(document.getElementById("organize")).toBeNull();

    fireEvent.keyDown(searchbox(), { key: "Escape" });
    expect(searchbox().value).toBe("");
    expect(document.getElementById("organize")).not.toBeNull();
  });

  it("sin resultados: estado vacio con accion de limpiar", () => {
    renderHome();
    fireEvent.change(searchbox(), { target: { value: "zzzz" } });
    expect(screen.getByText("Nada coincide con tu búsqueda")).toBeTruthy();
    // Hay dos controles con el mismo nombre accesible (la X del campo y el
    // boton del estado vacio): se pulsa el del estado vacio.
    const live = document.querySelector("[aria-live='polite']")!;
    const clear = Array.from(live.querySelectorAll("button")).find(
      (button) => button.textContent === "Borrar búsqueda",
    )!;
    fireEvent.click(clear);
    expect(searchbox().value).toBe("");
    expect(document.activeElement).toBe(searchbox());
  });

  it("Enter abre el primer resultado", () => {
    renderHome();
    fireEvent.change(searchbox(), { target: { value: "unir" } });
    fireEvent.submit(searchbox().closest("form")!);
    expect(push).toHaveBeenCalledWith("/merge-pdf");
  });

  it("Enter sin resultados no navega", () => {
    renderHome();
    fireEvent.change(searchbox(), { target: { value: "zzzz" } });
    fireEvent.submit(searchbox().closest("form")!);
    expect(push).not.toHaveBeenCalled();
  });

  it("pulsar un ancla de categoria mientras se busca limpia la consulta y desplaza a la seccion", async () => {
    const { requestSection } = await import("@/components/layout/activeSection");
    renderHome();
    fireEvent.change(searchbox(), { target: { value: "compr" } });
    expect(document.getElementById("security")).toBeNull();
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView() {
      scrolled.push((this as HTMLElement).id);
    };
    act(() => requestSection("security"));
    expect(searchbox().value).toBe("");
    expect(document.getElementById("security")).not.toBeNull();
    // (la barra de chips tambien desplaza su chip activo: se filtra por id)
    expect(scrolled.filter((id) => id === "security")).toHaveLength(1);
    // Sin busqueda activa, la peticion no toca nada.
    act(() => requestSection("organize"));
    expect(scrolled.filter((id) => id === "organize")).toHaveLength(0);
  });

  it("muestra el recuento honesto de disponibles y en camino", () => {
    renderHome();
    const live = TOOLS.filter((tool) => tool.status === "live").length;
    expect(screen.getByText(`${live} disponibles ahora`)).toBeTruthy();
    expect(screen.getByText(`${TOOLS.length - live} en camino`)).toBeTruthy();
  });
});
