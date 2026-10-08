import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Badge } from "./Badge";
import { Button, buttonClasses } from "./Button";
import { Checkbox } from "./Checkbox";
import { GlassCard } from "./GlassCard";
import { ProgressBar } from "./ProgressBar";
import { Slider } from "./Slider";
import { Spinner } from "./Spinner";

/*
 * Contratos de los componentes base pequeños (W1-B): roles nativos,
 * API publica intacta y ausencia de la tipografia HUD. El tacto real
 * (pointerdown, springs) se comprueba en navegador.
 */

// El nombre de la clase retirada se compone a proposito: asi buscarla en src da 0 resultados (W1-D)
// y el test sigue vigilando que ningun componente base vuelva a emitirla.
const HUD = new RegExp("font-mono|uppercase|hud" + "-label");

describe("Button", () => {
  it("type=button por defecto, sin tipografia HUD, responde en :active y respeta disabled", () => {
    render(
      <Button variant="secondary" size="sm" disabled>
        Guardar
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Guardar" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.className).not.toMatch(HUD);
    expect(button.className).toMatch(/active:scale-\[0\.97\]/);
    expect(button.className).toMatch(/material-thin/);
    expect(button.className).toMatch(/disabled:opacity-50/);
  });

  it("buttonClasses sigue siendo una cadena para enlaces y acepta extras", () => {
    const classes = buttonClasses("primary", "lg", "mt-4");
    expect(classes).toMatch(/bg-signal/);
    expect(classes).toMatch(/h-14/);
    expect(classes).toMatch(/mt-4$/);
    expect(classes).not.toMatch(HUD);
    expect(buttonClasses("ghost")).not.toMatch(/bg-signal/);
    expect(buttonClasses("destructive")).toMatch(/text-destructive/);
  });

  it("fullWidth añade w-full y md mide 44 px (h-11)", () => {
    render(<Button fullWidth>Continuar</Button>);
    const button = screen.getByRole("button", { name: "Continuar" });
    expect(button.className).toMatch(/w-full/);
    expect(button.className).toMatch(/h-11/);
  });
});

describe("Checkbox", () => {
  it("input real asociado a la etiqueta, hint por aria-describedby, onChange booleano", () => {
    const onChange = vi.fn();
    render(
      <Checkbox
        label="Aplanar"
        hint="Convierte los campos en texto."
        checked={false}
        onChange={onChange}
      />,
    );
    const input = screen.getByRole("checkbox", { name: "Aplanar" });
    expect(input.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("Convierte los campos en texto.").id).toBe(
      input.getAttribute("aria-describedby"),
    );
    fireEvent.click(input);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(input.className).toMatch(/active:scale-90/);
    expect(input.parentElement!.parentElement!.className).toMatch(/min-h-11/);
  });

  it("disabled deshabilita el input y respeta el id propio", () => {
    render(<Checkbox id="flat" label="Aplanar" checked disabled onChange={() => {}} />);
    const input = screen.getByRole("checkbox", { name: "Aplanar" }) as HTMLInputElement;
    expect(input.id).toBe("flat");
    expect(input.disabled).toBe(true);
    expect(input.checked).toBe(true);
  });
});

describe("Slider", () => {
  it("role slider nativo, relleno como variable CSS y onChange numerico", () => {
    const onChange = vi.fn();
    render(
      <Slider label="Calidad" value={25} min={0} max={100} suffix="%" onChange={onChange} />,
    );
    const slider = screen.getByRole("slider", { name: "Calidad" }) as HTMLInputElement;
    expect(slider.value).toBe("25");
    expect(slider.style.getPropertyValue("--slider-fill")).toBe("25%");
    expect(slider.className).toBe("slider-ios");
    expect(screen.getByText("25%")).toBeTruthy();
    fireEvent.change(slider, { target: { value: "60" } });
    expect(onChange).toHaveBeenCalledWith(60);
  });

  it("el relleno respeta min/max no estandar", () => {
    render(<Slider label="Escala" value={3} min={1} max={5} onChange={() => {}} />);
    const slider = screen.getByRole("slider", { name: "Escala" });
    expect(slider.style.getPropertyValue("--slider-fill")).toBe("50%");
  });
});

describe("ProgressBar", () => {
  it("role progressbar con el valor recortado a 0..100 y porcentaje visible", () => {
    render(<ProgressBar value={137.4} label="Procesando" />);
    const bar = screen.getByRole("progressbar", { name: "Procesando" });
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(screen.getByText("100%")).toBeTruthy();
    expect(bar.parentElement!.innerHTML).not.toMatch(HUD);
  });

  it("valores negativos se recortan a 0", () => {
    render(<ProgressBar value={-5} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
  });
});

describe("Spinner", () => {
  it("con label es role=status; sin label queda oculto a lectores", () => {
    const { rerender, container } = render(<Spinner label="Cargando" />);
    const status = screen.getByRole("status", { name: "Cargando" });
    expect(status.querySelectorAll("rect")).toHaveLength(8);
    expect(status.getAttribute("class")).toMatch(/animate-spin/);
    rerender(<Spinner className="size-8" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("class")).toMatch(/size-8/);
  });
});

describe("Badge y GlassCard", () => {
  it("Badge usa material fino en neutros, tinte en semanticos, y punto opcional", () => {
    const { rerender, container } = render(<Badge dot>Listo</Badge>);
    const badge = screen.getByText("Listo");
    expect(badge.className).toMatch(/material-thin/);
    expect(badge.className).toMatch(/text-caption-2/);
    expect(badge.className).not.toMatch(HUD);
    expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy();
    rerender(<Badge variant="success">Hecho</Badge>);
    expect(screen.getByText("Hecho").className).toMatch(/text-success/);
  });

  it("GlassCard es material regular y solo la interactiva se eleva", () => {
    const { rerender } = render(<GlassCard data-testid="card">Hola</GlassCard>);
    const card = screen.getByTestId("card");
    expect(card.className).toMatch(/material-regular/);
    expect(card.className).not.toMatch(/hover:-translate-y/);
    rerender(
      <GlassCard data-testid="card" interactive>
        Hola
      </GlassCard>,
    );
    expect(screen.getByTestId("card").className).toMatch(/hover:-translate-y-0\.5/);
    expect(screen.getByTestId("card").className).toMatch(/active:scale-\[0\.99\]/);
  });
});

/*
 * Regresion: Tailwind v4 compila `active:scale-*` a la propiedad `scale`
 * (y `hover:-translate-y-*` a `translate`). Si la lista arbitraria de
 * `transition-[...]` no las incluye, la pulsacion salta sin transicion.
 */
describe("transiciones: scale/translate en las listas arbitrarias", () => {
  const transitionsOf = (className: string) =>
    className.match(/transition-\[[^\]]+\]/g) ?? [];

  it("Button, GlassCard, tabs y Checkbox transicionan `scale`", () => {
    expect(transitionsOf(buttonClasses("primary", "md")).join(" ")).toMatch(/\[scale,/);
    const { container, unmount } = render(
      <GlassCard interactive>x</GlassCard>,
    );
    const card = container.firstElementChild as HTMLElement;
    expect(transitionsOf(card.className).join(" ")).toMatch(/translate/);
    expect(transitionsOf(card.className).join(" ")).toMatch(/scale/);
    unmount();

    render(<Checkbox label="A" checked onChange={() => {}} />);
    const input = screen.getByRole("checkbox");
    expect(transitionsOf(input.className).join(" ")).toMatch(/scale/);
    const icon = input.nextElementSibling as SVGElement;
    expect(transitionsOf(icon.getAttribute("class") ?? "").join(" ")).toMatch(/scale/);
  });
});
