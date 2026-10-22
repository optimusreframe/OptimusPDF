import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { es } from "@/lib/locales/es";
import { RangeNotice } from "@/app/extract-assets/RangeNotice";
import { mount, setLanguage } from "@/app/extract-assets/testUtils";

beforeEach(() => setLanguage("es"));

function renderRange(onApply = vi.fn()) {
  mount(<RangeNotice strings={es.extract} pageCount={450} initial={{ from: 1, to: 300 }} onApply={onApply} />);
  return {
    onApply,
    from: screen.getByLabelText("Desde la página") as HTMLInputElement,
    to: screen.getByLabelText("Hasta la página") as HTMLInputElement,
    apply: screen.getByRole("button", { name: "Buscar en este rango" }) as HTMLButtonElement,
  };
}

const set = (input: HTMLInputElement, value: string) => fireEvent.change(input, { target: { value } });

describe("RangeNotice", () => {
  it("parte del rango analizado y aplica uno valido (1-based)", () => {
    const { from, to, apply, onApply } = renderRange();
    expect([from.value, to.value]).toEqual(["1", "300"]);
    set(from, "301");
    set(to, "450");
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledWith({ from: 301, to: 450 });
  });

  it("rechaza rangos vacios, invertidos, fuera del documento o de mas de 300 paginas, y lo explica", () => {
    const { from, to, apply } = renderRange();
    for (const [a, b] of [["", "10"], ["10", ""], ["50", "40"], ["0", "10"], ["1", "451"], ["1", "301"], ["x", "y"]]) {
      set(from, a);
      set(to, b);
      expect(apply.disabled, `${a}-${b}`).toBe(true);
    }
    expect(screen.getByText("El rango no es válido: elige páginas entre 1 y 450, hasta 300 seguidas.")).toBeTruthy();
  });

  it("300 paginas justas SI valen y el formulario se envia con Enter", () => {
    const { from, to, onApply } = renderRange();
    set(from, "100");
    set(to, "399");
    fireEvent.submit(screen.getByRole("button", { name: "Buscar en este rango" }).closest("form")!);
    expect(onApply).toHaveBeenCalledWith({ from: 100, to: 399 });
  });

  it("no avisa de rango invalido mientras no se haya tocado nada", () => {
    renderRange();
    expect(screen.queryByText(/El rango no es válido/)).toBeNull();
  });
});
