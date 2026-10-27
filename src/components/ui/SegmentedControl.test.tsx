import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "./SegmentedControl";

const OPTIONS = [
  { value: "draw", label: "Dibujar" },
  { value: "type", label: "Escribir" },
  { value: "upload", label: "Subir" },
] as const;

type Mode = (typeof OPTIONS)[number]["value"];

describe("SegmentedControl", () => {
  it("expone tablist con nombre y tabs con aria-selected", () => {
    render(
      <SegmentedControl<Mode>
        label="Modo"
        options={[...OPTIONS]}
        value="type"
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole("tablist", { name: "Modo" })).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    // Roving tabindex: solo el activo entra en el orden de tabulacion.
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
    expect(screen.getByRole("tab", { name: "Escribir" })).toBe(tabs[1]);
  });

  it("click llama a onChange con el valor", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl<Mode> options={[...OPTIONS]} value="draw" onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Subir" }));
    expect(onChange).toHaveBeenCalledWith("upload");
  });

  it("flechas, Home y End mueven la seleccion (con vuelta) y el foco", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl<Mode> options={[...OPTIONS]} value="type" onChange={onChange} />,
    );
    const active = screen.getByRole("tab", { name: "Escribir" });
    active.focus();
    fireEvent.keyDown(active, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("upload");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Subir" }));

    fireEvent.keyDown(active, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("draw");

    fireEvent.keyDown(active, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("draw");
    fireEvent.keyDown(active, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("upload");
  });

  it("ArrowLeft en el primero da la vuelta al ultimo", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl<Mode> options={[...OPTIONS]} value="draw" onChange={onChange} />,
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: "Dibujar" }), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("upload");
  });

  it("el pulgar es un elemento decorativo con ancho proporcional; sin tipografia HUD", () => {
    const { container } = render(
      <SegmentedControl<Mode> options={[...OPTIONS]} value="draw" onChange={() => {}} />,
    );
    const thumb = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    // jsdom normaliza el calc (0.333 * (100% - 0.5rem)); lo que importa es la fraccion.
    expect(thumb.style.width).toMatch(/100% - 0\.5rem/);
    expect(container.innerHTML).not.toMatch(new RegExp("font-mono|uppercase|hud" + "-label"));
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.className).toMatch(/active:scale-\[0\.96\]/);
    }
  });
});

describe("SegmentedControl: tacto", () => {
  it("cada tab transiciona `scale` y ocupa la altura entera de la pista (h-full)", () => {
    render(
      <SegmentedControl<Mode> options={[...OPTIONS]} value="draw" onChange={() => {}} />,
    );
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.className).toMatch(/transition-\[[^\]]*scale[^\]]*\]/);
      expect(tab.className).toMatch(/\bh-full\b/);
    }
    expect(screen.getByRole("tablist").className).not.toMatch(/\bp-1\b/);
  });
});

/*
 * Etiquetas largas (W1-D): en un panel de opciones de 280 px un segmentado con
 * 3-4 opciones obligaba a truncar ("Espa…", "Portu…"). Las pestañas pasan a
 * dos lineas en vez de recortar. jsdom no hace layout: el contrato se
 * comprueba por clases (la medida real, en navegador, esta en la matriz de
 * truncamientos de W1-D).
 */
