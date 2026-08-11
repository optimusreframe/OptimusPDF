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

describe("FieldFormPanel — src/app/sign-pdf/FieldFormPanel.tsx", () => {
  it("sin campos muestra el aviso opcional, no la lista", () => {
    render(
      <FieldFormPanel
        fields={[]}
        values={{}}
        onJumpToField={() => {}}
        strings={strings}
      />,
    );
    expect(screen.getByText(strings.noTextFields)).toBeTruthy();
  });

  it("agrupa los campos por pagina y no dibuja ningun input de texto (rellenar es solo en el lienzo)", () => {
    render(
      <FieldFormPanel
        fields={[NAME_FIELD, DATE_FIELD]}
        values={{}}
        onJumpToField={() => {}}
        strings={strings}
      />,
    );
    expect(screen.getByText(strings.pageGroupLabel(1))).toBeTruthy();
    expect(screen.getByText(strings.pageGroupLabel(2))).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("el resumen cuenta solo los campos con valor no vacio", () => {
    render(
      <FieldFormPanel
        fields={[NAME_FIELD, DATE_FIELD]}
        values={{ [NAME_FIELD.id]: "Ana Garcia", [DATE_FIELD.id]: "   " }}
        onJumpToField={() => {}}
        strings={strings}
      />,
    );
    expect(
      screen.getByText(strings.fieldsFilledSummary(1, 2)),
    ).toBeTruthy();
  });

  it("un campo sin etiqueta usa el nombre de respaldo por posicion", () => {
    render(
      <FieldFormPanel
        fields={[RASTER_FIELD]}
        values={{}}
        onJumpToField={() => {}}
        strings={strings}
      />,
    );
    expect(
      screen.getByText(strings.textFieldFallbackLabel(1)),
    ).toBeTruthy();
  });

  it("tocar una fila llama a onJumpToField con ese campo", () => {
    let jumped: DetectedField | null = null;
    render(
      <FieldFormPanel
        fields={[NAME_FIELD, DATE_FIELD]}
        values={{}}
        onJumpToField={(field) => (jumped = field)}
        strings={strings}
      />,
    );
    fireEvent.click(screen.getByText("Fecha"));
    expect(jumped).toEqual(DATE_FIELD);
  });

  it("una fila con valor muestra el valor en vez de la etiqueta", () => {
    render(
      <FieldFormPanel
        fields={[NAME_FIELD]}
        values={{ [NAME_FIELD.id]: "Ana Garcia" }}
        onJumpToField={() => {}}
        strings={strings}
      />,
    );
    expect(screen.getByText("Ana Garcia")).toBeTruthy();
    expect(screen.queryByText("Nombre")).toBeNull();
  });
});
