import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import * as Shared from "@/components/tool/OptionControls";
import * as SharedGrid from "@/components/tool/PositionGrid";
import * as WatermarkControls from "@/app/add-watermark/OptionControls";
import * as PageNumbersControls from "@/app/add-page-numbers/OptionControls";
import * as WatermarkGrid from "@/app/add-watermark/PositionGrid";
import * as PageNumbersGrid from "@/app/add-page-numbers/PositionGrid";

/*
 * W6-C · U7: `OptionControls` (285 lineas) y `PositionGrid` (79) estaban
 * duplicados, identicos salvo un comentario, en add-watermark y
 * add-page-numbers. Ahora hay UNA implementacion en components/tool y las dos
 * rutas antiguas son reexportaciones: mismas referencias, mismo
 * comportamiento (las pruebas existentes importan por las rutas antiguas).
 */
const CONTROL_NAMES = [
  "ChoiceGroup",
  "ToggleRow",
  "NumberField",
  "TextField",
  "ColorSwatches",
  "OptionSection",
] as const;

describe("OptionControls compartido", () => {
  it.each(CONTROL_NAMES)("%s: las dos rutas antiguas exportan EXACTAMENTE el componente compartido", (name) => {
    expect(Shared[name]).toBeTypeOf("function");
    expect(WatermarkControls[name]).toBe(Shared[name]);
    expect(PageNumbersControls[name]).toBe(Shared[name]);
  });

  it("PositionGrid: las dos rutas antiguas exportan el mismo componente", () => {
    expect(SharedGrid.PositionGrid).toBeTypeOf("function");
    expect(WatermarkGrid.PositionGrid).toBe(SharedGrid.PositionGrid);
    expect(PageNumbersGrid.PositionGrid).toBe(SharedGrid.PositionGrid);
  });

  it("no hay exportaciones perdidas: las rutas antiguas no añaden ni quitan nombres", () => {
    const names = (mod: object) => Object.keys(mod).sort();
    expect(names(WatermarkControls)).toEqual(names(Shared));
    expect(names(PageNumbersControls)).toEqual(names(Shared));
  });
});

describe("OptionControls — comportamiento conservado", () => {
  it("ChoiceGroup: radiogroup accesible, aria-checked y onChange", () => {
    const onChange = vi.fn();
    render(
      <Shared.ChoiceGroup
        label="Fuente"
        value="a"
        choices={[
          { value: "a", label: "Helvetica" },
          { value: "b", label: "Times" },
        ]}
        onChange={onChange}
      />,
    );
    const group = screen.getByRole("radiogroup", { name: "Fuente" });
    expect(group).toBeTruthy();
    const [a, b] = screen.getAllByRole("radio");
    expect(a.getAttribute("aria-checked")).toBe("true");
    expect(b.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(b);
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("ToggleRow: role switch y alterna con onChange(!checked)", () => {
    const onChange = vi.fn();
    render(<Shared.ToggleRow label="Diagonal" checked={false} onChange={onChange} />);
    const toggle = screen.getByRole("switch", { name: "Diagonal" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("NumberField recorta al rango [min, max] y vacío vuelve al mínimo", () => {
    const onChange = vi.fn();
    render(<Shared.NumberField label="Opacidad" value={50} min={5} max={100} onChange={onChange} />);
    const input = screen.getByLabelText("Opacidad");
    fireEvent.change(input, { target: { value: "500" } });
    expect(onChange).toHaveBeenLastCalledWith(100);
    fireEvent.change(input, { target: { value: "1" } });
    expect(onChange).toHaveBeenLastCalledWith(5);
    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(5);
  });

  it("ColorSwatches: la elegida se compara sin distinguir mayúsculas y cada muestra es un radio con su color", () => {
    const onChange = vi.fn();
    render(
      <Shared.ColorSwatches label="Color" value="#0D4BFF" colors={["#000000", "#0d4bff"]} onChange={onChange} />,
    );
    const radios = screen.getAllByRole("radio");
    expect(radios[1].getAttribute("aria-checked")).toBe("true");
    expect((radios[1] as HTMLElement).style.backgroundColor).toBe("rgb(13, 75, 255)");
    fireEvent.click(radios[0]);
    expect(onChange).toHaveBeenCalledWith("#000000");
  });

  it("ColorSwatches: cada muestra se llama por su color («Azul»), nunca por su codigo hexadecimal", () => {
    render(
      <Shared.ColorSwatches label="Color" value="#000000" colors={["#000000", "#0d4bff", "#e11d48"]} onChange={() => {}} />,
    );
    expect(screen.getAllByRole("radio").map((radio) => radio.getAttribute("aria-label"))).toEqual(["Negro", "Azul", "Rojo"]);
    expect(screen.getByRole("radio", { name: "Azul" }).getAttribute("title")).toBe("Azul");
  });

  it("PositionGrid: 9 anclas, etiqueta accesible por ancla, deshabilitada no responde", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Shared.ChoiceGroup label="x" value="a" choices={[{ value: "a", label: "A" }]} onChange={() => {}} />,
    );
    rerender(
      <SharedGrid.PositionGrid
        label="Posición"
        value="middle-center"
        onChange={onChange}
        anchorLabels={{ "middle-center": "Centro" }}
      />,
    );
    expect(screen.getAllByRole("radio")).toHaveLength(9);
    expect(screen.getByRole("radio", { name: "Centro" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getAllByRole("radio")[0]);
    expect(onChange).toHaveBeenCalledTimes(1);
    rerender(
      <SharedGrid.PositionGrid
        label="Posición"
        value="middle-center"
        onChange={onChange}
        anchorLabels={{}}
        disabled
      />,
    );
    expect(screen.getAllByRole("radio").every((r) => (r as HTMLButtonElement).disabled)).toBe(true);
  });
});