describe("SegmentedControl: etiquetas largas sin truncar", () => {
  const LONG = [
    { value: "a", label: "Solo la página visible" },
    { value: "b", label: "Todas las páginas" },
    { value: "c", label: "Portugués" },
    { value: "d", label: "Blanco y negro" },
  ] as const;
  type Long = (typeof LONG)[number]["value"];

  it("las pestañas nunca truncan ni recortan: texto con wrap, title con la etiqueta completa y sin span.truncate", () => {
    const { container } = render(
      <SegmentedControl<Long> options={[...LONG]} value="a" onChange={() => {}} />,
    );
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.className).not.toMatch(/\btruncate\b|whitespace-nowrap|overflow-hidden|text-ellipsis|text-clip/);
      expect(tab.className).toMatch(/\bwhitespace-normal\b/);
      expect(tab.className).toMatch(/\bleading-tight\b/);
      expect(tab.className).toMatch(/\btext-center\b/);
      expect(tab.getAttribute("title")).toBe(tab.textContent);
      expect(tab.querySelector('.truncate, [class*="overflow-hidden"]')).toBeNull();
    }
    expect(container.querySelector(".truncate")).toBeNull();
  });

  it("la pista crece con la etiqueta (min-h, sin altura fija) y el pulgar sigue absoluto, inset-y-1 y con ancho por nº de segmentos", () => {
    const { container, rerender } = render(
      <SegmentedControl<Long> options={[...LONG]} value="b" onChange={() => {}} />,
    );
    const list = screen.getByRole("tablist");
    expect(list.className).toMatch(/\bmin-h-11\b/);
    expect(list.className).not.toMatch(/(^|\s)h-(9|11)(\s|$)/);
    const thumb = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(thumb.className).toMatch(/\babsolute\b/);
    expect(thumb.className).toMatch(/\binset-y-1\b/);
    // 4 segmentos: un cuarto de (100% - 0.5rem), sin depender del contenido
    expect(thumb.style.width).toMatch(/0\.25|\/ 4/);

    rerender(
      <SegmentedControl<Long> options={[...LONG].slice(0, 2)} value="a" onChange={() => {}} size="sm" />,
    );
    expect(screen.getByRole("tablist").className).toMatch(/\bmin-h-9\b/);
  });

  it("padding horizontal estrecho (px-1) y tipografia: caption con 4+ opciones en md, footnote en sm, subheadline con menos", () => {
    const { rerender } = render(
      <SegmentedControl<Long> options={[...LONG]} value="a" onChange={() => {}} />,
    );
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.className).toMatch(/\bpx-1\b/);
      expect(tab.className).toMatch(/\btext-caption\b/);
      expect(tab.className).toMatch(/\bfont-semibold\b/);
    }
    rerender(
      <SegmentedControl<Long> options={[...LONG].slice(0, 3)} value="a" onChange={() => {}} />,
    );
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.className).toMatch(/\btext-subheadline\b/);
    }
    rerender(
      <SegmentedControl<Long> options={[...LONG].slice(0, 3)} value="a" onChange={() => {}} size="sm" />,
    );
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.className).toMatch(/\btext-footnote\b/);
    }
  });

  it("sigue operable con etiquetas largas: seleccion por clic, aria-selected y roving tabindex", () => {
    const onChange = vi.fn();
    render(<SegmentedControl<Long> options={[...LONG]} value="b" onChange={onChange} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true", "false", "false"]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1, -1]);
    fireEvent.click(screen.getByRole("tab", { name: "Portugués" }));
    expect(onChange).toHaveBeenCalledWith("c");
  });
});

/*
 * Columnas desiguales: con 4 idiomas en un panel de 280 px, "Portuguese" (74 px,
 * una sola palabra) no cabe en su cuarta parte (68 px). Las columnas son
 * minmax(min-content, 1fr): la suya se ensancha y el pulgar deja de usar
 * porcentajes para usar la geometria medida del segmento activo. jsdom no hace
 * layout: se simulan offsetWidth/offsetLeft.
 */
