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
  undoDeleteEnabled?: boolean;
};

function Harness({
  onFieldsChange,
  initialFields = [],
  activeSignerId: initialActiveSignerId = ANA.id,
  undoDeleteEnabled,
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
      undoDeleteEnabled={undoDeleteEnabled}
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

  describe("deshacer al borrar un hueco (deferred #2)", () => {
    it("con la funcion activa, borrar muestra 'Deshacer' y el hueco sigue fuera del array", async () => {
      let last: SignatureField[] = [];
      render(
        <Harness onFieldsChange={(fields) => (last = fields)} undoDeleteEnabled />,
      );
      await waitForPreview();

      fireEvent.click(screen.getByRole("button", { name: strings.addFieldHere }));
      fireEvent.click(screen.getByRole("button", { name: strings.removeField }));

      expect(last).toHaveLength(0);
      expect(screen.getByText(strings.fieldDeletedNotice)).toBeTruthy();
    });

    it("'Deshacer' repone el hueco con el MISMO id (no uno nuevo)", async () => {
      let last: SignatureField[] = [];
      render(
        <Harness onFieldsChange={(fields) => (last = fields)} undoDeleteEnabled />,
      );
      await waitForPreview();

      fireEvent.click(screen.getByRole("button", { name: strings.addFieldHere }));
      const originalId = last[0].id;
      fireEvent.click(screen.getByRole("button", { name: strings.removeField }));
      expect(last).toHaveLength(0);

      fireEvent.click(
        screen.getByRole("button", { name: strings.undoRemoveField }),
      );

      expect(last).toHaveLength(1);
      // El id EXACTO importa: `captureStamp` lo usa para validar la
      // captura del firmante -- un id nuevo dejaria la firma marcada
      // como invalida sin motivo.
      expect(last[0].id).toBe(originalId);
      expect(screen.queryByText(strings.fieldDeletedNotice)).toBeNull();
    });

    it("con la funcion apagada, borrar no muestra ningun aviso (comportamiento previo)", async () => {
      let last: SignatureField[] = [];
      render(
        <Harness
          onFieldsChange={(fields) => (last = fields)}
          undoDeleteEnabled={false}
        />,
      );
      await waitForPreview();

      fireEvent.click(screen.getByRole("button", { name: strings.addFieldHere }));
      fireEvent.click(screen.getByRole("button", { name: strings.removeField }));

      expect(last).toHaveLength(0);
      expect(screen.queryByText(strings.fieldDeletedNotice)).toBeNull();
    });

    it("Delete/Backspace con un hueco seleccionado tambien pasa por el mismo deshacer", async () => {
      let last: SignatureField[] = [];
      render(
        <Harness onFieldsChange={(fields) => (last = fields)} undoDeleteEnabled />,
      );
      await waitForPreview();

      fireEvent.click(screen.getByRole("button", { name: strings.addFieldHere }));
      fireEvent.keyDown(window, { key: "Delete" });

      expect(last).toHaveLength(0);
      expect(screen.getByText(strings.fieldDeletedNotice)).toBeTruthy();
    });
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
  keyboardNavEnabled?: boolean;
  undoDeleteEnabled?: boolean;
  richFieldTypesEnabled?: boolean;
  pinchZoomEnabled?: boolean;
  onValuesChange?: (values: Record<string, string>) => void;
};

function TextHarness({
  onFieldsChange,
  initialFields = [],
  initialValues = {},
  keyboardNavEnabled,
  undoDeleteEnabled,
  richFieldTypesEnabled,
  pinchZoomEnabled,
  onValuesChange,
}: TextHarnessProps) {
  const [fields, setFields] = useState<DetectedField[]>(initialFields);
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

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
        setValues((current) => {
          const next = { ...current, [id]: value };
          onValuesChange?.(next);
          return next;
        })
      }
      pageIndex={pageIndex}
      onPageIndexChange={setPageIndex}
      selectedId={selectedId}
      onSelectedIdChange={setSelectedId}
      editingId={editingId}
      onEditingIdChange={setEditingId}
      strings={strings}
      keyboardNavEnabled={keyboardNavEnabled}
      undoDeleteEnabled={undoDeleteEnabled}
      richFieldTypesEnabled={richFieldTypesEnabled}
      pinchZoomEnabled={pinchZoomEnabled}
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

  it("un toque con temblor por debajo del umbral igual abre el editor sin mover el campo", async () => {
    const field: DetectedField = {
      id: "txt-1",
      pageIndex: 0,
      rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
      label: "Nombre",
      source: "acroform",
      confidence: "high",
    };
    let last: DetectedField[] = [field];
    render(
      <TextHarness
        initialFields={[field]}
        onFieldsChange={(fields) => (last = fields)}
      />,
    );
    await waitForTextPreview();

    const box = screen.getByRole("group", { name: "Nombre" });
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 100, clientY: 100 });
    // 3px de temblor: por debajo de TAP_MOVE_THRESHOLD_PX (8), sigue siendo un toque.
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 102, clientY: 101 });
    fireEvent.pointerUp(box, { pointerId: 1, clientX: 102, clientY: 101 });

    expect(screen.getByRole("textbox", { name: "Nombre" })).toBeTruthy();
    expect(last[0].rect).toEqual(field.rect);
  });

  it("un arrastre real (por encima del umbral) mueve el campo sin abrir el editor", async () => {
    const field: DetectedField = {
      id: "txt-1",
      pageIndex: 0,
      rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
      label: "Nombre",
      source: "acroform",
      confidence: "high",
    };
    let last: DetectedField[] = [field];
    render(
      <TextHarness
        initialFields={[field]}
        onFieldsChange={(fields) => (last = fields)}
      />,
    );
    await waitForTextPreview();

    const box = screen.getByRole("group", { name: "Nombre" });
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 160, clientY: 140 });
    fireEvent.pointerUp(box, { pointerId: 1, clientX: 160, clientY: 140 });

    expect(screen.queryByRole("textbox", { name: "Nombre" })).toBeNull();
    expect(last[0].rect.x).toBeCloseTo(field.rect.x + 60 / HOST_WIDTH, 5);
    expect(last[0].rect.y).toBeCloseTo(field.rect.y + 40 / HOST_HEIGHT, 5);
  });

  it("un segundo puntero no puede finalizar el arrastre del primero", async () => {
    const field: DetectedField = {
      id: "txt-1",
      pageIndex: 0,
      rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
      label: "Nombre",
      source: "acroform",
      confidence: "high",
    };
    let last: DetectedField[] = [field];
    render(
      <TextHarness
        initialFields={[field]}
        onFieldsChange={(fields) => (last = fields)}
      />,
    );
    await waitForTextPreview();

    const box = screen.getByRole("group", { name: "Nombre" });
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 160, clientY: 140 });
    // Un segundo dedo (pointerId distinto) suelta: no debe cerrar el
    // arrastre del primero ni abrir su editor.
    fireEvent.pointerUp(box, { pointerId: 2, clientX: 160, clientY: 140 });

    expect(screen.queryByRole("textbox", { name: "Nombre" })).toBeNull();
    expect(last[0].rect.x).toBeCloseTo(field.rect.x + 60 / HOST_WIDTH, 5);
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

  describe("navegacion por teclado (Recomendacion #1)", () => {
    const fieldA: DetectedField = {
      id: "txt-a",
      pageIndex: 0,
      rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
      source: "manual",
      confidence: "high",
    };
    const fieldB: DetectedField = {
      id: "txt-b",
      pageIndex: 0,
      rect: { x: 0.1, y: 0.3, width: 0.3, height: 0.05 },
      source: "manual",
      confidence: "high",
    };

    function openEditor(label: string) {
      fireEvent.pointerDown(screen.getByRole("group", { name: label }), {
        pointerId: 1,
        clientX: 100,
        clientY: 100,
      });
      fireEvent.pointerUp(screen.getByRole("group", { name: label }), {
        pointerId: 1,
      });
    }

    it("Enter confirma el campo y abre el editor del siguiente campo vacio", async () => {
      render(
        <TextHarness
          initialFields={[fieldA, fieldB]}
          onFieldsChange={() => {}}
          keyboardNavEnabled
        />,
      );
      await waitForTextPreview();

      openEditor("Campo 1");
      const inputA = screen.getByRole("textbox", { name: "Campo 1" });
      fireEvent.change(inputA, { target: { value: "Ana" } });
      fireEvent.keyDown(inputA, { key: "Enter" });

      expect(screen.queryByRole("textbox", { name: "Campo 1" })).toBeNull();
      expect(screen.getByRole("textbox", { name: "Campo 2" })).toBeTruthy();
    });

    it("Tab (sin Shift) tambien salta al siguiente campo vacio", async () => {
      render(
        <TextHarness
          initialFields={[fieldA, fieldB]}
          onFieldsChange={() => {}}
          keyboardNavEnabled
        />,
      );
      await waitForTextPreview();

      openEditor("Campo 1");
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Campo 1" }), {
        key: "Tab",
      });

      expect(screen.getByRole("textbox", { name: "Campo 2" })).toBeTruthy();
    });

    it("si no queda ningun campo vacio, Enter cierra el editor sin saltar", async () => {
      render(
        <TextHarness
          initialFields={[fieldA, fieldB]}
          initialValues={{ "txt-b": "ya lleno" }}
          onFieldsChange={() => {}}
          keyboardNavEnabled
        />,
      );
      await waitForTextPreview();

      openEditor("Campo 1");
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Campo 1" }), {
        key: "Enter",
      });

      expect(screen.queryByRole("textbox", { name: "Campo 1" })).toBeNull();
      expect(screen.queryByRole("textbox")).toBeNull();
    });

    it("con la funcion apagada, Enter no salta de campo (comportamiento previo)", async () => {
      render(
        <TextHarness
          initialFields={[fieldA, fieldB]}
          onFieldsChange={() => {}}
          keyboardNavEnabled={false}
        />,
      );
      await waitForTextPreview();

      openEditor("Campo 1");
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Campo 1" }), {
        key: "Enter",
      });

      // Sigue abierto: Enter no hace nada sin navegacion por teclado.
      expect(screen.getByRole("textbox", { name: "Campo 1" })).toBeTruthy();
    });
  });

  describe("deshacer al borrar un campo (Recomendacion #3)", () => {
    const field: DetectedField = {
      id: "txt-undo",
      pageIndex: 0,
      rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
      label: "Nombre",
      source: "acroform",
      confidence: "high",
    };

    function selectField(label: string) {
      fireEvent.pointerDown(screen.getByRole("group", { name: label }), {
        pointerId: 1,
        clientX: 100,
        clientY: 100,
      });
      fireEvent.pointerUp(screen.getByRole("group", { name: label }), {
        pointerId: 1,
      });
    }

    it("con la funcion activa, borrar muestra 'Deshacer' y el campo sigue fuera del array", async () => {
      let last: DetectedField[] = [field];
      render(
        <TextHarness
          initialFields={[field]}
          initialValues={{ "txt-undo": "Ana" }}
          onFieldsChange={(fields) => (last = fields)}
          undoDeleteEnabled
        />,
      );
      await waitForTextPreview();

      selectField("Nombre");
      fireEvent.click(screen.getByRole("button", { name: strings.removeTextField }));

      expect(last).toHaveLength(0);
      expect(screen.getByText(strings.textFieldDeletedNotice)).toBeTruthy();
    });

    it("'Deshacer' repone el campo en su posicion original, con su valor", async () => {
      let last: DetectedField[] = [field];
      let lastValues: Record<string, string> = { "txt-undo": "Ana" };
      render(
        <TextHarness
          initialFields={[field]}
          initialValues={{ "txt-undo": "Ana" }}
          onFieldsChange={(fields) => (last = fields)}
          onValuesChange={(values) => (lastValues = values)}
          undoDeleteEnabled
        />,
      );
      await waitForTextPreview();

      selectField("Nombre");
      fireEvent.click(screen.getByRole("button", { name: strings.removeTextField }));
      expect(last).toHaveLength(0);

      fireEvent.click(
        screen.getByRole("button", { name: strings.undoRemoveTextField }),
      );

      expect(last).toEqual([field]);
      expect(lastValues["txt-undo"]).toBe("Ana");
      expect(screen.queryByText(strings.textFieldDeletedNotice)).toBeNull();
    });

    it(
      "pasados 6s sin deshacer, el aviso desaparece y el borrado queda en firme",
      async () => {
        let last: DetectedField[] = [field];
        render(
          <TextHarness
            initialFields={[field]}
            onFieldsChange={(fields) => (last = fields)}
            undoDeleteEnabled
          />,
        );
        await waitForTextPreview();

        selectField("Nombre");
        fireEvent.click(
          screen.getByRole("button", { name: strings.removeTextField }),
        );
        expect(screen.getByText(strings.textFieldDeletedNotice)).toBeTruthy();

        // Timers reales de proposito (no fake): `waitFor` de Testing
        // Library depende de temporizadores reales para sondear, y esto
        // solo espera un `setTimeout` de la propia app, no un reloj
        // simulado.
        await waitFor(
          () =>
            expect(
              screen.queryByText(strings.textFieldDeletedNotice),
            ).toBeNull(),
          { timeout: 6500, interval: 250 },
        );
        expect(last).toHaveLength(0);
      },
      7000,
    );

    it("borrar un segundo campo reemplaza el aviso pendiente: el primero ya no es deshacible", async () => {
      const fieldB: DetectedField = {
        id: "txt-undo-b",
        pageIndex: 0,
        rect: { x: 0.1, y: 0.4, width: 0.3, height: 0.05 },
        label: "Apellido",
        source: "acroform",
        confidence: "high",
      };
      let last: DetectedField[] = [field, fieldB];
      render(
        <TextHarness
          initialFields={[field, fieldB]}
          onFieldsChange={(fields) => (last = fields)}
          undoDeleteEnabled
        />,
      );
      await waitForTextPreview();

      selectField("Nombre");
      fireEvent.click(screen.getByRole("button", { name: strings.removeTextField }));
      selectField("Apellido");
      fireEvent.click(screen.getByRole("button", { name: strings.removeTextField }));

      fireEvent.click(
        screen.getByRole("button", { name: strings.undoRemoveTextField }),
      );

      // Solo "Apellido" (el ultimo borrado) vuelve; "Nombre" quedo en firme.
      expect(last).toHaveLength(1);
      expect(last[0].id).toBe("txt-undo-b");
    });

    it("Delete/Backspace con un campo seleccionado tambien pasa por el mismo deshacer", async () => {
      let last: DetectedField[] = [field];
      render(
        <TextHarness
          initialFields={[field]}
          onFieldsChange={(fields) => (last = fields)}
          undoDeleteEnabled
        />,
      );
      await waitForTextPreview();

      selectField("Nombre");
      fireEvent.keyDown(window, { key: "Delete" });

      expect(last).toHaveLength(0);
      expect(screen.getByText(strings.textFieldDeletedNotice)).toBeTruthy();
    });

    it("con la funcion apagada, borrar no muestra ningun aviso (comportamiento previo)", async () => {
      let last: DetectedField[] = [field];
      render(
        <TextHarness
          initialFields={[field]}
          onFieldsChange={(fields) => (last = fields)}
          undoDeleteEnabled={false}
        />,
      );
      await waitForTextPreview();

      selectField("Nombre");
      fireEvent.click(screen.getByRole("button", { name: strings.removeTextField }));

      expect(last).toHaveLength(0);
      expect(screen.queryByText(strings.textFieldDeletedNotice)).toBeNull();
    });
  });

  describe("tipos de campo enriquecidos (Recomendacion #5)", () => {
    const field: DetectedField = {
      id: "txt-rich",
      pageIndex: 0,
      rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
      label: "Consentimiento",
      source: "manual",
      confidence: "high",
    };

    function selectField(label: string) {
      fireEvent.pointerDown(screen.getByRole("group", { name: label }), {
        pointerId: 1,
        clientX: 100,
        clientY: 100,
      });
      fireEvent.pointerUp(screen.getByRole("group", { name: label }), {
        pointerId: 1,
      });
    }

    it("con la funcion apagada, no aparece el selector de tipo al elegir un campo", async () => {
      render(
        <TextHarness
          initialFields={[field]}
          onFieldsChange={() => {}}
          richFieldTypesEnabled={false}
        />,
      );
      await waitForTextPreview();

      selectField("Consentimiento");
      expect(
        screen.queryByRole("tablist", { name: strings.textFieldTypeLabel }),
      ).toBeNull();
    });

    it("con la funcion activa, elegir un campo muestra el selector de tipo", async () => {
      render(
        <TextHarness
          initialFields={[field]}
          onFieldsChange={() => {}}
          richFieldTypesEnabled
        />,
      );
      await waitForTextPreview();

      selectField("Consentimiento");
      expect(
        screen.getByRole("tablist", { name: strings.textFieldTypeLabel }),
      ).toBeTruthy();
    });

    it("cambiar el tipo a 'Casilla' actualiza el campo y borra el valor anterior", async () => {
      let last: DetectedField[] = [field];
      let lastValues: Record<string, string> = { "txt-rich": "Ana Perez" };
      render(
        <TextHarness
          initialFields={[field]}
          initialValues={{ "txt-rich": "Ana Perez" }}
          onFieldsChange={(fields) => (last = fields)}
          onValuesChange={(values) => (lastValues = values)}
          richFieldTypesEnabled
        />,
      );
      await waitForTextPreview();

      selectField("Consentimiento");
      fireEvent.click(
        screen.getByRole("tab", { name: strings.fieldTypeCheckbox }),
      );

      expect(last[0].type).toBe("checkbox");
      // El valor de texto anterior no tiene sentido en una casilla: se limpia.
      expect(lastValues["txt-rich"]).toBe("");
    });

    it("una casilla se marca/desmarca con un toque limpio, sin abrir ningun editor", async () => {
      const checkboxField: DetectedField = { ...field, type: "checkbox" };
      let lastValues: Record<string, string> = {};
      render(
        <TextHarness
          initialFields={[checkboxField]}
          onFieldsChange={() => {}}
          onValuesChange={(values) => (lastValues = values)}
        />,
      );
      await waitForTextPreview();

      const box = screen.getByRole("group", { name: "Consentimiento" });
      fireEvent.pointerDown(box, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerUp(box, { pointerId: 1 });

      expect(lastValues["txt-rich"]).toBe("true");
      // Ninguna casilla abre un input de texto: no hay modo "editar".
      expect(screen.queryByRole("textbox")).toBeNull();

      fireEvent.pointerDown(box, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerUp(box, { pointerId: 1 });
      expect(lastValues["txt-rich"]).toBe("");
    });

    it("un campo de tipo 'inicial' limita a 4 caracteres y los pone en mayusculas", async () => {
      const initialsField: DetectedField = { ...field, type: "initials" };
      render(
        <TextHarness initialFields={[initialsField]} onFieldsChange={() => {}} />,
      );
      await waitForTextPreview();

      selectField("Consentimiento");
      const box = screen.getByRole("group", { name: "Consentimiento" });
      fireEvent.pointerDown(box, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerUp(box, { pointerId: 1 });

      const input = screen.getByRole("textbox", {
        name: "Consentimiento",
      }) as HTMLInputElement;
      expect(input.maxLength).toBe(4);
      fireEvent.change(input, { target: { value: "ap" } });
      expect(input.value).toBe("AP");
    });

    it("un campo de tipo 'fecha' abre un input de fecha nativo", async () => {
      const dateField: DetectedField = { ...field, type: "date" };
      render(<TextHarness initialFields={[dateField]} onFieldsChange={() => {}} />);
      await waitForTextPreview();

      selectField("Consentimiento");
      const box = screen.getByRole("group", { name: "Consentimiento" });
      fireEvent.pointerDown(box, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerUp(box, { pointerId: 1 });

      const input = screen
        .getByRole("group", { name: "Consentimiento" })
        .querySelector("input") as HTMLInputElement;
      expect(input.type).toBe("date");
    });
  });

  describe("zoom con pellizco (Recomendacion #7)", () => {
    function host(): HTMLElement {
      return screen.getByAltText(strings.textFieldsTitle).parentElement!;
    }

    it("con la funcion apagada, dos dedos no activan ningun zoom", async () => {
      render(<TextHarness onFieldsChange={() => {}} pinchZoomEnabled={false} />);
      await waitForTextPreview();

      const canvas = host();
      fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 250, clientY: 400 });
      fireEvent.pointerDown(canvas, { pointerId: 2, clientX: 350, clientY: 400 });
      fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 150, clientY: 400 });
      fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 450, clientY: 400 });

      expect(canvas.style.transform).toBeFalsy();
    });

    it("con la funcion activa, separar dos dedos aumenta el zoom (con tope)", async () => {
      render(<TextHarness onFieldsChange={() => {}} pinchZoomEnabled />);
      await waitForTextPreview();

      const canvas = host();
      fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 250, clientY: 400 });
      fireEvent.pointerDown(canvas, { pointerId: 2, clientX: 350, clientY: 400 });
      // Distancia inicial 100px -> distancia nueva 300px = factor 3, que
      // es justo el tope maximo (MAX_ZOOM).
      fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 150, clientY: 400 });
      fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 450, clientY: 400 });

      expect(canvas.style.transform).toContain("scale(3)");
    });

    it("un segundo dedo cancela el borrador de un campo nuevo en marcha, sin llegar a crearlo", async () => {
      let last: DetectedField[] = [];
      render(
        <TextHarness onFieldsChange={(fields) => (last = fields)} pinchZoomEnabled />,
      );
      await waitForTextPreview();

      const canvas = host();
      // Primer dedo: empieza a dibujar un campo nuevo.
      fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 100, clientY: 100 });
      // Segundo dedo: pasa a ser un pellizco, el borrador se cancela.
      fireEvent.pointerDown(canvas, { pointerId: 2, clientX: 200, clientY: 100 });
      fireEvent.pointerUp(canvas, { pointerId: 1 });
      fireEvent.pointerUp(canvas, { pointerId: 2 });

      expect(last).toHaveLength(0);
    });

    it("un segundo dedo no inicia el pellizco si el primero ya esta arrastrando un campo existente", async () => {
      const field: DetectedField = {
        id: "txt-pinch",
        pageIndex: 0,
        rect: { x: 0.3, y: 0.3, width: 0.2, height: 0.05 },
        label: "Campo",
        source: "manual",
        confidence: "high",
      };
      render(
        <TextHarness
          initialFields={[field]}
          onFieldsChange={() => {}}
          pinchZoomEnabled
        />,
      );
      await waitForTextPreview();

      // Primer dedo: arrastra el campo existente (mismo umbral que ya
      // prueba "un arrastre real mueve el campo" en otra parte de este
      // archivo).
      const box = screen.getByRole("group", { name: "Campo" });
      fireEvent.pointerDown(box, { pointerId: 1, clientX: 250, clientY: 350 });
      fireEvent.pointerMove(box, { pointerId: 1, clientX: 300, clientY: 350 });

      // Segundo dedo, en el lienzo vacio: no debe convertirse en un pellizco.
      const canvas = host();
      fireEvent.pointerDown(canvas, { pointerId: 2, clientX: 400, clientY: 400 });
      fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 500, clientY: 400 });

      expect(canvas.style.transform).toBeFalsy();
    });

    it("'Restablecer zoom' aparece tras pellizcar y lo devuelve a 1x", async () => {
      render(<TextHarness onFieldsChange={() => {}} pinchZoomEnabled />);
      await waitForTextPreview();

      const canvas = host();
      fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 250, clientY: 400 });
      fireEvent.pointerDown(canvas, { pointerId: 2, clientX: 350, clientY: 400 });
      fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 150, clientY: 400 });
      fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 450, clientY: 400 });
      expect(canvas.style.transform).toContain("scale(3)");

      fireEvent.click(
        screen.getByRole("button", { name: strings.resetZoomButton }),
      );
      expect(canvas.style.transform).toBeFalsy();
    });

    it("al soltar los dedos con un zoom casi en 1x, encaja exactamente en 1 (sin residuo)", async () => {
      render(<TextHarness onFieldsChange={() => {}} pinchZoomEnabled />);
      await waitForTextPreview();

      const canvas = host();
      fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 250, clientY: 400 });
      fireEvent.pointerDown(canvas, { pointerId: 2, clientX: 350, clientY: 400 });
      // Distancia inicial 100px -> 101px = factor 1.01: por encima de 1,
      // pero por debajo del margen de "casi 1" (1.02) que encaja al soltar.
      fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 200.5, clientY: 400 });
      fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 301.5, clientY: 400 });
      expect(canvas.style.transform).toContain("scale(1.01");

      fireEvent.pointerUp(canvas, { pointerId: 1 });
      fireEvent.pointerUp(canvas, { pointerId: 2 });
      expect(canvas.style.transform).toBeFalsy();
    });
  });
});
