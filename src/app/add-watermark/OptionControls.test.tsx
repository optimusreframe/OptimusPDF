import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChoiceGroup as WatermarkChoiceGroup } from "@/app/add-watermark/OptionControls";
import { ChoiceGroup as PageNumbersChoiceGroup } from "@/app/add-page-numbers/OptionControls";

/*
 * `ChoiceGroup` esta duplicado en add-watermark y add-page-numbers (y lo
 * reutiliza edit-pdf): las dos copias deben cumplir el mismo contrato
 * (W1-D): sin truncar, marca de seleccion en la esquina y tres columnas que
 * pasan a dos cuando una etiqueta es larga. jsdom no hace layout: se
 * comprueba por clases; la medida real esta en la matriz de truncamientos.
 */
const GROUPS = [
  { name: "add-watermark", ChoiceGroup: WatermarkChoiceGroup },
  { name: "add-page-numbers", ChoiceGroup: PageNumbersChoiceGroup },
];

describe.each(GROUPS)("ChoiceGroup ($name)", ({ ChoiceGroup }) => {
  const FONTS = [
    { value: "helvetica", label: "Helvetica" },
    { value: "times", label: "Times" },
    { value: "courier", label: "Courier" },
  ];

  it("no trunca: texto con wrap, title con la etiqueta y marca de seleccion absoluta en la esquina", () => {
    const { container } = render(
      <ChoiceGroup label="Tipografía" value="helvetica" choices={FONTS} onChange={() => {}} columns={3} />,
    );
    const radios = screen.getAllByRole("radio");
    for (const radio of radios) {
      expect(radio.className).not.toMatch(/\btruncate\b|whitespace-nowrap|overflow-hidden|text-ellipsis/);
      expect(radio.className).toMatch(/\bwhitespace-normal\b/);
      expect(radio.className).toMatch(/\bleading-tight\b/);
      expect(radio.className).toMatch(/\brelative\b/);
      expect(radio.getAttribute("title")).toBe(radio.textContent);
    }
    expect(container.querySelector(".truncate")).toBeNull();
    // Solo la opcion activa lleva marca, y no ocupa ancho del texto (absoluta)
    const marks = container.querySelectorAll("svg");
    expect(marks).toHaveLength(1);
    expect(marks[0].getAttribute("class")).toMatch(/\babsolute\b/);
    expect(radios[0].contains(marks[0])).toBe(true);
  });

  it("tres columnas se mantienen con etiquetas cortas y pasan a dos si alguna supera 9 caracteres", () => {
    const { rerender } = render(
      <ChoiceGroup label="Tipografía" value="helvetica" choices={FONTS} onChange={() => {}} columns={3} />,
    );
    expect(screen.getByRole("radiogroup").className).toMatch(/\bgrid-cols-3\b/);

    rerender(
      <ChoiceGroup
        label="Formato"
        value="a"
        choices={[
          { value: "a", label: "Recomendado" },
          { value: "b", label: "Simple" },
          { value: "c", label: "Pagina N" },
        ]}
        onChange={() => {}}
        columns={3}
      />,
    );
    const group = screen.getByRole("radiogroup");
    expect(group.className).toMatch(/\bgrid-cols-2\b/);
    expect(group.className).not.toMatch(/\bgrid-cols-3\b/);

    // columns = 2 y 1 no cambian
    rerender(
      <ChoiceGroup label="Capa" value="a" choices={[{ value: "a", label: "Sobre el contenido" }, { value: "b", label: "Debajo" }]} onChange={() => {}} columns={2} />,
    );
    expect(screen.getByRole("radiogroup").className).toMatch(/\bgrid-cols-2\b/);
  });

  it("sigue siendo un radiogroup operable", () => {
    const onChange = vi.fn();
    render(<ChoiceGroup label="Tipografía" value="helvetica" choices={FONTS} onChange={onChange} columns={3} />);
    expect(screen.getByRole("radiogroup", { name: "Tipografía" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Helvetica" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Courier" }));
    expect(onChange).toHaveBeenCalledWith("courier");
  });
});
