import { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FieldFormPanel } from "@/app/sign-pdf/FieldFormPanel";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import type { DetectedField } from "@/lib/pdf/detectFields";

const strings = SIGN_STRINGS.es;

const NAME_FIELD: DetectedField = {
  id: "f1",
  pageIndex: 0,
  rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
  label: "Nombre",
  source: "acroform",
  confidence: "high",
};

const DATE_FIELD: DetectedField = {
  id: "f2",
  pageIndex: 1,
  rect: { x: 0.1, y: 0.2, width: 0.2, height: 0.05 },
  label: "Fecha",
  source: "heuristic-vector",
  confidence: "medium",
};

const RASTER_FIELD: DetectedField = {
  id: "f3",
  pageIndex: 0,
  rect: { x: 0.5, y: 0.5, width: 0.2, height: 0.05 },
  source: "heuristic-raster",
  confidence: "low",
};

type HarnessProps = {
  fields: DetectedField[];
  onGoToField?: (field: DetectedField) => void;
};

function Harness({ fields, onGoToField }: HarnessProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <FieldFormPanel
      fields={fields}
      values={values}
      onValueChange={(id, value) =>
        setValues((current) => ({ ...current, [id]: value }))
      }
      selectedId={selectedId}
      onSelectedIdChange={setSelectedId}
      onGoToField={onGoToField}
      strings={strings}
    />
  );
}

describe("FieldFormPanel — src/app/sign-pdf/FieldFormPanel.tsx", () => {
  it("sin campos muestra el aviso opcional, no la lista", () => {
    render(<Harness fields={[]} />);
    expect(screen.getByText(strings.noTextFields)).toBeTruthy();
  });

  it("agrupa los campos por pagina", () => {
    render(<Harness fields={[NAME_FIELD, DATE_FIELD]} />);
    expect(screen.getByText(strings.pageGroupLabel(1))).toBeTruthy();
    expect(screen.getByText(strings.pageGroupLabel(2))).toBeTruthy();
  });

  it("escribir en un input actualiza el valor de ese campo", () => {
    render(<Harness fields={[NAME_FIELD, DATE_FIELD]} />);
    const nameInput = screen.getByRole("textbox", { name: "Nombre" }) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Ana Garcia" } });
    expect(nameInput.value).toBe("Ana Garcia");

    const dateInput = screen.getByRole("textbox", { name: "Fecha" }) as HTMLInputElement;
    expect(dateInput.value).toBe("");
  });

  it("un campo sin etiqueta usa el nombre de respaldo por posicion", () => {
    render(<Harness fields={[RASTER_FIELD]} />);
    expect(
      screen.getByRole("textbox", { name: strings.textFieldFallbackLabel(1) }),
    ).toBeTruthy();
  });

  it("enfocar un campo llama a onGoToField con ese campo", () => {
    let jumped: DetectedField | null = null;
    render(
      <Harness fields={[NAME_FIELD, DATE_FIELD]} onGoToField={(field) => (jumped = field)} />,
    );
    fireEvent.focus(screen.getByRole("textbox", { name: "Fecha" }));
    expect(jumped).toEqual(DATE_FIELD);
  });
});
