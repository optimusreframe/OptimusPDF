import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FieldPlacer, TextFieldPlacer } from "@/app/sign-pdf/FieldPlacer";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import type { SignatureField, SignatureFieldType, Signer } from "@/lib/pdf/sign";
import type { DetectedField } from "@/lib/pdf/detectFields";

/**
 * El lienzo solo acepta interacciones cuando ya tiene la pagina pintada,
 * y esa parte es pdf.js con su worker: fuera del navegador no arranca. Se
 * sustituyen las tres funciones de render de `core.ts` por el minimo que
 * el componente necesita; lo que se comprueba aqui es la manipulacion de
 * los campos, no el rasterizado.
 */
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: async () => ({
      numPages: 2,
      getPage: async () => ({ cleanup: () => {} }),
    }),
    renderPageToDataUrl: async () => "data:image/png;base64,iVBORw0KGgo=",
    closePdfDocument: async () => {},
  };
});

const strings = SIGN_STRINGS.es;

const HOST_WIDTH = 600;
const HOST_HEIGHT = 800;

beforeAll(() => {
  // jsdom no hace layout: sin caja medible el lienzo no sabe traducir
  // pixeles a fracciones de pagina.
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      width: HOST_WIDTH,
      height: HOST_HEIGHT,
      top: 0,
      left: 0,
      right: HOST_WIDTH,
      bottom: HOST_HEIGHT,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };

/** Una sola instancia: `FieldPlacer` se remonta si cambia la identidad del archivo. */
const FILE = new File([new Uint8Array([1, 2, 3])], "contrato.pdf", {
  type: "application/pdf",
});

type HarnessProps = {
  onFieldsChange: (fields: SignatureField[]) => void;
  initialFields?: SignatureField[];
  activeSignerId?: string | null;
};

function Harness({
  onFieldsChange,
  initialFields = [],
  activeSignerId: initialActiveSignerId = ANA.id,
}: HarnessProps) {
  const [fields, setFields] = useState<SignatureField[]>(initialFields);
  const [type, setType] = useState<SignatureFieldType>("signature");
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeSignerId, setActiveSignerId] = useState<string | null>(
    initialActiveSignerId,
  );

  return (
    <FieldPlacer
      file={FILE}
      signers={[ANA, LUIS]}
      activeSignerId={activeSignerId}
      onActiveSignerIdChange={setActiveSignerId}
      fields={fields}
      onFieldsChange={(next) => {
        setFields(next);
        onFieldsChange(next);
      }}
      activeType={type}
      onActiveTypeChange={setType}
      pageIndex={pageIndex}
      onPageIndexChange={setPageIndex}
      selectedId={selectedId}
      onSelectedIdChange={setSelectedId}
      strings={strings}
    />
  );
}

/** Espera a que la vista previa simulada este montada. */
async function waitForPreview() {
  await waitFor(() =>
    expect(screen.getByAltText(strings.fieldsTitle)).toBeTruthy(),
  );
}

const signatureLabel = strings.fieldOwnerLabel(ANA.name, strings.fieldSignature);
const initialsLabel = strings.fieldOwnerLabel(ANA.name, strings.fieldInitials);

