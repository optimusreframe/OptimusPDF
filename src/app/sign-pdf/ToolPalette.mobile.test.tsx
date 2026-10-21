import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { ToolPalette } from "@/app/sign-pdf/ToolPalette";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import type { PlacementTool } from "@/app/sign-pdf/canvasTools";

/*
 * Paleta del lienzo en movil (auditoria movil/iPad, SC-02 / VI-04 / VI-07): PLEGADA por defecto en un boton con la
 * herramienta activa (las capas fijas de abajo dejan de sumar ~34 % del alto), se abre con ese boton, elegir una
 * herramienta (o Escape, o «Plegar herramientas») la vuelve a plegar y devuelve el foco al boton. En
 * tablet y en escritorio no se pliega; dentro de PDF Pro se pliega igual en un telefono.
 */

const strings = SIGN_STRINGS.es;
const TOOLS: readonly PlacementTool[] = ["select", "signature", "text", "checkbox", "date"];

/** `matchMedia` de un telefono (< 768 px) o de otro ancho: solo responde a las consultas de ancho que usa la paleta. */
function stubViewport(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => {
    const max = /max-width:\s*([\d.]+)px/.exec(query);
    const min = /min-width:\s*([\d.]+)px/.exec(query);
    const matches = (max ? width <= Number(max[1]) : true) && (min ? width >= Number(min[1]) : true);
    return {
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    };
  });
}

function Harness({ onPick }: { onPick?: (tool: PlacementTool) => void }) {
  const [tool, setTool] = useState<PlacementTool>("select");
  return (
    <ToolPalette
      tool={tool}
      tools={TOOLS}
      onToolChange={(next) => {
        setTool(next);
        onPick?.(next);
      }}
      owner={null}
      onPrevField={() => {}}
      onNextField={() => {}}
      canPrevField
      canNextField
      strings={strings}
    />
  );
}

beforeEach(() => {
  document.documentElement.removeAttribute("data-pro-suite");
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-pro-suite");
});

describe("ToolPalette · telefono", () => {
  it("arranca plegada: un boton con la herramienta activa y SIN la barra de herramientas", () => {
    stubViewport(393);
    render(<Harness />);
    const fab = screen.getByRole("button", { name: strings.paletteExpand(strings.toolSelect) });
    expect(fab.getAttribute("aria-expanded")).toBe("false");
    expect(fab.hasAttribute("data-palette-fab")).toBe(true);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("el boton abre la barra (botones de 44 px sin estirarse) y elegir una herramienta la pliega y devuelve el foco al boton", () => {
    stubViewport(393);
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: strings.paletteExpand(strings.toolSelect) }));
    const toolbar = screen.getByRole("toolbar", { name: strings.paletteLabel });
    const signature = screen.getByRole("button", { name: strings.fieldSignature });
    expect(signature.className).toContain("max-xl:w-11");
    expect(signature.className).toContain("max-xl:flex-none");
    // El foco entra en la barra, en la herramienta activa.
    expect(toolbar.contains(document.activeElement)).toBe(true);
    fireEvent.click(signature);
    expect(onPick).toHaveBeenCalledWith("signature");
    expect(screen.queryByRole("toolbar")).toBeNull();
    const fab = screen.getByRole("button", { name: strings.paletteExpand(strings.fieldSignature) });
    expect(document.activeElement).toBe(fab);
    // Con una herramienta armada el boton lo dice (texto visible), no solo el icono.
    expect(fab.textContent).toContain(strings.fieldSignature);
  });

  it("Escape y «Plegar herramientas» pliegan la barra sin cambiar de herramienta", () => {
    stubViewport(393);
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: strings.paletteExpand(strings.toolSelect) }));
    fireEvent.keyDown(screen.getByRole("button", { name: strings.fieldSignature }), { key: "Escape" });
    expect(screen.queryByRole("toolbar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: strings.paletteExpand(strings.toolSelect) }));
    fireEvent.click(screen.getByRole("button", { name: strings.paletteCollapse }));
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("la barra abierta no lleva las clases `max-md:fixed` del lienzo: la colocacion la decide la paleta (dock pegajoso)", () => {
    stubViewport(393);
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: strings.paletteExpand(strings.toolSelect) }));
    const dock = container.querySelector("[data-palette-dock]") as HTMLElement;
    expect(dock.className).toContain("max-xl:sticky");
    expect(dock.className).toContain("max-xl:order-last");
    const toolbar = screen.getByRole("toolbar");
    expect(toolbar.className).not.toContain("max-md:fixed");
    expect(toolbar.className).not.toContain("md:top-24");
    expect(toolbar.className).toContain("max-xl:gap-2");
  });
});

describe("ToolPalette · tablet, escritorio y PDF Pro", () => {
  it("en tablet (834 px) la barra esta SIEMPRE abierta, en horizontal (dock bajo la hoja)", () => {
    stubViewport(834);
    render(<Harness />);
    const toolbar = screen.getByRole("toolbar", { name: strings.paletteLabel });
    expect(toolbar.getAttribute("aria-orientation")).toBe("horizontal");
    expect(screen.queryByRole("button", { name: strings.paletteCollapse })).toBeNull();
  });

  it("en escritorio ancho (1 280 px) es el carril vertical de siempre", () => {
    stubViewport(1280);
    render(<Harness />);
    expect(screen.getByRole("toolbar").getAttribute("aria-orientation")).toBe("vertical");
  });

  it("dentro de PDF Pro se pliega en un telefono (boton marcado `data-pro-fold` para «Ocultar herramientas») y en tablet no", () => {
    document.documentElement.setAttribute("data-pro-suite", "");
    stubViewport(393);
    const { unmount } = render(<Harness />);
    expect(screen.queryByRole("toolbar", { name: strings.paletteLabel })).toBeNull();
    const fab = screen.getByRole("button", { name: strings.paletteExpand(strings.toolSelect) });
    expect(fab.hasAttribute("data-pro-fold")).toBe(true);
    fireEvent.click(fab);
    expect(screen.getByRole("toolbar", { name: strings.paletteLabel })).toBeTruthy();
    unmount();
    stubViewport(834);
    render(<Harness />);
    expect(screen.getByRole("toolbar", { name: strings.paletteLabel })).toBeTruthy();
    expect(screen.queryByRole("button", { name: strings.paletteCollapse })).toBeNull();
  });

  it("sin `matchMedia` (jsdom) se comporta como siempre: abierta y sin boton de plegar", () => {
    render(<Harness />);
    expect(screen.getByRole("toolbar", { name: strings.paletteLabel })).toBeTruthy();
    expect(screen.queryByRole("button", { name: strings.paletteCollapse })).toBeNull();
  });
});