describe("SegmentedControl: columnas desiguales por una palabra larga", () => {
  const LANGS = [
    { value: "en", label: "English" },
    { value: "es", label: "Spanish" },
    { value: "fr", label: "French" },
    { value: "pt", label: "Portuguese" },
  ] as const;
  type Lang = (typeof LANGS)[number]["value"];

  const widthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  const leftDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetLeft");
  afterEach(() => {
    if (widthDesc) Object.defineProperty(HTMLElement.prototype, "offsetWidth", widthDesc);
    if (leftDesc) Object.defineProperty(HTMLElement.prototype, "offsetLeft", leftDesc);
  });

  function simulate(widths: Record<string, number>) {
    const order = Object.keys(widths);
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return widths[this.textContent ?? ""] ?? 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
      configurable: true,
      get(this: HTMLElement) {
        const i = order.indexOf(this.textContent ?? "");
        return i < 0 ? 0 : 4 + order.slice(0, i).reduce((sum, key) => sum + widths[key], 0);
      },
    });
  }

  it("anchos iguales: el pulgar sigue siendo un porcentaje (no depende del contenido)", () => {
    simulate({ English: 68, Spanish: 68, French: 68, Portuguese: 68 });
    const { container } = render(
      <SegmentedControl<Lang> options={[...LANGS]} value="pt" onChange={() => {}} />,
    );
    const thumb = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(thumb.style.width).toMatch(/100% - 0\.5rem/);
  });

  it("anchos distintos: el pulgar toma ancho y posicion medidos del segmento activo, en px", async () => {
    simulate({ English: 63, Spanish: 63, French: 63, Portuguese: 82 });
    const { container, rerender } = render(
      <SegmentedControl<Lang> options={[...LANGS]} value="pt" onChange={() => {}} />,
    );
    const thumb = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(thumb.style.width).toBe("82px");
    // desplazamiento = offsetLeft del activo (4 + 3 x 63) menos el left-1 base (4)
    expect(thumb.style.transform).toMatch(/translateX\(189px\)/);

    // Al cambiar de activo el pulgar anima (spring) hacia el ancho del nuevo segmento.
    rerender(<SegmentedControl<Lang> options={[...LANGS]} value="es" onChange={() => {}} />);
    await waitFor(() => {
      const moved = container.querySelector('[aria-hidden="true"]') as HTMLElement;
      expect(moved.style.width).toBe("63px");
    });
  });

  it("las columnas son minmax(min-content, 1fr) en una rejilla: nunca recortan una palabra suelta", () => {
    render(<SegmentedControl<Lang> options={[...LANGS]} value="en" onChange={() => {}} />);
    const list = screen.getByRole("tablist");
    expect(list.className).toMatch(/\bgrid\b/);
    expect(list.className).toMatch(/auto-cols-\[minmax\(min-content,1fr\)\]/);
    expect(list.className).toMatch(/\bgrid-flow-col\b/);
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.className).not.toMatch(/\bmin-w-0\b|\bflex-1\b|overflow-hidden/);
    }
  });
});

describe("SegmentedControl con wrap (segmentos que pasan a otra fila)", () => {
  it("mantiene roles, aria-selected, roving tabindex y flechas; la pista permite varias filas", () => {
    const onChange = vi.fn();
    render(<SegmentedControl<Mode> wrap label="Modo" options={[...OPTIONS]} value="type" onChange={onChange} />);
    const list = screen.getByRole("tablist", { name: "Modo" });
    expect(list.className).toContain("flex-wrap");
    expect(list.className).not.toContain("grid-flow-col");
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
    tabs[1].focus();
    fireEvent.keyDown(tabs[1], { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("upload");
    fireEvent.click(tabs[0]);
    expect(onChange).toHaveBeenLastCalledWith("draw");
  });

  it("cada segmento mide al menos 44 px de alto y de ancho (min-h-11 / min-w-11) y no hay pulgar suelto: el fondo va dentro del activo", () => {
    const { container } = render(<SegmentedControl<Mode> wrap options={[...OPTIONS]} value="draw" onChange={() => {}} />);
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.className).toContain("min-h-11");
      expect(tab.className).toContain("min-w-11");
    }
    const list = screen.getByRole("tablist");
    // Ningun hijo directo de la pista es el pulgar absoluto del modo normal.
    expect(Array.from(list.children).every((child) => child.getAttribute("role") === "tab")).toBe(true);
    const thumbs = container.querySelectorAll('[role="tab"] > span[aria-hidden="true"]');
    expect(thumbs).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Dibujar" }).contains(thumbs[0])).toBe(true);
  });

  it("al cambiar de opcion el fondo pasa al segmento activo", () => {
    const { rerender } = render(<SegmentedControl<Mode> wrap options={[...OPTIONS]} value="draw" onChange={() => {}} />);
    rerender(<SegmentedControl<Mode> wrap options={[...OPTIONS]} value="upload" onChange={() => {}} />);
    expect(screen.getByRole("tab", { name: "Subir" }).querySelector('span[aria-hidden="true"]')).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Dibujar" }).querySelector('span[aria-hidden="true"]')).toBeNull();
  });

  it("sin wrap sigue como siempre: pista en rejilla con el pulgar suelto", () => {
    render(<SegmentedControl<Mode> options={[...OPTIONS]} value="draw" onChange={() => {}} />);
    const list = screen.getByRole("tablist");
    expect(list.className).toContain("grid-flow-col");
    expect(list.className).not.toContain("flex-wrap");
  });
});