describe("FieldPlacer — src/app/sign-pdf/FieldPlacer.tsx", () => {
  it("crear un campo lo añade al array con el firmante y el tipo activos", async () => {
    let last: SignatureField[] = [];
    render(<Harness onFieldsChange={(fields) => (last = fields)} />);
    await waitForPreview();

    fireEvent.click(
      screen.getByRole("button", { name: strings.addFieldHere }),
    );

    expect(last).toHaveLength(1);
    expect(last[0].signerId).toBe(ANA.id);
    expect(last[0].type).toBe("signature");
    expect(last[0].pageIndex).toBe(0);
    expect(last[0].rect.width).toBeGreaterThan(0);
    expect(last[0].rect.height).toBeGreaterThan(0);
    expect(screen.getByRole("group", { name: signatureLabel })).toBeTruthy();
  });

  it("el tipo activo manda sobre el campo siguiente", async () => {
    let last: SignatureField[] = [];
    render(<Harness onFieldsChange={(fields) => (last = fields)} />);
    await waitForPreview();

    fireEvent.click(
      screen.getByRole("radio", { name: strings.fieldInitials }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.addFieldHere }),
    );

    expect(last[0].type).toBe("initials");
    expect(screen.getByRole("group", { name: initialsLabel })).toBeTruthy();
  });

  it("arrastrar un campo actualiza su rectangulo sin tocar los demas", async () => {
    let last: SignatureField[] = [];
    render(<Harness onFieldsChange={(fields) => (last = fields)} />);
    await waitForPreview();

    fireEvent.click(
      screen.getByRole("button", { name: strings.addFieldHere }),
    );
    const before = last[0].rect;

    const box = screen.getByRole("group", { name: signatureLabel });
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 300, clientY: 600 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 240, clientY: 520 });
    fireEvent.pointerUp(box, { pointerId: 1 });

    expect(last).toHaveLength(1);
    expect(last[0].rect.x).toBeCloseTo(before.x - 60 / HOST_WIDTH, 5);
    expect(last[0].rect.y).toBeCloseTo(before.y - 80 / HOST_HEIGHT, 5);
    // Mover no redimensiona.
    expect(last[0].rect.width).toBeCloseTo(before.width, 6);
    expect(last[0].rect.height).toBeCloseTo(before.height, 6);
  });

  it("un campo no se sale de la pagina al arrastrarlo", async () => {
    let last: SignatureField[] = [];
    render(<Harness onFieldsChange={(fields) => (last = fields)} />);
    await waitForPreview();

    fireEvent.click(
      screen.getByRole("button", { name: strings.addFieldHere }),
    );

    const box = screen.getByRole("group", { name: signatureLabel });
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 300, clientY: 600 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: -5000, clientY: -5000 });
    fireEvent.pointerUp(box, { pointerId: 1 });

    expect(last[0].rect.x).toBe(0);
    expect(last[0].rect.y).toBe(0);
  });

  it("arrastrar sobre la pagina dibuja un campo con el rectangulo recorrido", async () => {
    let last: SignatureField[] = [];
    render(<Harness onFieldsChange={(fields) => (last = fields)} />);
    await waitForPreview();

    const host = screen.getByAltText(strings.fieldsTitle).parentElement!;
    fireEvent.pointerDown(host, { pointerId: 2, clientX: 60, clientY: 80 });
    fireEvent.pointerMove(host, { pointerId: 2, clientX: 360, clientY: 240 });
    fireEvent.pointerUp(host, { pointerId: 2, clientX: 360, clientY: 240 });

    expect(last).toHaveLength(1);
    expect(last[0].rect.x).toBeCloseTo(60 / HOST_WIDTH, 5);
    expect(last[0].rect.y).toBeCloseTo(80 / HOST_HEIGHT, 5);
    expect(last[0].rect.width).toBeCloseTo(300 / HOST_WIDTH, 5);
    expect(last[0].rect.height).toBeCloseTo(160 / HOST_HEIGHT, 5);
  });

  it("borrar el campo seleccionado lo saca del array", async () => {
    let last: SignatureField[] = [];
    render(<Harness onFieldsChange={(fields) => (last = fields)} />);
    await waitForPreview();

    fireEvent.click(
      screen.getByRole("button", { name: strings.addFieldHere }),
    );
    expect(last).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: strings.removeField }));

    expect(last).toHaveLength(0);
    expect(screen.queryByRole("group", { name: signatureLabel })).toBeNull();
  });

  it("cambiar de firmante activo manda los huecos nuevos al elegido", async () => {
    let last: SignatureField[] = [];
    render(<Harness onFieldsChange={(fields) => (last = fields)} />);
    await waitForPreview();

    fireEvent.click(screen.getByRole("button", { name: strings.addFieldHere }));
    expect(last[0].signerId).toBe(ANA.id);

    const chip = screen.getByRole("radio", { name: LUIS.name });
    expect(chip.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(chip);
    expect(
      screen.getByRole("radio", { name: LUIS.name }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("radio", { name: ANA.name }).getAttribute("aria-checked"),
    ).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: strings.addFieldHere }));

    expect(last).toHaveLength(2);
    // El hueco anterior sigue siendo de Ana; solo el nuevo cambia de dueño.
    expect(last[0].signerId).toBe(ANA.id);
    expect(last[1].signerId).toBe(LUIS.id);
    expect(
      screen.getByRole("group", {
        name: strings.fieldOwnerLabel(LUIS.name, strings.fieldSignature),
      }),
    ).toBeTruthy();
  });

  it("el selector de firmante no duplica el estado: refleja el que llega por props", async () => {
    render(<Harness onFieldsChange={() => {}} activeSignerId={LUIS.id} />);
    await waitForPreview();

    expect(
      screen.getByRole("radio", { name: LUIS.name }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByText(strings.fieldOwnerLabel(LUIS.name, strings.fieldSignature))).toBeTruthy();
  });

  it("sin firmante activo no se puede reservar nada", async () => {
    render(<Harness onFieldsChange={() => {}} activeSignerId={null} />);
    await waitForPreview();

    const button = screen.getByRole("button", {
      name: strings.addFieldHere,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(strings.needSigner)).toBeTruthy();
  });

  it("'Borrar todos los huecos' no borra nada hasta confirmar en el Sheet", async () => {
    let last: SignatureField[] = [];
    render(<Harness onFieldsChange={(fields) => (last = fields)} />);
    await waitForPreview();

    fireEvent.click(screen.getByRole("button", { name: strings.addFieldHere }));
    expect(last).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: strings.clearAllFields }));
    // Un solo toque en el boton NO debe mutar el estado: solo abre el Sheet.
    expect(last).toHaveLength(1);
    expect(screen.getByText(strings.confirmClearAllFieldsBody)).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: strings.confirmCancel }),
    );
    expect(last).toHaveLength(1);
    expect(screen.queryByText(strings.confirmClearAllFieldsBody)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: strings.clearAllFields }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: strings.clearAllFields }),
    );
    expect(last).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * TextFieldPlacer: mismo gesto de colocacion, sin firmante ni tipo.
 * ------------------------------------------------------------------ */

type TextHarnessProps = {
  onFieldsChange: (fields: DetectedField[]) => void;
  initialFields?: DetectedField[];
  initialValues?: Record<string, string>;
};

function TextHarness({
  onFieldsChange,
  initialFields = [],
  initialValues = {},
}: TextHarnessProps) {
  const [fields, setFields] = useState<DetectedField[]>(initialFields);
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <TextFieldPlacer
      file={FILE}
      fields={fields}
      onFieldsChange={(next) => {
        setFields(next);
        onFieldsChange(next);
      }}
      values={values}
      onValueChange={(id, value) =>
        setValues((current) => ({ ...current, [id]: value }))
      }
      pageIndex={pageIndex}
      onPageIndexChange={setPageIndex}
      selectedId={selectedId}
      onSelectedIdChange={setSelectedId}
      strings={strings}
    />
  );
}

async function waitForTextPreview() {
  await waitFor(() =>
    expect(screen.getByAltText(strings.textFieldsTitle)).toBeTruthy(),
  );
}

describe("TextFieldPlacer — src/app/sign-pdf/FieldPlacer.tsx", () => {
  it("crear un campo lo anade sin firmante ni tipo, con fuente 'manual'", async () => {
    let last: DetectedField[] = [];
    render(<TextHarness onFieldsChange={(fields) => (last = fields)} />);
    await waitForTextPreview();

    fireEvent.click(
      screen.getByRole("button", { name: strings.addTextFieldHere }),
    );

    expect(last).toHaveLength(1);
    expect(last[0].source).toBe("manual");
    expect(last[0].confidence).toBe("high");
    expect(last[0].pageIndex).toBe(0);
    expect(last[0].rect.width).toBeGreaterThan(0);
  });

  it("arrastrar sobre la pagina dibuja un campo con el rectangulo recorrido", async () => {
    let last: DetectedField[] = [];
    render(<TextHarness onFieldsChange={(fields) => (last = fields)} />);
    await waitForTextPreview();

    const host = screen.getByAltText(strings.textFieldsTitle).parentElement!;
    fireEvent.pointerDown(host, { pointerId: 3, clientX: 60, clientY: 80 });
    fireEvent.pointerMove(host, { pointerId: 3, clientX: 360, clientY: 240 });
    fireEvent.pointerUp(host, { pointerId: 3, clientX: 360, clientY: 240 });

    expect(last).toHaveLength(1);
    expect(last[0].rect.x).toBeCloseTo(60 / HOST_WIDTH, 5);
    expect(last[0].rect.y).toBeCloseTo(80 / HOST_HEIGHT, 5);
  });

  it("seleccionar un campo muestra un input en linea que escribe en su valor", async () => {
    const field: DetectedField = {
      id: "txt-1",
      pageIndex: 0,
      rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
      label: "Nombre",
      source: "acroform",
      confidence: "high",
    };
    render(<TextHarness initialFields={[field]} onFieldsChange={() => {}} />);
    await waitForTextPreview();

    fireEvent.pointerDown(screen.getByRole("group", { name: "Nombre" }), {
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerUp(screen.getByRole("group", { name: "Nombre" }), {
      pointerId: 1,
    });

    const input = screen.getByRole("textbox", { name: "Nombre" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Ana" } });
    expect(input.value).toBe("Ana");
  });

  it("un campo de confianza baja se avisa como experimental al seleccionarlo", async () => {
    const field: DetectedField = {
      id: "raster-1",
      pageIndex: 0,
      rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
      source: "heuristic-raster",
      confidence: "low",
    };
    render(<TextHarness initialFields={[field]} onFieldsChange={() => {}} />);
    await waitForTextPreview();

    const label = strings.textFieldFallbackLabel(1);
    fireEvent.pointerDown(screen.getByRole("group", { name: label }), {
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerUp(screen.getByRole("group", { name: label }), {
      pointerId: 1,
    });

    expect(screen.getByText(strings.lowConfidenceHint)).toBeTruthy();
  });

  it("borrar el campo seleccionado lo saca del array", async () => {
    let last: DetectedField[] = [];
    render(<TextHarness onFieldsChange={(fields) => (last = fields)} />);
    await waitForTextPreview();

    fireEvent.click(screen.getByRole("button", { name: strings.addTextFieldHere }));
    expect(last).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: strings.removeTextField }));
    expect(last).toHaveLength(0);
  });

  it("sin ningun campo se muestra el aviso opcional, no un error", async () => {
    render(<TextHarness onFieldsChange={() => {}} />);
    await waitForTextPreview();

    expect(screen.getByText(strings.noTextFields)).toBeTruthy();
  });

  it("'Borrar todos los campos' no borra nada hasta confirmar en el Sheet", async () => {
    let last: DetectedField[] = [];
    render(<TextHarness onFieldsChange={(fields) => (last = fields)} />);
    await waitForTextPreview();

    fireEvent.click(
      screen.getByRole("button", { name: strings.addTextFieldHere }),
    );
    expect(last).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("button", { name: strings.clearAllTextFields }),
    );
    expect(last).toHaveLength(1);
    expect(screen.getByText(strings.confirmClearAllTextFieldsBody)).toBeTruthy();

    const dialog = screen.getByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: strings.clearAllTextFields }),
    );
    expect(last).toHaveLength(0);
  });
});
