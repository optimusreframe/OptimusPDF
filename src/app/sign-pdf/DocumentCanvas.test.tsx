import { useEffect, useState } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  DocumentCanvas,
  type CanvasSelection,
  type PlacementTool,
  type SoloConfig,
} from "@/app/sign-pdf/DocumentCanvas";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { __resetValueHistoryCacheForTests, clearValueHistory, recordValue } from "@/lib/valueHistory";
import { normalizeFieldLabel } from "@/lib/pdf/sign";
import type { SignatureField, Signer } from "@/lib/pdf/sign";
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
      // La pagina 2 es apaisada (800 x 600) y la 1 vertical (600 x 800), como en un PDF mixto.
      getPage: async (number: number) => ({
        cleanup: () => {},
        getViewport: () =>
          number === 2 ? { width: 800, height: 600 } : { width: 600, height: 800 },
      }),
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

/** Una sola instancia: `DocumentCanvas` se remonta si cambia la identidad del archivo. */
const FILE = new File([new Uint8Array([1, 2, 3])], "contrato.pdf", {
  type: "application/pdf",
});

/**
 * Un unico lienzo (W2-A) para huecos de firma Y campos de texto. El
 * harness expone ambos modelos con su propio estado, como `MultiFlow`:
 * `signers` vacio deja solo la herramienta de texto; con firmantes, la
 * herramienta por defecto es "hueco" y se cambia con el segmentado.
 */
type HarnessProps = {
  signers?: Signer[];
  tool?: PlacementTool;
  onFieldsChange?: (fields: SignatureField[]) => void;
  initialFields?: SignatureField[];
  activeSignerId?: string | null;
  onTextFieldsChange?: (fields: DetectedField[]) => void;
  initialTextFields?: DetectedField[];
  initialValues?: Record<string, string>;
  onValuesChange?: (values: Record<string, string>) => void;
  onEditingIdChange?: (id: string | null) => void;
  onSelectionChange?: (selection: CanvasSelection | null) => void;
  keyboardNavEnabled?: boolean;
  undoDeleteEnabled?: boolean;
  richFieldTypesEnabled?: boolean;
  pinchZoomEnabled?: boolean;
  /** Modo "Solo yo" (W2-C). */
  solo?: SoloConfig;
  /** Entrega el setter de la pagina visible: simula un cambio de pagina que NO pasa por el lienzo. */
  exposePageSetter?: (set: (index: number) => void) => void;
};

function Harness({
  signers = [ANA, LUIS],
  tool: initialTool = "signature",
  onFieldsChange,
  initialFields = [],
  activeSignerId: initialActiveSignerId = ANA.id,
  onTextFieldsChange,
  initialTextFields = [],
  initialValues = {},
  onValuesChange,
  onEditingIdChange,
  onSelectionChange,
  keyboardNavEnabled,
  undoDeleteEnabled,
  richFieldTypesEnabled,
  pinchZoomEnabled,
  solo,
  exposePageSetter,
}: HarnessProps) {
  const [tool, setTool] = useState<PlacementTool>(initialTool);
  const [fields, setFields] = useState<SignatureField[]>(initialFields);
  const [pageIndex, setPageIndex] = useState(0);
  const [selection, setSelection] = useState<CanvasSelection | null>(null);
  const [activeSignerId, setActiveSignerId] = useState<string | null>(
    initialActiveSignerId,
  );
  const [textFields, setTextFields] = useState<DetectedField[]>(initialTextFields);
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => {
    exposePageSetter?.(setPageIndex);
  }, [exposePageSetter]);

  return (
    <DocumentCanvas
      file={FILE}
      signers={signers}
      activeSignerId={activeSignerId}
      onActiveSignerIdChange={setActiveSignerId}
      tool={tool}
      onToolChange={setTool}
      slots={fields}
      onSlotsChange={(next) => {
        setFields(next);
        onFieldsChange?.(next);
      }}
      textFields={textFields}
      onTextFieldsChange={(next) => {
        setTextFields(next);
        onTextFieldsChange?.(next);
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
      selection={selection}
      onSelectionChange={(next) => {
        setSelection(next);
        onSelectionChange?.(next);
      }}
      editingId={editingId}
      onEditingIdChange={(id) => {
        setEditingId(id);
        onEditingIdChange?.(id);
      }}
      strings={strings}
      keyboardNavEnabled={keyboardNavEnabled}
      undoDeleteEnabled={undoDeleteEnabled}
      richFieldTypesEnabled={richFieldTypesEnabled}
      pinchZoomEnabled={pinchZoomEnabled}
      solo={solo}
    />
  );
}

/** La paleta de herramientas (W2-B): un `toolbar` con un boton por herramienta. */
const palette = () => screen.getByRole("toolbar", { name: strings.paletteLabel });

/** Arma una herramienta de la paleta por su nombre. */
const armTool = (name: string) =>
  fireEvent.click(within(palette()).getByRole("button", { name }));

/** Nombre de la barra flotante: "Acciones de «elemento»". */
const BAR_NAME = /^Acciones de /;
/** Boton de la barra que abre el selector de tipo ("Cambiar el tipo de campo (ahora: Texto)"). */
const CHANGE_TYPE = /^Cambiar el tipo de campo/;
/** Abre el selector de tipo de la barra y devuelve su grupo de opciones. */
const openTypePicker = () => {
  fireEvent.click(within(floatingBar()).getByRole("button", { name: CHANGE_TYPE }));
  return within(floatingBar()).getByRole("group", {
    name: startsWith(strings.textFieldTypeLabel),
  });
};
/** Boton de la barra por el comienzo de su nombre ("Quitar el campo «Nombre, pendiente»"). */
const startsWith = (prefix: string) =>
  new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

/** La barra flotante del elemento seleccionado. */
const floatingBar = () => screen.getByRole("group", { name: BAR_NAME });

/** Espera a que la vista previa simulada este montada. */
/**
 * Captura los `window.setTimeout` de EXACTAMENTE `delayMs` en vez de
 * esperarlos de verdad. Los avisos «Deshacer» caducan a los 6 s con un
 * temporizador de la propia app: esperarlo en tiempo real hacia que dos
 * tests tardasen 6-7 s (y fallasen por plazo en una maquina cargada).
 * Aqui se comprueba lo mismo, que lo dispara un temporizador de ESE plazo
 * y que al dispararse desaparece el aviso, sin esperar el reloj. Los demas
 * temporizadores (los de `waitFor`, por ejemplo) siguen siendo reales.
 */
function captureTimeouts(delayMs: number) {
  const realSetTimeout = window.setTimeout.bind(window);
  const captured: (() => void)[] = [];
  const spy = vi.spyOn(window, "setTimeout").mockImplementation(((
    handler: TimerHandler,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === delayMs && typeof handler === "function") {
      captured.push(() => (handler as (...a: unknown[]) => void)(...args));
      return 0;
    }
    return realSetTimeout(handler, delay, ...args);
  }) as typeof window.setTimeout);
  return {
    /** Dispara el temporizador vigente (el ultimo registrado), dentro de `act`. */
    fireLatest() {
      expect(captured.length).toBeGreaterThan(0);
      act(() => captured[captured.length - 1]());
    },
    restore: () => spy.mockRestore(),
  };
}

async function waitForPreview() {
  await waitFor(() =>
    expect(screen.getByAltText(strings.documentTitle)).toBeTruthy(),
  );
}

/** Nombre accesible de un hueco: "Ana — Firma, hueco de firma". */
const slotName = (label: string) => `${label}, ${strings.a11ySlot}`;
const signatureLabel = slotName(
  strings.fieldOwnerLabel(ANA.name, strings.fieldSignature),
);
const initialsLabel = slotName(
  strings.fieldOwnerLabel(ANA.name, strings.fieldInitials),
);

/** Campo de texto por su etiqueta: el nombre accesible lleva ademas el estado ("Nombre, pendiente"). */
function textGroup(label: string): HTMLElement {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return screen.getByRole("group", {
    name: new RegExp(`^${escaped}, (${strings.a11yPending}|${strings.a11yFilled})$`),
  });
}

describe("DocumentCanvas (huecos de firma) — src/app/sign-pdf/DocumentCanvas.tsx", () => {
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

    armTool(strings.fieldInitials);
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

    const host = screen.getByAltText(strings.documentTitle).parentElement!;
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

    fireEvent.click(screen.getByRole("button", { name: startsWith(strings.removeField) }));

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
      fireEvent.click(screen.getByRole("button", { name: startsWith(strings.removeField) }));

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
      fireEvent.click(screen.getByRole("button", { name: startsWith(strings.removeField) }));
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
      fireEvent.click(screen.getByRole("button", { name: startsWith(strings.removeField) }));

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

    // Cada herramienta es de un solo uso: se vuelve a armar.
    armTool(strings.fieldSignature);
    fireEvent.click(screen.getByRole("button", { name: strings.addFieldHere }));

    expect(last).toHaveLength(2);
    // El hueco anterior sigue siendo de Ana; solo el nuevo cambia de dueño.
    expect(last[0].signerId).toBe(ANA.id);
    expect(last[1].signerId).toBe(LUIS.id);
    expect(
      screen.getByRole("group", {
        name: slotName(strings.fieldOwnerLabel(LUIS.name, strings.fieldSignature)),
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

    // Con la herramienta Firma armada, "borrar todos" se limita a los huecos.
    armTool(strings.fieldSignature);
    fireEvent.click(screen.getByRole("button", { name: strings.clearAllFields }));
    // Un solo toque en el boton NO debe mutar el estado: solo abre el Sheet.
    expect(last).toHaveLength(1);
    expect(screen.getByText(strings.confirmClearAllFieldsBody)).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: strings.confirmCancel }),
    );
    expect(last).toHaveLength(1);
    // El Sheet anima su salida (W1-B) antes de desmontar el contenido.
    await waitFor(() =>
      expect(screen.queryByText(strings.confirmClearAllFieldsBody)).toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: strings.clearAllFields }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: strings.clearAllFields }),
    );
    expect(last).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Campos de texto: mismo gesto de colocacion, sin firmante ni tipo de
 * hueco. Sin firmantes, el lienzo solo ofrece la herramienta de texto.
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
  onEditingIdChange?: (id: string | null) => void;
};

function TextHarness({
  onFieldsChange,
  initialFields = [],
  ...rest
}: TextHarnessProps) {
  return (
    <Harness
      signers={[]}
      tool="text"
      activeSignerId={null}
      onTextFieldsChange={onFieldsChange}
      initialTextFields={initialFields}
      {...rest}
    />
  );
}

const waitForTextPreview = waitForPreview;

describe("DocumentCanvas (campos de texto) — src/app/sign-pdf/DocumentCanvas.tsx", () => {
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

    const host = screen.getByAltText(strings.documentTitle).parentElement!;
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

    fireEvent.pointerDown(textGroup("Nombre"), {
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerUp(textGroup("Nombre"), {
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
    fireEvent.pointerDown(textGroup(label), {
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerUp(textGroup(label), {
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

    const box = textGroup("Nombre");
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

    const box = textGroup("Nombre");
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

    const box = textGroup("Nombre");
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

    fireEvent.click(screen.getByRole("button", { name: startsWith(strings.removeTextField) }));
    expect(last).toHaveLength(0);
  });

  it("sin ningun campo se muestra el aviso opcional, no un error", async () => {
    render(<TextHarness onFieldsChange={() => {}} />);
    await waitForTextPreview();

    expect(screen.getByText(strings.canvasEmptyHint)).toBeTruthy();
  });

  it("'Borrar todos los campos' no borra nada hasta confirmar en el Sheet", async () => {
    let last: DetectedField[] = [];
    render(<TextHarness onFieldsChange={(fields) => (last = fields)} />);
    await waitForTextPreview();

    fireEvent.click(
      screen.getByRole("button", { name: strings.addTextFieldHere }),
    );
    expect(last).toHaveLength(1);

    // Con la herramienta Texto armada, "borrar todos" se limita a los campos.
    armTool(strings.fieldTypeText);
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
      fireEvent.pointerDown(textGroup(label), {
        pointerId: 1,
        clientX: 100,
        clientY: 100,
      });
      fireEvent.pointerUp(textGroup(label), {
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

    it("al terminar la cola con Enter (o Tab) el foco vuelve al propio campo, nunca a <body>", async () => {
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

      await waitFor(() =>
        expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Campo 1, /),
      );
      expect(document.activeElement).not.toBe(document.body);
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

    describe("casillas alcanzables por teclado (limitacion 4.2)", () => {
      const checkboxField: DetectedField = {
        id: "txt-c",
        pageIndex: 0,
        rect: { x: 0.5, y: 0.5, width: 0.15, height: 0.05 },
        source: "manual",
        confidence: "high",
        type: "checkbox",
      };
      const checkboxField2: DetectedField = {
        id: "txt-d",
        pageIndex: 0,
        rect: { x: 0.5, y: 0.7, width: 0.15, height: 0.05 },
        source: "manual",
        confidence: "high",
        type: "checkbox",
      };

      it("Enter desde un campo de texto aterriza en la casilla sin marcar, la enfoca y no cambia su valor", async () => {
        let lastValues: Record<string, string> = {};
        render(
          <TextHarness
            initialFields={[fieldA, checkboxField]}
            onFieldsChange={() => {}}
            onValuesChange={(values) => (lastValues = values)}
            keyboardNavEnabled
          />,
        );
        await waitForTextPreview();

        openEditor("Campo 1");
        fireEvent.keyDown(screen.getByRole("textbox", { name: "Campo 1" }), {
          key: "Enter",
        });

        const checkbox = screen.getByRole("checkbox", { name: "Campo 2" });
        expect(checkbox).toBe(document.activeElement);
        expect(checkbox.getAttribute("aria-checked")).toBe("false");
        expect(lastValues["txt-c"] ?? "").toBe("");
      });

      it("la barra espaciadora sobre la casilla enfocada la marca y no avanza a otro campo", async () => {
        render(
          <TextHarness
            initialFields={[fieldA, checkboxField]}
            onFieldsChange={() => {}}
            keyboardNavEnabled
          />,
        );
        await waitForTextPreview();

        openEditor("Campo 1");
        fireEvent.keyDown(screen.getByRole("textbox", { name: "Campo 1" }), {
          key: "Enter",
        });
        const checkbox = screen.getByRole("checkbox", { name: "Campo 2" });
        fireEvent.keyDown(checkbox, { key: " " });

        expect(checkbox.getAttribute("aria-checked")).toBe("true");
        // Sigue siendo el mismo nodo: la barra espaciadora no avanzo de campo.
        expect(screen.getByRole("checkbox", { name: "Campo 2" })).toBe(checkbox);
      });

      it("Tab desde la casilla sin marcarla avanza al siguiente campo pendiente, sin cambiar su valor", async () => {
        render(
          <TextHarness
            initialFields={[fieldA, checkboxField, fieldB]}
            initialValues={{ "txt-a": "Ana" }}
            onFieldsChange={() => {}}
            keyboardNavEnabled
          />,
        );
        await waitForTextPreview();

        openEditor("Campo 1");
        fireEvent.keyDown(screen.getByRole("textbox", { name: "Campo 1" }), {
          key: "Enter",
        });
        const checkbox = screen.getByRole("checkbox", { name: "Campo 2" });
        fireEvent.keyDown(checkbox, { key: "Tab" });

        expect(checkbox.getAttribute("aria-checked")).toBe("false");
        expect(screen.getByRole("textbox", { name: "Campo 3" })).toBeTruthy();
      });

      it("una casilla ya marcada se salta durante la navegacion (no vuelve a ofrecerse)", async () => {
        render(
          <TextHarness
            initialFields={[fieldA, checkboxField, fieldB]}
            initialValues={{ "txt-c": "true" }}
            onFieldsChange={() => {}}
            keyboardNavEnabled
          />,
        );
        await waitForTextPreview();

        openEditor("Campo 1");
        fireEvent.keyDown(screen.getByRole("textbox", { name: "Campo 1" }), {
          key: "Enter",
        });

        // Salta directo a Campo 3 (texto): la casilla ya marcada no cuenta
        // como pendiente.
        expect(screen.getByRole("textbox", { name: "Campo 3" })).toBeTruthy();
      });

      it("dos casillas sin marcar terminan la navegacion sin bucle: la tercera vez cierra el editor", async () => {
        let lastEditingId: string | null = "unset";
        render(
          <TextHarness
            initialFields={[fieldA, checkboxField, checkboxField2]}
            initialValues={{ "txt-a": "Ana" }}
            onFieldsChange={() => {}}
            onEditingIdChange={(id) => (lastEditingId = id)}
            keyboardNavEnabled
          />,
        );
        await waitForTextPreview();

        openEditor("Campo 1");
        fireEvent.keyDown(screen.getByRole("textbox", { name: "Campo 1" }), {
          key: "Enter",
        });
        const checkbox1 = screen.getByRole("checkbox", { name: "Campo 2" });
        fireEvent.keyDown(checkbox1, { key: "Tab" });
        const checkbox2 = screen.getByRole("checkbox", { name: "Campo 3" });
        expect(checkbox2).toBe(document.activeElement);
        fireEvent.keyDown(checkbox2, { key: "Tab" });

        // Nada quedaba pendiente (Campo 1 relleno, ambas casillas ya
        // tocadas): el editor se cierra en vez de volver a Campo 2.
        expect(lastEditingId).toBeNull();
      });

      it("alternar una casilla dos veces por toque (marcar y desmarcar) la deja tocada: no reaparece como pendiente", async () => {
        let lastEditingId: string | null = "unset";
        render(
          <TextHarness
            initialFields={[checkboxField, fieldA]}
            onFieldsChange={() => {}}
            onEditingIdChange={(id) => (lastEditingId = id)}
            keyboardNavEnabled
          />,
        );
        await waitForTextPreview();

        const group = textGroup("Campo 1");
        fireEvent.pointerDown(group, { pointerId: 1, clientX: 100, clientY: 100 });
        fireEvent.pointerUp(group, { pointerId: 1 });
        fireEvent.pointerDown(group, { pointerId: 1, clientX: 100, clientY: 100 });
        fireEvent.pointerUp(group, { pointerId: 1 });
        expect(
          screen.getByRole("checkbox", { name: "Campo 1" }).getAttribute("aria-checked"),
        ).toBe("false");

        openEditor("Campo 2");
        fireEvent.keyDown(screen.getByRole("textbox", { name: "Campo 2" }), {
          key: "Enter",
        });

        // La unica otra candidata es la casilla ya tocada: no hay a donde
        // saltar, el editor se cierra.
        expect(lastEditingId).toBeNull();
      });
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
      fireEvent.pointerDown(textGroup(label), {
        pointerId: 1,
        clientX: 100,
        clientY: 100,
      });
      fireEvent.pointerUp(textGroup(label), {
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
      fireEvent.click(screen.getByRole("button", { name: startsWith(strings.removeTextField) }));

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
      fireEvent.click(screen.getByRole("button", { name: startsWith(strings.removeTextField) }));
      expect(last).toHaveLength(0);

      fireEvent.click(
        screen.getByRole("button", { name: strings.undoRemoveTextField }),
      );

      expect(last).toEqual([field]);
      expect(lastValues["txt-undo"]).toBe("Ana");
      expect(screen.queryByText(strings.textFieldDeletedNotice)).toBeNull();
    });

    it("pasados 6s sin deshacer, el aviso desaparece y el borrado queda en firme", async () => {
      let last: DetectedField[] = [field];
      render(
        <TextHarness
          initialFields={[field]}
          onFieldsChange={(fields) => (last = fields)}
          undoDeleteEnabled
        />,
      );
      await waitForTextPreview();

      // El temporizador de 6 s se captura ANTES de borrar (ver captureTimeouts).
      const timers = captureTimeouts(6000);
      try {
        selectField("Nombre");
        fireEvent.click(
          screen.getByRole("button", { name: startsWith(strings.removeTextField) }),
        );
        expect(screen.getByText(strings.textFieldDeletedNotice)).toBeTruthy();

        timers.fireLatest();
        expect(screen.queryByText(strings.textFieldDeletedNotice)).toBeNull();
        expect(last).toHaveLength(0);
      } finally {
        timers.restore();
      }
    });

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
      fireEvent.click(screen.getByRole("button", { name: startsWith(strings.removeTextField) }));
      selectField("Apellido");
      fireEvent.click(screen.getByRole("button", { name: startsWith(strings.removeTextField) }));

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
      fireEvent.click(screen.getByRole("button", { name: startsWith(strings.removeTextField) }));

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
      fireEvent.pointerDown(textGroup(label), {
        pointerId: 1,
        clientX: 100,
        clientY: 100,
      });
      fireEvent.pointerUp(textGroup(label), {
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
        screen.queryByRole("button", { name: CHANGE_TYPE }),
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
        within(floatingBar()).getByRole("button", { name: CHANGE_TYPE }),
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
        within(openTypePicker()).getByRole("button", { name: strings.fieldTypeCheckbox }),
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

      const box = textGroup("Consentimiento");
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
      const box = textGroup("Consentimiento");
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
      const box = textGroup("Consentimiento");
      fireEvent.pointerDown(box, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerUp(box, { pointerId: 1 });

      const input = textGroup("Consentimiento")
        .querySelector("input") as HTMLInputElement;
      expect(input.type).toBe("date");
    });
  });

  describe("zoom con pellizco (Recomendacion #7)", () => {
    function host(): HTMLElement {
      return screen.getByAltText(strings.documentTitle).parentElement!;
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
      const box = textGroup("Campo");
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

/* ------------------------------------------------------------------ *
 * Lienzo unificado (W2-A): huecos y campos de texto a la vez, una sola
 * seleccion, un solo "Deshacer", teclado sobre ambos tipos.
 * ------------------------------------------------------------------ */

describe("DocumentCanvas (lienzo unificado, W2-A) — src/app/sign-pdf/DocumentCanvas.tsx", () => {
  const SLOT: SignatureField = {
    id: "fld-u1",
    signerId: ANA.id,
    pageIndex: 0,
    type: "signature",
    rect: { x: 0.1, y: 0.6, width: 0.3, height: 0.1 },
  };
  const NAME: DetectedField = {
    id: "txt-u1",
    pageIndex: 0,
    rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
    label: "Nombre",
    source: "acroform",
    confidence: "high",
  };

  function tap(element: HTMLElement) {
    fireEvent.pointerDown(element, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(element, { pointerId: 1 });
  }

  it("muestra a la vez los huecos y los campos de texto de la pagina, cada uno con su nombre accesible", async () => {
    render(<Harness initialFields={[SLOT]} initialTextFields={[NAME]} />);
    await waitForPreview();

    expect(screen.getByRole("group", { name: signatureLabel })).toBeTruthy();
    expect(
      screen.getByRole("group", { name: `Nombre, ${strings.a11yPending}` }),
    ).toBeTruthy();
  });

  it("el nombre accesible de un campo de texto refleja su estado: pendiente -> rellenado", async () => {
    render(
      <Harness
        initialTextFields={[NAME]}
        initialValues={{ "txt-u1": "Ana" }}
      />,
    );
    await waitForPreview();

    expect(
      screen.getByRole("group", { name: `Nombre, ${strings.a11yFilled}` }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("group", { name: `Nombre, ${strings.a11yPending}` }),
    ).toBeNull();
  });

  it("solo hay UNA seleccion: elegir un campo de texto deselecciona el hueco (y viceversa)", async () => {
    const selections: Array<CanvasSelection | null> = [];
    render(
      <Harness
        initialFields={[SLOT]}
        initialTextFields={[NAME]}
        onSelectionChange={(selection) => selections.push(selection)}
      />,
    );
    await waitForPreview();

    tap(screen.getByRole("group", { name: signatureLabel }));
    expect(selections.at(-1)).toEqual({ kind: "slot", id: SLOT.id });
    // Los controles del hueco (quitar) estan; los del campo no.
    expect(screen.getByRole("button", { name: startsWith(strings.removeField) })).toBeTruthy();
    expect(screen.queryByRole("button", { name: startsWith(strings.removeTextField) })).toBeNull();

    tap(textGroup("Nombre"));
    expect(selections.at(-1)).toEqual({ kind: "text", id: NAME.id });
    expect(screen.queryByRole("button", { name: startsWith(strings.removeField) })).toBeNull();
    expect(screen.getByRole("button", { name: startsWith(strings.removeTextField) })).toBeTruthy();

    // Tocar el campo de texto abrio su editor; volver al hueco lo cierra.
    expect(screen.getByRole("textbox", { name: "Nombre" })).toBeTruthy();
    tap(screen.getByRole("group", { name: signatureLabel }));
    expect(screen.queryByRole("textbox", { name: "Nombre" })).toBeNull();
    expect(selections.at(-1)).toEqual({ kind: "slot", id: SLOT.id });
  });

  it("el elemento seleccionado (hueco o campo) se apila por encima de los demas, para que sus controles no queden tapados", async () => {
    render(<Harness initialFields={[SLOT]} initialTextFields={[NAME]} />);
    await waitForPreview();

    const slot = screen.getByRole("group", { name: signatureLabel });
    const text = textGroup("Nombre");
    expect(slot.style.zIndex).toBe("");
    expect(text.style.zIndex).toBe("");

    tap(slot);
    expect(screen.getByRole("group", { name: signatureLabel }).style.zIndex).toBe("20");
    expect(textGroup("Nombre").style.zIndex).toBe("");

    tap(textGroup("Nombre"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(textGroup("Nombre").style.zIndex).toBe("20");
    expect(screen.getByRole("group", { name: signatureLabel }).style.zIndex).toBe("");
  });

  it("Supr borra el elemento seleccionado sea del tipo que sea, y 'Deshacer' repone exactamente ese (mismo id)", async () => {
    let slots: SignatureField[] = [SLOT];
    let texts: DetectedField[] = [NAME];
    render(
      <Harness
        initialFields={[SLOT]}
        initialTextFields={[NAME]}
        initialValues={{ "txt-u1": "Ana" }}
        onFieldsChange={(next) => (slots = next)}
        onTextFieldsChange={(next) => (texts = next)}
        undoDeleteEnabled
      />,
    );
    await waitForPreview();

    // Hueco seleccionado + Supr -> aviso del hueco, el campo sigue intacto.
    tap(screen.getByRole("group", { name: signatureLabel }));
    fireEvent.keyDown(window, { key: "Delete" });
    expect(slots).toHaveLength(0);
    expect(texts).toHaveLength(1);
    expect(screen.getByText(strings.fieldDeletedNotice)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.undoRemoveField }));
    expect(slots.map((field) => field.id)).toEqual([SLOT.id]);

    // Campo seleccionado (sin editor abierto: Escape) + Supr -> aviso del campo.
    tap(textGroup("Nombre"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Nombre" })).toBeNull();
    fireEvent.keyDown(window, { key: "Delete" });
    expect(texts).toHaveLength(0);
    expect(slots).toHaveLength(1);
    expect(screen.getByText(strings.textFieldDeletedNotice)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.undoRemoveTextField }));
    expect(texts).toEqual([NAME]);
  });

  it("con firmantes, la herramienta de la paleta decide que crea el proximo gesto: Seleccionar no crea nada", async () => {
    let slots: SignatureField[] = [];
    let texts: DetectedField[] = [];
    render(
      <Harness
        tool="select"
        onFieldsChange={(next) => (slots = next)}
        onTextFieldsChange={(next) => (texts = next)}
      />,
    );
    await waitForPreview();
    const host = screen.getByAltText(strings.documentTitle).parentElement!;

    // Seleccionar (por defecto): ni "anadir aqui" ni un toque sobre la pagina crean nada.
    expect(screen.queryByRole("button", { name: strings.addFieldHere })).toBeNull();
    expect(screen.queryByRole("button", { name: strings.addTextFieldHere })).toBeNull();
    fireEvent.pointerDown(host, { pointerId: 2, clientX: 60, clientY: 80 });
    fireEvent.pointerUp(host, { pointerId: 2, clientX: 60, clientY: 80 });
    expect(slots).toHaveLength(0);
    expect(texts).toHaveLength(0);

    armTool(strings.fieldTypeText);
    expect(screen.queryByRole("button", { name: strings.addFieldHere })).toBeNull();
    // Dibujar sobre el lienzo crea ahora un campo de texto, no un hueco...
    fireEvent.pointerDown(host, { pointerId: 2, clientX: 60, clientY: 80 });
    fireEvent.pointerMove(host, { pointerId: 2, clientX: 360, clientY: 140 });
    fireEvent.pointerUp(host, { pointerId: 2, clientX: 360, clientY: 140 });
    expect(slots).toHaveLength(0);
    expect(texts).toHaveLength(1);
    expect(texts[0].source).toBe("manual");
    // ...y la herramienta vuelve a Seleccionar.
    expect(
      within(palette())
        .getByRole("button", { name: strings.toolSelect })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    armTool(strings.fieldSignature);
    fireEvent.click(screen.getByRole("button", { name: strings.addFieldHere }));
    expect(slots).toHaveLength(1);
    expect(texts).toHaveLength(1);
  });

  it("sin firmantes no hay segmentado: solo campos de texto, con la pista de que los huecos piden un firmante", async () => {
    render(<TextHarness onFieldsChange={() => {}} />);
    await waitForPreview();

    // Sin firmantes, Firma e Iniciales no estan en la paleta.
    expect(within(palette()).queryByRole("button", { name: strings.fieldSignature })).toBeNull();
    expect(within(palette()).queryByRole("button", { name: strings.fieldInitials })).toBeNull();
    expect(screen.getByText(strings.slotsNeedSigners)).toBeTruthy();
    expect(screen.getByRole("button", { name: strings.addTextFieldHere })).toBeTruthy();
    expect(screen.queryByRole("button", { name: strings.addFieldHere })).toBeNull();
  });

  it("los elementos del lienzo son enfocables: Enter sobre un campo abre su editor, sobre un hueco lo selecciona, y Supr lo borra", async () => {
    let slots: SignatureField[] = [SLOT];
    render(
      <Harness
        initialFields={[SLOT]}
        initialTextFields={[NAME]}
        onFieldsChange={(next) => (slots = next)}
      />,
    );
    await waitForPreview();

    const nameBox = textGroup("Nombre");
    expect(nameBox.getAttribute("tabindex")).toBe("0");
    nameBox.focus();
    expect(document.activeElement).toBe(nameBox);
    fireEvent.keyDown(nameBox, { key: "Enter" });
    expect(screen.getByRole("textbox", { name: "Nombre" })).toBeTruthy();

    const slotBox = screen.getByRole("group", { name: signatureLabel });
    expect(slotBox.getAttribute("tabindex")).toBe("0");
    slotBox.focus();
    fireEvent.keyDown(slotBox, { key: "Enter" });
    // Enfocar/Enter selecciona el hueco y cierra el editor del campo.
    expect(screen.getByRole("button", { name: startsWith(strings.removeField) })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Nombre" })).toBeNull();

    fireEvent.keyDown(slotBox, { key: "Delete" });
    expect(slots).toHaveLength(0);
  });

  it("Tab/Enter recorre los campos pendientes en orden de lectura (arriba-abajo), no en el orden del array", async () => {
    const top: DetectedField = { ...NAME, id: "txt-top", label: "Arriba", rect: { ...NAME.rect, y: 0.1 } };
    const middle: DetectedField = { ...NAME, id: "txt-mid", label: "Medio", rect: { ...NAME.rect, y: 0.3 } };
    const bottom: DetectedField = { ...NAME, id: "txt-bottom", label: "Abajo", rect: { ...NAME.rect, y: 0.5 } };
    render(
      <TextHarness
        // Array desordenado a proposito: el de abajo va en medio.
        initialFields={[top, bottom, middle]}
        onFieldsChange={() => {}}
        keyboardNavEnabled
      />,
    );
    await waitForPreview();

    tap(textGroup("Arriba"));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Arriba" }), { key: "Enter" });
    expect(screen.getByRole("textbox", { name: "Medio" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Medio" }), { key: "Enter" });
    expect(screen.getByRole("textbox", { name: "Abajo" })).toBeTruthy();
  });

  it("no hay ningun formulario ni input fuera del lienzo: el unico input es el editor en linea sobre el documento", async () => {
    const { container } = render(
      <Harness initialFields={[SLOT]} initialTextFields={[NAME]} />,
    );
    await waitForPreview();
    tap(textGroup("Nombre"));

    const host = container.querySelector('[data-canvas="host"]');
    expect(host).toBeTruthy();
    const inputs = [...container.querySelectorAll("input, textarea, select, form")];
    expect(inputs).toHaveLength(1);
    expect(inputs.every((input) => host!.contains(input))).toBe(true);
  });
});

describe("DocumentCanvas — Escape desde el editor en linea (W2-A)", () => {
  // Sin historial de valores de otros tests no hay sugerencias: con ellas, el primer Escape solo las cierra.
  beforeEach(() => {
    clearValueHistory();
    __resetValueHistoryCacheForTests();
  });

  const NAME: DetectedField = {
    id: "txt-esc",
    pageIndex: 0,
    rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
    label: "Nombre",
    source: "acroform",
    confidence: "high",
  };

  it("Escape pulsado DENTRO del input cierra el editor y conserva la seleccion (el evento llega a window)", async () => {
    let lastEditingId: string | null = "unset";
    render(
      <TextHarness
        initialFields={[NAME]}
        onFieldsChange={() => {}}
        onEditingIdChange={(id) => (lastEditingId = id)}
      />,
    );
    await waitForPreview();

    const box = textGroup("Nombre");
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(box, { pointerId: 1 });
    const input = screen.getByRole("textbox", { name: "Nombre" });
    expect(lastEditingId).toBe(NAME.id);

    // Como en el navegador: el keydown nace en el input y burbujea hasta window.
    fireEvent.keyDown(input, { key: "Escape", bubbles: true });

    expect(lastEditingId).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Nombre" })).toBeNull();
    // Seleccionado todavia: el boton de quitar sigue visible.
    expect(screen.getByRole("button", { name: startsWith(strings.removeTextField) })).toBeTruthy();
  });
});

describe("DocumentCanvas — foco gestionado (W2-A)", () => {
  const NAME: DetectedField = {
    id: "txt-foc",
    pageIndex: 0,
    rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
    label: "Nombre",
    source: "acroform",
    confidence: "high",
  };
  const SLOT: SignatureField = {
    id: "fld-foc",
    signerId: ANA.id,
    pageIndex: 0,
    type: "signature",
    rect: { x: 0.1, y: 0.6, width: 0.3, height: 0.1 },
  };

  it("Escape dentro del input devuelve el foco al propio campo (nunca a <body>)", async () => {
    render(<Harness initialTextFields={[NAME]} />);
    await waitForPreview();
    const box = textGroup("Nombre");
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(box, { pointerId: 1 });
    const input = screen.getByRole("textbox", { name: "Nombre" });
    await waitFor(() => expect(document.activeElement).toBe(input));

    fireEvent.keyDown(input, { key: "Escape", bubbles: true });

    await waitFor(() => expect(document.activeElement).toBe(textGroup("Nombre")));
  });

  it("borrar con Supr deja el foco en 'Deshacer'; deshacer lo devuelve al elemento repuesto", async () => {
    render(<Harness initialFields={[SLOT]} undoDeleteEnabled />);
    await waitForPreview();
    const slot = screen.getByRole("group", { name: signatureLabel });
    act(() => slot.focus());
    expect(document.activeElement).toBe(slot);

    fireEvent.keyDown(slot, { key: "Delete", bubbles: true });

    const undo = await screen.findByRole("button", { name: strings.undoRemoveField });
    await waitFor(() => expect(document.activeElement).toBe(undo));

    fireEvent.click(undo);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("group", { name: signatureLabel }),
      ),
    );
  });

  it("sin 'Deshacer', borrar con el boton 'quitar' deja el foco en 'Añadir aquí' (no en <body>)", async () => {
    render(<Harness initialFields={[SLOT]} />);
    await waitForPreview();
    fireEvent.pointerDown(screen.getByRole("group", { name: signatureLabel }), {
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerUp(screen.getByRole("group", { name: signatureLabel }), {
      pointerId: 1,
    });
    const remove = screen.getByRole("button", { name: startsWith(strings.removeField) });
    act(() => remove.focus());

    fireEvent.click(remove);

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: strings.addFieldHere }),
      ),
    );
  });

  it("si el aviso 'Deshacer' caduca (6 s) con el foco en su boton, el foco se recoloca (no cae a <body>)", async () => {
    render(<Harness initialFields={[SLOT]} undoDeleteEnabled />);
    await waitForPreview();
    // El temporizador de 6 s se captura ANTES de borrar (ver captureTimeouts).
    const timers = captureTimeouts(6000);
    try {
      tapElement(screen.getByRole("group", { name: signatureLabel }));
      fireEvent.keyDown(window, { key: "Delete" });
      const undo = await screen.findByRole("button", { name: strings.undoRemoveField });
      await waitFor(() => expect(document.activeElement).toBe(undo));

      timers.fireLatest();
      expect(screen.queryByRole("button", { name: strings.undoRemoveField })).toBeNull();
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: strings.addFieldHere }),
      );
    } finally {
      timers.restore();
    }
  });

  it("la region de estado del aviso 'Deshacer' esta montada antes de borrar nada", async () => {
    render(<Harness initialFields={[SLOT]} undoDeleteEnabled />);
    await waitForPreview();
    const regionsBefore = screen.getAllByRole("status");
    expect(regionsBefore.length).toBeGreaterThan(0);
    tapElement(screen.getByRole("group", { name: signatureLabel }));
    fireEvent.keyDown(window, { key: "Delete" });
    const notice = screen.getByText(strings.fieldDeletedNotice);
    expect(regionsBefore).toContain(notice.closest('[role="status"]'));
  });
});

function tapElement(element: HTMLElement) {
  fireEvent.pointerDown(element, { pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerUp(element, { pointerId: 1 });
}

/* ------------------------------------------------------------------ *
 * Correcciones de la verificacion independiente de W2-A.
 * ------------------------------------------------------------------ */
describe("DocumentCanvas — teclado y modales (verificacion W2-A)", () => {
  const SLOT_A: SignatureField = {
    id: "fld-v1",
    signerId: ANA.id,
    pageIndex: 0,
    type: "signature",
    rect: { x: 0.1, y: 0.6, width: 0.3, height: 0.1 },
  };
  const SLOT_B: SignatureField = { ...SLOT_A, id: "fld-v2", rect: { x: 0.5, y: 0.6, width: 0.3, height: 0.1 } };
  const NAME: DetectedField = {
    id: "txt-v1",
    pageIndex: 0,
    rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
    label: "Nombre",
    source: "acroform",
    confidence: "high",
  };

  beforeEach(() => {
    clearValueHistory();
    __resetValueHistoryCacheForTests();
  });

  it("con el dialogo 'Borrar todos' abierto, Supr/Retroceso NO borran el seleccionado por detras", async () => {
    let slots: SignatureField[] = [SLOT_A, SLOT_B];
    render(
      <Harness
        initialFields={[SLOT_A, SLOT_B]}
        onFieldsChange={(next) => (slots = next)}
        undoDeleteEnabled
      />,
    );
    await waitForPreview();
    tapElement(screen.getAllByRole("group", { name: signatureLabel })[0]);
    fireEvent.click(screen.getByRole("button", { name: strings.clearAllFields }));
    const dialog = screen.getByRole("dialog");

    fireEvent.keyDown(within(dialog).getByRole("button", { name: strings.confirmCancel }), {
      key: "Delete",
      bubbles: true,
    });
    fireEvent.keyDown(window, { key: "Backspace" });

    expect(slots).toHaveLength(2);
    expect(screen.queryByText(strings.fieldDeletedNotice)).toBeNull();
  });

  it("con las sugerencias abiertas, el primer Escape solo las cierra; el segundo sale de la edicion y devuelve el foco al campo", async () => {
    recordValue(normalizeFieldLabel("Nombre"), "Ana Maria");
    render(<Harness initialTextFields={[NAME]} />);
    await waitForPreview();
    tapElement(textGroup("Nombre"));
    const input = screen.getByRole("textbox", { name: "Nombre" });
    expect(screen.getByRole("listbox")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Escape", bubbles: true });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Nombre" })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Nombre" }), {
      key: "Escape",
      bubbles: true,
    });
    expect(screen.queryByRole("textbox", { name: "Nombre" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(textGroup("Nombre")));
  });

  it("cambiar de pagina a mitad de un arrastre de creacion descarta el gesto: no nace ningun elemento, ni en la pagina vieja ni en la nueva", async () => {
    const changes: SignatureField[][] = [];
    render(<Harness onFieldsChange={(next) => changes.push(next)} />);
    await waitForPreview();
    const host = document.querySelector('[data-canvas="host"]') as HTMLElement;

    fireEvent.pointerDown(host, { pointerId: 1, clientX: 60, clientY: 80 });
    fireEvent.pointerMove(host, { pointerId: 1, clientX: 240, clientY: 200 });
    fireEvent.click(screen.getByRole("button", { name: strings.nextPage }));
    fireEvent.pointerMove(host, { pointerId: 1, clientX: 300, clientY: 260 });
    fireEvent.pointerUp(host, { pointerId: 1, clientX: 300, clientY: 260 });

    expect(changes).toHaveLength(0);
    expect(screen.queryAllByRole("group", { name: signatureLabel })).toHaveLength(0);

    // Y el lienzo sigue respondiendo con normalidad despues.
    fireEvent.pointerDown(host, { pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(host, { pointerId: 2, clientX: 100, clientY: 100 });
    expect(changes).toHaveLength(1);
    expect(changes[0][0].pageIndex).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Gesto en curso + cambio de pagina. Cada capa de defensa tiene su propio
 * test (sin enmascararse entre si): `cancelGesture` en `goToPage`, en
 * `advanceToNextEmptyField`, la limpieza de `dragRef`, la de
 * `draftOriginRef`/`draft`, y la guarda de `gesturePageRef` (esta ultima,
 * con un cambio de pagina que NO pasa por el lienzo).
 * ------------------------------------------------------------------ */
describe("DocumentCanvas — gesto cancelado por cambio de pagina (W2-A)", () => {
  const dashedDraft = () =>
    document.querySelector('[data-canvas="host"] .border-dashed');
  const hostEl = () => document.querySelector('[data-canvas="host"]') as HTMLElement;
  const startDraw = () => {
    fireEvent.pointerDown(hostEl(), { pointerId: 1, clientX: 60, clientY: 80 });
    fireEvent.pointerMove(hostEl(), { pointerId: 1, clientX: 240, clientY: 200 });
    expect(dashedDraft()).not.toBeNull();
  };
  /** Tras cancelar: ni recuadro, ni se resucita al mover, ni al soltar nace nada. */
  const expectCancelled = () => {
    expect(dashedDraft()).toBeNull();
    // Un `pointermove` suelto ya no pertenece a ningun borrador: no se consume
    // (`preventDefault`) ni resucita el recuadro. Con `draftOriginRef` colgado
    // el lienzo seguiria tratandolo como parte del gesto y lo consumiria.
    const notConsumed = fireEvent.pointerMove(hostEl(), {
      pointerId: 1,
      clientX: 300,
      clientY: 260,
    });
    expect(notConsumed).toBe(true);
    expect(dashedDraft()).toBeNull();
    fireEvent.pointerUp(hostEl(), { pointerId: 1, clientX: 300, clientY: 260 });
  };

  const SLOT: SignatureField = {
    id: "fld-g1",
    signerId: ANA.id,
    pageIndex: 0,
    type: "signature",
    rect: { x: 0.3, y: 0.5, width: 0.3, height: 0.1 },
  };

  it("flecha: a mitad de un arrastre de CREACION, el recuadro desaparece al instante, no revive y soltar no crea nada", async () => {
    const changes: SignatureField[][] = [];
    render(<Harness onFieldsChange={(next) => changes.push(next)} />);
    await waitForPreview();
    startDraw();
    fireEvent.click(screen.getByRole("button", { name: strings.nextPage }));
    expectCancelled();
    expect(changes).toHaveLength(0);
  });

  it("miniatura: mismo contrato que la flecha", async () => {
    const changes: SignatureField[][] = [];
    render(<Harness onFieldsChange={(next) => changes.push(next)} />);
    await waitForPreview();
    const thumb = await screen.findByRole("button", { name: strings.goToPage(2) });
    startDraw();
    fireEvent.click(thumb);
    expectCancelled();
    expect(changes).toHaveLength(0);
  });

  it("Tab/Enter que salta a un campo de otra pagina: tambien aborta el arrastre de creacion", async () => {
    const created: DetectedField[][] = [];
    const first: DetectedField = {
      id: "txt-g1",
      pageIndex: 0,
      rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
      label: "Uno",
      source: "acroform",
      confidence: "high",
    };
    const second: DetectedField = { ...first, id: "txt-g2", pageIndex: 1, label: "Dos" };
    render(
      <Harness
        tool="text"
        keyboardNavEnabled
        initialTextFields={[first, second]}
        onTextFieldsChange={(next) => created.push(next)}
      />,
    );
    await waitForPreview();
    startDraw();
    // Con el boton aun "pulsado", el teclado abre el editor del primero y salta al siguiente (pagina 2).
    const uno = textGroup("Uno");
    act(() => uno.focus());
    fireEvent.keyDown(uno, { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Uno" }), { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Dos" })).toBeTruthy());
    expectCancelled();
    expect(created).toHaveLength(0);
  });

  it("la guarda de pagina por si sola: un cambio de pagina ajeno al lienzo (props) tambien descarta el gesto al soltar", async () => {
    const changes: SignatureField[][] = [];
    let setPage: (index: number) => void = () => {};
    render(
      <Harness
        onFieldsChange={(next) => changes.push(next)}
        exposePageSetter={(set) => (setPage = set)}
      />,
    );
    await waitForPreview();
    startDraw();
    act(() => setPage(1));
    fireEvent.pointerUp(hostEl(), { pointerId: 1, clientX: 300, clientY: 260 });
    expect(changes).toHaveLength(0);
    expect(screen.queryAllByRole("group", { name: signatureLabel })).toHaveLength(0);
  });

  /** Tras abortar, un gesto NUEVO (otro puntero) funciona: no queda `dragRef` colgado ignorando punteros. */
  const expectCanvasStillResponds = (changes: SignatureField[][], before: number) => {
    fireEvent.pointerDown(hostEl(), { pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(hostEl(), { pointerId: 2, clientX: 100, clientY: 100 });
    expect(changes).toHaveLength(before + 1);
    expect(changes.at(-1)!.at(-1)!.pageIndex).toBe(1);
  };

  it("MOVER un elemento existente y cambiar de pagina a mitad: el elemento deja de seguir al puntero y los punteros siguientes funcionan", async () => {
    const changes: SignatureField[][] = [];
    render(<Harness initialFields={[SLOT]} onFieldsChange={(next) => changes.push(next)} />);
    await waitForPreview();
    const box = screen.getByRole("group", { name: signatureLabel });
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 300, clientY: 600 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 240, clientY: 520 });
    expect(changes).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: strings.nextPage }));
    fireEvent.pointerMove(hostEl(), { pointerId: 1, clientX: 100, clientY: 300 });
    fireEvent.pointerUp(hostEl(), { pointerId: 1 });
    expect(changes).toHaveLength(1);
    expectCanvasStillResponds(changes, 1);
  });

  it("REDIMENSIONAR un elemento existente y cambiar de pagina a mitad: no sigue creciendo y los punteros siguientes funcionan", async () => {
    const changes: SignatureField[][] = [];
    render(<Harness initialFields={[SLOT]} onFieldsChange={(next) => changes.push(next)} />);
    await waitForPreview();
    tapElement(screen.getByRole("group", { name: signatureLabel }));
    const handle = screen.getByRole("button", { name: strings.resizeField });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 300, clientY: 600 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 340, clientY: 630 });
    expect(changes).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: strings.nextPage }));
    fireEvent.pointerMove(hostEl(), { pointerId: 1, clientX: 500, clientY: 700 });
    fireEvent.pointerUp(hostEl(), { pointerId: 1 });
    expect(changes).toHaveLength(1);
    expectCanvasStillResponds(changes, 1);
  });
});

describe("DocumentCanvas — controles de un elemento (W2-B: 'quitar' vive en la barra flotante)", () => {
  // jsdom simula un lienzo de 600x800: 0.05 de alto = 40 px (bajo), 0.1 = 80 px.
  const short: DetectedField = {
    id: "txt-short",
    pageIndex: 0,
    rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
    label: "Bajo",
    source: "acroform",
    confidence: "high",
  };

  it("el elemento seleccionado solo lleva el tirador de tamano; 'quitar' esta en la barra (objetivo propio, sin competir con los vecinos)", async () => {
    render(<TextHarness initialFields={[short]} onFieldsChange={() => {}} />);
    await waitForPreview();

    const box = textGroup("Bajo");
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(box, { pointerId: 1 });
    fireEvent.keyDown(window, { key: "Escape" });

    expect(within(box).queryByRole("button", { name: startsWith(strings.removeTextField) })).toBeNull();
    expect(within(box).getByRole("button", { name: strings.resizeTextField })).toBeTruthy();
    expect(
      within(floatingBar()).getByRole("button", { name: startsWith(strings.removeTextField) }),
    ).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * W2-B · paleta de herramientas, barra flotante y zonas de toque
 * ------------------------------------------------------------------ */

describe("DocumentCanvas — paleta de herramientas (W2-B)", () => {
  const toolButton = (name: string) =>
    within(palette()).getByRole("button", { name });
  const pressed = (name: string) => toolButton(name).getAttribute("aria-pressed");
  const host = () => screen.getByAltText(strings.documentTitle).parentElement!;

  /** Toque limpio sobre la pagina vacia (centro por defecto). */
  function tapPage(x = 300, y = 400) {
    fireEvent.pointerDown(host(), { pointerId: 7, clientX: x, clientY: y });
    fireEvent.pointerUp(host(), { pointerId: 7, clientX: x, clientY: y });
  }
  function dragPage() {
    fireEvent.pointerDown(host(), { pointerId: 8, clientX: 60, clientY: 80 });
    fireEvent.pointerMove(host(), { pointerId: 8, clientX: 360, clientY: 160 });
    fireEvent.pointerUp(host(), { pointerId: 8, clientX: 360, clientY: 160 });
  }

  it("expone un toolbar con aria-pressed, aria-keyshortcuts y una sola parada de Tab (tabindex itinerante)", async () => {
    render(<Harness tool="select" richFieldTypesEnabled />);
    await waitForPreview();

    const bar = palette();
    expect(bar.getAttribute("aria-orientation")).toMatch(/horizontal|vertical/);
    const items = within(bar).getAllByRole("button");
    // Seleccionar, Firma, Iniciales, Texto, Casilla, Fecha + anterior/siguiente.
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
      strings.toolSelect,
      strings.fieldSignature,
      strings.fieldInitials,
      strings.fieldTypeText,
      strings.fieldTypeCheckbox,
      strings.fieldTypeDate,
      strings.prevField,
      strings.nextField,
    ]);
    expect(items.filter((item) => item.tabIndex === 0)).toHaveLength(1);
    expect(pressed(strings.toolSelect)).toBe("true");
    expect(toolButton(strings.fieldSignature).getAttribute("aria-keyshortcuts")).toBe("F");
    expect(toolButton(strings.toolSelect).getAttribute("aria-keyshortcuts")).toBe("V");
    expect(toolButton(strings.fieldTypeCheckbox).getAttribute("aria-keyshortcuts")).toBe("C");
    expect(toolButton(strings.fieldTypeDate).getAttribute("aria-keyshortcuts")).toBe("D");
    expect(toolButton(strings.fieldTypeText).getAttribute("aria-keyshortcuts")).toBe("T");
    expect(toolButton(strings.fieldInitials).getAttribute("aria-keyshortcuts")).toBe("I");
  });

  it("las flechas, Inicio y Fin mueven el foco y la parada de Tab los sigue", async () => {
    render(<Harness tool="select" richFieldTypesEnabled />);
    await waitForPreview();

    const select = toolButton(strings.toolSelect);
    select.focus();
    fireEvent.keyDown(select, { key: "ArrowRight" });
    expect(document.activeElement).toBe(toolButton(strings.fieldSignature));
    expect(toolButton(strings.fieldSignature).tabIndex).toBe(0);
    expect(select.tabIndex).toBe(-1);
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(toolButton(strings.nextField));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(select); // da la vuelta
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(toolButton(strings.nextField));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(select);
  });

  it("sin la funcion de tipos enriquecidos no hay Casilla ni Fecha; sin firmantes, ni Firma ni Iniciales", async () => {
    render(<Harness tool="select" signers={[]} activeSignerId={null} richFieldTypesEnabled={false} />);
    await waitForPreview();
    expect(
      within(palette())
        .getAllByRole("button")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual([strings.toolSelect, strings.fieldTypeText, strings.prevField, strings.nextField]);
  });

  it("Firma e Iniciales muestran el color del firmante activo, y cambia con el", async () => {
    render(<Harness tool="select" />);
    await waitForPreview();
    const dot = () =>
      toolButton(strings.fieldSignature).querySelector<HTMLElement>("[data-owner-dot]")!;
    expect(dot().style.backgroundColor).toBe("rgb(13, 75, 255)"); // Ana
    expect(toolButton(strings.fieldSignature).title).toContain(ANA.name);
    fireEvent.click(screen.getByRole("radio", { name: LUIS.name }));
    expect(dot().style.backgroundColor).toBe("rgb(15, 157, 104)"); // Luis
    expect(toolButton(strings.fieldInitials).title).toContain(LUIS.name);
  });

  it("cada herramienta crea el tipo correcto con un toque y con un arrastre, y vuelve a Seleccionar", async () => {
    let slots: SignatureField[] = [];
    let texts: DetectedField[] = [];
    render(
      <Harness
        tool="select"
        richFieldTypesEnabled
        onFieldsChange={(next) => (slots = next)}
        onTextFieldsChange={(next) => (texts = next)}
      />,
    );
    await waitForPreview();

    const cases: Array<[string, () => void]> = [
      [strings.fieldSignature, tapPage],
      [strings.fieldInitials, dragPage],
      [strings.fieldTypeText, tapPage],
      [strings.fieldTypeCheckbox, tapPage],
      [strings.fieldTypeDate, dragPage],
    ];
    for (const [name, gesture] of cases) {
      armTool(name);
      expect(pressed(name)).toBe("true");
      gesture();
      expect(pressed(strings.toolSelect)).toBe("true");
      // Un campo recien creado abre su editor: se cierra antes del siguiente gesto.
      fireEvent.keyDown(window, { key: "Escape" });
    }

    expect(slots.map((slot) => slot.type)).toEqual(["signature", "initials"]);
    expect(texts.map((field) => field.type)).toEqual([undefined, "checkbox", "date"]);
    expect(texts.every((field) => field.source === "manual")).toBe(true);
  });

  it("el hueco nuevo es del firmante activo en el momento de crearlo", async () => {
    let slots: SignatureField[] = [];
    render(<Harness tool="select" onFieldsChange={(next) => (slots = next)} />);
    await waitForPreview();
    fireEvent.click(screen.getByRole("radio", { name: LUIS.name }));
    armTool(strings.fieldSignature);
    tapPage();
    expect(slots[0].signerId).toBe(LUIS.id);
  });

  it("el tamano por defecto de una casilla es cuadrado en pantalla", async () => {
    let texts: DetectedField[] = [];
    render(
      <Harness tool="select" richFieldTypesEnabled onTextFieldsChange={(next) => (texts = next)} />,
    );
    await waitForPreview();
    armTool(strings.fieldTypeCheckbox);
    tapPage();
    const rect = texts[0].rect;
    expect((rect.width * HOST_WIDTH) / (rect.height * HOST_HEIGHT)).toBeCloseTo(1, 1);
  });

  it("una casilla recien creada queda seleccionada y enfocada, sin abrir un editor", async () => {
    render(<Harness tool="select" richFieldTypesEnabled />);
    await waitForPreview();
    armTool(strings.fieldTypeCheckbox);
    tapPage();
    expect(screen.queryByRole("textbox")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("data-element-kind")).toBe("text"),
    );
  });

  it("con Seleccionar, tocar la pagina vacia deselecciona (y cierra la barra)", async () => {
    render(<Harness tool="select" initialTextFields={[NAME_FIELD]} />);
    await waitForPreview();
    fireEvent.pointerDown(textGroup("Nombre"), { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(textGroup("Nombre"), { pointerId: 1 });
    await waitFor(() => expect(screen.getByRole("group", { name: BAR_NAME })).toBeTruthy());
    tapPage(500, 700);
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: BAR_NAME })).toBeNull(),
    );
  });

  describe("atajos de teclado", () => {
    it("V F I T C D arman la herramienta cuando el foco no esta en un campo", async () => {
      render(<Harness tool="select" richFieldTypesEnabled />);
      await waitForPreview();
      const keys: Array<[string, string]> = [
        ["f", strings.fieldSignature],
        ["i", strings.fieldInitials],
        ["t", strings.fieldTypeText],
        ["c", strings.fieldTypeCheckbox],
        ["d", strings.fieldTypeDate],
        ["v", strings.toolSelect],
      ];
      for (const [key, name] of keys) {
        fireEvent.keyDown(document.body, { key });
        expect(pressed(name)).toBe("true");
      }
    });

    it("no se disparan mientras se escribe en un input, con un modificador ni dentro de un dialogo", async () => {
      render(
        <Harness tool="select" initialTextFields={[NAME_FIELD]} richFieldTypesEnabled />,
      );
      await waitForPreview();
      fireEvent.pointerDown(textGroup("Nombre"), { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerUp(textGroup("Nombre"), { pointerId: 1 });
      const input = await screen.findByRole("textbox", { name: "Nombre" });
      for (const key of ["f", "t", "c", "d", "i"]) fireEvent.keyDown(input, { key });
      expect(pressed(strings.toolSelect)).toBe("true");

      fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
      fireEvent.keyDown(document.body, { key: "f", metaKey: true });
      expect(pressed(strings.toolSelect)).toBe("true");

      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      const inside = document.createElement("button");
      dialog.append(inside);
      document.body.append(dialog);
      fireEvent.keyDown(inside, { key: "f" });
      dialog.remove();
      expect(pressed(strings.toolSelect)).toBe("true");
    });

    it("no actuan con el foco en otra parte de la pagina (WCAG 2.1.4)", async () => {
      render(
        <>
          <button type="button">Fuera</button>
          <Harness tool="select" />
        </>,
      );
      await waitForPreview();
      const outside = screen.getByRole("button", { name: "Fuera" });
      outside.focus();
      fireEvent.keyDown(outside, { key: "f" });
      expect(pressed(strings.toolSelect)).toBe("true");
    });

    it("una letra sin herramienta disponible no hace nada (Casilla sin tipos enriquecidos)", async () => {
      render(<Harness tool="select" richFieldTypesEnabled={false} />);
      await waitForPreview();
      fireEvent.keyDown(document.body, { key: "c" });
      expect(pressed(strings.toolSelect)).toBe("true");
    });

    it("Escape con una herramienta armada vuelve a Seleccionar", async () => {
      render(<Harness tool="signature" />);
      await waitForPreview();
      expect(pressed(strings.fieldSignature)).toBe("true");
      fireEvent.keyDown(window, { key: "Escape" });
      expect(pressed(strings.toolSelect)).toBe("true");
    });

    it("volver a pulsar la herramienta activa regresa a Seleccionar", async () => {
      render(<Harness tool="select" />);
      await waitForPreview();
      armTool(strings.fieldTypeText);
      expect(pressed(strings.fieldTypeText)).toBe("true");
      armTool(strings.fieldTypeText);
      expect(pressed(strings.toolSelect)).toBe("true");
    });

    it("el cambio de herramienta se anuncia en una region viva siempre montada", async () => {
      render(<Harness tool="select" />);
      await waitForPreview();
      const live = document.querySelector("[data-canvas-announcer]")!;
      expect(live.getAttribute("role")).toBe("status");
      expect(live.textContent).toBe("");
      armTool(strings.fieldSignature);
      await waitFor(() =>
        expect(live.textContent).toBe(strings.toolArmedStatus(strings.fieldSignature)),
      );
    });
  });

  it("Seleccionar no muestra 'anadir aqui'; una herramienta armada si (alta sin puntero)", async () => {
    render(<Harness tool="select" />);
    await waitForPreview();
    expect(screen.queryByRole("button", { name: strings.addFieldHere })).toBeNull();
    armTool(strings.fieldSignature);
    expect(screen.getByRole("button", { name: strings.addFieldHere })).toBeTruthy();
  });

  it("Seleccionar: 'quitar de la pagina' y 'borrar todo' actuan sobre huecos Y campos", async () => {
    let slots: SignatureField[] = [];
    let texts: DetectedField[] = [];
    render(
      <Harness
        tool="select"
        initialFields={[SLOT_FIELD]}
        initialTextFields={[NAME_FIELD]}
        onFieldsChange={(next) => (slots = next)}
        onTextFieldsChange={(next) => (texts = next)}
      />,
    );
    await waitForPreview();
    fireEvent.click(screen.getByRole("button", { name: strings.clearPageAll }));
    expect(slots).toHaveLength(0);
    expect(texts).toHaveLength(0);
  });
});

const NAME_FIELD: DetectedField = {
  id: "txt-w2b-a",
  pageIndex: 0,
  rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
  label: "Nombre",
  source: "acroform",
  confidence: "high",
};
const EMAIL_FIELD: DetectedField = {
  id: "txt-w2b-b",
  pageIndex: 0,
  rect: { x: 0.1, y: 0.3, width: 0.3, height: 0.05 },
  label: "Correo",
  source: "acroform",
  confidence: "high",
};
const CITY_FIELD: DetectedField = {
  id: "txt-w2b-c",
  pageIndex: 1,
  rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
  label: "Ciudad",
  source: "acroform",
  confidence: "high",
};
const SLOT_FIELD: SignatureField = {
  id: "fld-w2b",
  signerId: ANA.id,
  pageIndex: 0,
  type: "signature",
  rect: { x: 0.5, y: 0.6, width: 0.3, height: 0.1 },
};

describe("DocumentCanvas — barra flotante contextual (W2-B)", () => {
  const select = (label: string) => {
    fireEvent.pointerDown(textGroup(label), { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(textGroup(label), { pointerId: 1 });
    fireEvent.keyDown(window, { key: "Escape" }); // cierra el editor, conserva la seleccion
  };
  const selectSlot = () => {
    fireEvent.pointerDown(screen.getByRole("group", { name: signatureLabel }), {
      pointerId: 1,
      clientX: 300,
      clientY: 600,
    });
    fireEvent.pointerUp(screen.getByRole("group", { name: signatureLabel }), { pointerId: 1 });
  };
  const barButton = (name: string | RegExp) => within(floatingBar()).getByRole("button", { name });

  it("sin seleccion no hay barra; al seleccionar aparece con su nombre accesible", async () => {
    render(<Harness tool="select" initialTextFields={[NAME_FIELD]} />);
    await waitForPreview();
    expect(screen.queryByRole("group", { name: BAR_NAME })).toBeNull();
    select("Nombre");

    await waitFor(() => expect(floatingBar()).toBeTruthy());
  });

  it("para un hueco: cambia de firmante, alterna Firma/Iniciales, duplica y borra con Deshacer", async () => {
    let slots: SignatureField[] = [];
    render(
      <Harness
        tool="select"
        undoDeleteEnabled
        initialFields={[SLOT_FIELD]}
        onFieldsChange={(next) => (slots = next)}
      />,
    );
    await waitForPreview();
    selectSlot();
    await waitFor(() => expect(floatingBar()).toBeTruthy());

    fireEvent.change(within(floatingBar()).getByRole("combobox", { name: startsWith(strings.signerOfSlotLabel) }), {
      target: { value: LUIS.id },
    });
    expect(slots[0].signerId).toBe(LUIS.id);

    expect(barButton(strings.fieldSignature).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(barButton(strings.fieldInitials));
    expect(slots[0].type).toBe("initials");
    expect(barButton(strings.fieldInitials).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(barButton(startsWith(strings.duplicateElement)));
    expect(slots).toHaveLength(2);
    expect(slots[1].id).not.toBe(slots[0].id);
    expect(slots[1].signerId).toBe(LUIS.id);
    expect(slots[1].type).toBe("initials");
    expect(slots[1].rect).not.toEqual(slots[0].rect);
    // La copia no pisa al original.
    const [a, b] = slots.map((slot) => slot.rect);
    const overlaps =
      a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    expect(overlaps).toBe(false);

    fireEvent.click(barButton(startsWith(strings.removeField)));
    expect(slots).toHaveLength(1);
    fireEvent.click(await screen.findByRole("button", { name: strings.undoRemoveField }));
    expect(slots).toHaveLength(2);
  });

  it("con un solo firmante la barra no ofrece cambiar de firmante", async () => {
    render(<Harness tool="select" signers={[ANA]} initialFields={[SLOT_FIELD]} />);
    await waitForPreview();
    selectSlot();
    await waitFor(() => expect(floatingBar()).toBeTruthy());
    expect(within(floatingBar()).queryByRole("combobox")).toBeNull();
  });

  it("para un campo de texto: cambia el tipo, duplica sin etiqueta ni valor y borra", async () => {
    let texts: DetectedField[] = [];
    let values: Record<string, string> = {};
    render(
      <Harness
        tool="select"
        richFieldTypesEnabled
        initialTextFields={[NAME_FIELD]}
        initialValues={{ [NAME_FIELD.id]: "Ana Perez" }}
        onTextFieldsChange={(next) => (texts = next)}
        onValuesChange={(next) => (values = next)}
      />,
    );
    await waitForPreview();
    select("Nombre");
    await waitFor(() => expect(floatingBar()).toBeTruthy());

    fireEvent.click(
      within(openTypePicker()).getByRole("button", { name: strings.fieldTypeDate }),
    );
    expect(texts[0].type).toBe("date");
    expect(values[NAME_FIELD.id]).toBe("");

    fireEvent.click(barButton(startsWith(strings.duplicateElement)));
    expect(texts).toHaveLength(2);
    expect(texts[1].label).toBeUndefined();
    expect(texts[1].type).toBe("date");
    expect(texts[1].source).toBe("manual");
    expect(values[texts[1].id]).toBeUndefined();

    fireEvent.click(barButton(startsWith(strings.removeTextField)));
    expect(texts).toHaveLength(1);
  });

  it("sin tipos enriquecidos la barra de un campo no muestra el selector de tipo", async () => {
    render(<Harness tool="select" initialTextFields={[NAME_FIELD]} richFieldTypesEnabled={false} />);
    await waitForPreview();
    select("Nombre");
    await waitFor(() => expect(floatingBar()).toBeTruthy());
    expect(
      within(floatingBar()).queryByRole("button", { name: CHANGE_TYPE }),
    ).toBeNull();
  });

  describe("anterior / siguiente campo pendiente", () => {
    const fields = [NAME_FIELD, EMAIL_FIELD, CITY_FIELD];
    const editingName = () =>
      (document.activeElement as HTMLInputElement | null)?.getAttribute("aria-label");

    it("recorre los pendientes hacia delante y hacia atras, cruzando de pagina y dando la vuelta", async () => {
      render(<Harness tool="select" initialTextFields={fields} />);
      await waitForPreview();
      select("Nombre");
      await waitFor(() => expect(floatingBar()).toBeTruthy());

      fireEvent.click(barButton(strings.nextField));
      await waitFor(() => expect(editingName()).toBe("Correo"));
      fireEvent.click(barButton(strings.nextField));
      await waitFor(() => expect(editingName()).toBe("Ciudad")); // pagina 2
      fireEvent.click(barButton(strings.nextField));
      await waitFor(() => expect(editingName()).toBe("Nombre")); // vuelta
      fireEvent.click(barButton(strings.prevField));
      await waitFor(() => expect(editingName()).toBe("Ciudad"));
      fireEvent.click(barButton(strings.prevField));
      await waitFor(() => expect(editingName()).toBe("Correo"));
    });

    it("se salta los ya rellenos y avisa cuando no queda ninguno", async () => {
      render(
        <Harness
          tool="select"
          initialTextFields={fields}
          initialValues={{ [EMAIL_FIELD.id]: "a@b.c", [CITY_FIELD.id]: "Madrid" }}
        />,
      );
      await waitForPreview();
      select("Nombre");
      await waitFor(() => expect(floatingBar()).toBeTruthy());
      // Solo "Nombre" esta pendiente (y es el actual): los botones quedan atenuados pero enfocables.
      const next = barButton(strings.nextField);
      expect(next.getAttribute("aria-disabled")).toBe("true");
      expect(next.hasAttribute("disabled")).toBe(false);
      fireEvent.click(next);
      await waitFor(() =>
        expect(document.querySelector("[data-canvas-announcer]")!.textContent).toBe(
          strings.noMorePendingFields,
        ),
      );
    });

    it("desde un hueco seleccionado arranca por su posicion en la pagina", async () => {
      render(
        <Harness
          tool="select"
          initialFields={[SLOT_FIELD]} // y = 0.6: despues de Nombre y Correo
          initialTextFields={fields}
        />,
      );
      await waitForPreview();
      selectSlot();
      // La paleta tiene los mismos botones: sirve igual.
      fireEvent.click(within(palette()).getByRole("button", { name: strings.prevField }));
      await waitFor(() => expect(editingName()).toBe("Correo"));
    });

    it("la paleta recorre desde ninguna seleccion: siguiente = el primero, anterior = el ultimo", async () => {
      render(<Harness tool="select" initialTextFields={fields} />);
      await waitForPreview();
      fireEvent.click(within(palette()).getByRole("button", { name: strings.nextField }));
      await waitFor(() => expect(editingName()).toBe("Nombre"));
    });

    it("Mayus+Tab dentro de un campo retrocede al anterior pendiente (con la navegacion por teclado activa)", async () => {
      render(<Harness tool="select" keyboardNavEnabled initialTextFields={fields} />);
      await waitForPreview();
      fireEvent.pointerDown(textGroup("Correo"), { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerUp(textGroup("Correo"), { pointerId: 1 });
      const input = await screen.findByRole("textbox", { name: "Correo" });
      fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
      await waitFor(() => expect(editingName()).toBe("Nombre"));
    });
  });

  it("Tab desde el elemento seleccionado entra en la barra; Mayus+Tab desde su primera accion vuelve al elemento", async () => {
    render(<Harness tool="select" initialTextFields={[NAME_FIELD, EMAIL_FIELD]} />);
    await waitForPreview();
    select("Nombre");
    await waitFor(() => expect(floatingBar()).toBeTruthy());
    const box = textGroup("Nombre");
    box.focus();
    fireEvent.keyDown(box, { key: "Tab" });
    const first = floatingBar().querySelector<HTMLElement>("button")!;
    await waitFor(() => expect(document.activeElement).toBe(first));
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    await waitFor(() => expect(document.activeElement).toBe(textGroup("Nombre")));
  });

  it("Tab desde la ultima accion de la barra sigue con el siguiente elemento de la pagina", async () => {
    render(<Harness tool="select" initialTextFields={[NAME_FIELD, EMAIL_FIELD]} />);
    await waitForPreview();
    select("Nombre");
    await waitFor(() => expect(floatingBar()).toBeTruthy());
    const buttons = Array.from(floatingBar().querySelectorAll<HTMLElement>("button"));
    const last = buttons[buttons.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    await waitFor(() => expect(document.activeElement).toBe(textGroup("Correo")));
  });

  it("Escape dentro de la barra devuelve el foco al elemento sin deseleccionarlo", async () => {
    render(<Harness tool="select" initialTextFields={[NAME_FIELD]} />);
    await waitForPreview();
    select("Nombre");
    await waitFor(() => expect(floatingBar()).toBeTruthy());
    const button = floatingBar().querySelector<HTMLElement>("button")!;
    button.focus();
    fireEvent.keyDown(button, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(textGroup("Nombre")));
    expect(screen.getByRole("group", { name: BAR_NAME })).toBeTruthy();
  });

  it("al aparecer no roba el foco (editar con la barra visible mantiene el input enfocado)", async () => {
    render(<Harness tool="select" initialTextFields={[NAME_FIELD]} />);
    await waitForPreview();
    fireEvent.pointerDown(textGroup("Nombre"), { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(textGroup("Nombre"), { pointerId: 1 });
    const input = await screen.findByRole("textbox", { name: "Nombre" });
    await waitFor(() => expect(floatingBar()).toBeTruthy());
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("borrar desde la barra no deja el foco en <body>: va a 'Deshacer'", async () => {
    render(<Harness tool="select" undoDeleteEnabled initialTextFields={[NAME_FIELD]} />);
    await waitForPreview();
    select("Nombre");
    await waitFor(() => expect(floatingBar()).toBeTruthy());
    const remove = barButton(startsWith(strings.removeTextField));
    remove.focus();
    fireEvent.click(remove);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: strings.undoRemoveTextField }),
      ),
    );
  });

  it("el desplegable de sugerencias de un campo ya no compite con la barra: van a lados opuestos", async () => {
    render(<Harness tool="select" initialTextFields={[NAME_FIELD]} />);
    await waitForPreview();
    fireEvent.pointerDown(textGroup("Nombre"), { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(textGroup("Nombre"), { pointerId: 1 });
    await screen.findByRole("textbox", { name: "Nombre" });
    await waitFor(() => expect(floatingBar()).toBeTruthy());
    // jsdom no hace layout: la barra cae en el lado preferido (la mitad superior de la pagina -> arriba).
    const side = floatingBar().getAttribute("data-side");
    expect(["top", "bottom", "overlay"]).toContain(side);
  });
});

describe("DocumentCanvas — zonas de toque con puntero grueso (W2-B)", () => {
  const originalMatchMedia = window.matchMedia;
  let offsetWidth: PropertyDescriptor | undefined;
  let offsetHeight: PropertyDescriptor | undefined;

  beforeAll(() => {
    // jsdom no calcula layout: `offsetWidth/Height` valen 0. Se fijan al tamano simulado.
    offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get: () => 343,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => 460,
    });
  });
  afterAll(() => {
    if (offsetWidth) Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidth);
    if (offsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight);
    window.matchMedia = originalMatchMedia;
  });

  /** 14 campos de 13 px (en una hoja de 460 px) separados 33 px. */
  const dense: DetectedField[] = Array.from({ length: 14 }, (_, index) => ({
    id: `txt-dense-${index}`,
    pageIndex: 0,
    rect: { x: 0.1, y: (10 + index * 33) / 460, width: 0.5, height: 13 / 460 },
    label: `Campo ${index + 1}`,
    source: "acroform",
    confidence: "high",
  }));

  const zoneVars = (element: HTMLElement) => ({
    t: parseFloat(element.style.getPropertyValue("--hit-t")),
    r: parseFloat(element.style.getPropertyValue("--hit-r")),
    b: parseFloat(element.style.getPropertyValue("--hit-b")),
    l: parseFloat(element.style.getPropertyValue("--hit-l")),
  });

  function stubPointer(coarse: boolean) {
    window.matchMedia = ((query: string) =>
      ({
        matches: coarse && query.includes("pointer: coarse"),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
  }

  it("con puntero grueso cada campo de 13 px gana zona de toque y ninguna invade a su vecino", async () => {
    stubPointer(true);
    render(<Harness tool="select" initialTextFields={dense} />);
    await waitForPreview();
    await waitFor(() =>
      expect(textGroup("Campo 1").hasAttribute("data-hit-zone")).toBe(true),
    );

    const zones = dense.map((field) => {
      const element = textGroup(field.label!);
      const v = zoneVars(element);
      const top = field.rect.y * 460 - v.t;
      const height = 13 + v.t + v.b;
      return { top, height, bottom: top + height };
    });
    for (const zone of zones) expect(zone.height).toBeGreaterThanOrEqual(24);
    for (let i = 1; i < zones.length; i += 1) {
      expect(zones[i].top).toBeGreaterThanOrEqual(zones[i - 1].bottom - 1e-6);
    }
  });

  it("un elemento diminuto (casilla) lleva el tirador de tamano FUERA de la caja; uno ancho lo conserva en la esquina", async () => {
    stubPointer(true);
    const box: DetectedField = {
      id: "txt-tiny",
      pageIndex: 0,
      rect: { x: 0.1, y: 0.1, width: 0.04, height: 0.03 }, // 14 x 14 px en una hoja de 343 x 460
      label: "Diminuto",
      type: "checkbox",
      source: "acroform",
      confidence: "high",
    };
    render(
      <Harness
        tool="select"
        richFieldTypesEnabled
        initialTextFields={[box, dense[0]]}
      />,
    );
    await waitForPreview();
    fireEvent.focus(textGroup("Diminuto"));
    const handle = () =>
      screen.getByRole("button", { name: strings.resizeTextField, hidden: true });
    expect(handle().className).toContain("-right-11");
    // Su zona ampliada solo crece hacia fuera: con `-inset-3` entraba ~4 px en la caja y los
    // toques sobre la casilla seleccionada iban al tirador (no se podia marcar).
    expect(handle().className).toContain("pointer-coarse:before:-right-3");
    expect(handle().className).toContain("pointer-coarse:before:-top-0.5");
    expect(handle().className).not.toContain("-inset-3");
    fireEvent.focus(textGroup("Campo 1"));
    expect(handle().className).toContain("-right-2.5");
  });

  it("con puntero fino no hay zonas ampliadas", async () => {
    stubPointer(false);
    render(<Harness tool="select" initialTextFields={dense} />);
    await waitForPreview();
    expect(textGroup("Campo 1").hasAttribute("data-hit-zone")).toBe(false);
  });

  it("con una herramienta de creacion armada no se amplian (no se comen el sitio de lo nuevo)", async () => {
    stubPointer(true);
    render(<Harness tool="text" initialTextFields={dense} />);
    await waitForPreview();
    expect(textGroup("Campo 1").hasAttribute("data-hit-zone")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * W2-B · ronda de correcciones tras la verificacion independiente
 * ------------------------------------------------------------------ */

describe("DocumentCanvas — correcciones de la ronda 2 de W2-B", () => {
  const hostOf = () => screen.getByAltText(strings.documentTitle).parentElement!;
  const pickTool = (name: string) =>
    fireEvent.click(within(palette()).getByRole("button", { name }));

  describe("scroll con un dedo y toque corto en vacio", () => {
    it("Seleccionar a 1x deja el scroll nativo (pan-y); con una herramienta armada o con zoom, el lienzo se queda el gesto (none)", async () => {
      render(<Harness tool="select" pinchZoomEnabled />);
      await waitForPreview();
      expect(hostOf().className).toContain("touch-pan-y");
      expect(hostOf().className).not.toContain("touch-none");
      pickTool(strings.fieldSignature);
      expect(hostOf().className).toContain("touch-none");
      fireEvent.keyDown(window, { key: "Escape" });
      expect(hostOf().className).toContain("touch-pan-y");
      fireEvent.click(screen.getByRole("button", { name: strings.zoomIn }));
      expect(hostOf().className).toContain("touch-none");
    });

    it("los elementos y su tirador llevan touch-none (mover y redimensionar con el dedo no pasan por el scroll)", async () => {
      render(<Harness tool="select" initialTextFields={[NAME_FIELD]} />);
      await waitForPreview();
      fireEvent.focus(textGroup("Nombre"));
      expect(textGroup("Nombre").className).toContain("touch-none");
      expect(
        screen.getByRole("button", { name: strings.resizeTextField, hidden: true }).className,
      ).toContain("touch-none");
    });

    it("pulsar en vacio NO deselecciona (puede ser el primer dedo de un scroll o un pellizco); un toque corto al soltar, si", async () => {
      render(<Harness tool="select" initialTextFields={[NAME_FIELD]} />);
      await waitForPreview();
      fireEvent.pointerDown(textGroup("Nombre"), { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerUp(textGroup("Nombre"), { pointerId: 1 });
      await waitFor(() => expect(floatingBar()).toBeTruthy());
      fireEvent.keyDown(window, { key: "Escape" });

      const host = hostOf();
      fireEvent.pointerDown(host, { pointerId: 5, clientX: 500, clientY: 700 });
      expect(screen.getByRole("group", { name: BAR_NAME })).toBeTruthy(); // aun seleccionado
      // El navegador reclama el gesto para hacer scroll: pointercancel, no hay deseleccion.
      fireEvent.pointerCancel(host, { pointerId: 5 });
      expect(screen.getByRole("group", { name: BAR_NAME })).toBeTruthy();
      // Un arrastre (movimiento > 8 px) tampoco es un toque.
      fireEvent.pointerDown(host, { pointerId: 6, clientX: 500, clientY: 700 });
      fireEvent.pointerMove(host, { pointerId: 6, clientX: 500, clientY: 640 });
      fireEvent.pointerUp(host, { pointerId: 6, clientX: 500, clientY: 640 });
      expect(screen.getByRole("group", { name: BAR_NAME })).toBeTruthy();
      // Toque corto al soltar: deselecciona.
      fireEvent.pointerDown(host, { pointerId: 7, clientX: 500, clientY: 700 });
      fireEvent.pointerUp(host, { pointerId: 7, clientX: 500, clientY: 700 });
      await waitFor(() => expect(screen.queryByRole("group", { name: BAR_NAME })).toBeNull());
    });

    it("el segundo dedo de un pellizco no deselecciona al primero (la barra se queda)", async () => {
      render(<Harness tool="select" pinchZoomEnabled initialTextFields={[NAME_FIELD]} />);
      await waitForPreview();
      fireEvent.pointerDown(textGroup("Nombre"), { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerUp(textGroup("Nombre"), { pointerId: 1 });
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(floatingBar()).toBeTruthy());
      const host = hostOf();
      fireEvent.pointerDown(host, { pointerId: 2, clientX: 250, clientY: 600 });
      fireEvent.pointerDown(host, { pointerId: 3, clientX: 350, clientY: 600 });
      fireEvent.pointerMove(host, { pointerId: 2, clientX: 200, clientY: 600 });
      fireEvent.pointerMove(host, { pointerId: 3, clientX: 400, clientY: 600 });
      fireEvent.pointerUp(host, { pointerId: 2 });
      fireEvent.pointerUp(host, { pointerId: 3 });
      expect(host.style.transform).toContain("scale(");
      expect(screen.getByRole("group", { name: BAR_NAME })).toBeTruthy();
    });

    it("con zoom, un dedo sobre lo vacio desplaza la hoja y no deselecciona", async () => {
      render(<Harness tool="select" pinchZoomEnabled initialTextFields={[NAME_FIELD]} />);
      await waitForPreview();
      fireEvent.click(screen.getByRole("button", { name: strings.zoomIn }));
      fireEvent.click(screen.getByRole("button", { name: strings.zoomIn })); // 2x
      const host = hostOf();
      expect(host.style.transform).toContain("scale(2)");
      fireEvent.pointerDown(host, { pointerId: 4, clientX: 300, clientY: 400 });
      fireEvent.pointerMove(host, { pointerId: 4, clientX: 250, clientY: 380 });
      fireEvent.pointerMove(host, { pointerId: 4, clientX: 200, clientY: 360 });
      fireEvent.pointerUp(host, { pointerId: 4, clientX: 200, clientY: 360 });
      // Sin layout (jsdom) el limite es 0: la hoja no sale de su sitio, pero tampoco hay tap.
      expect(host.style.transform).toContain("scale(2)");
    });
  });

  describe("botones de zoom (alternativa fiable al pellizco)", () => {
    it("acercan por niveles hasta 3x, alejan y restablecen; solo con el ajuste de zoom", async () => {
      render(<Harness tool="select" pinchZoomEnabled />);
      await waitForPreview();
      const group = screen.getByRole("group", { name: strings.zoomGroupLabel });
      const zoomIn = within(group).getByRole("button", { name: strings.zoomIn });
      const zoomOut = within(group).getByRole("button", { name: strings.zoomOut });
      const reset = within(group).getByRole("button", { name: strings.resetZoomButton });
      const host = hostOf();
      expect(zoomOut.hasAttribute("disabled")).toBe(true);
      expect(reset.hasAttribute("disabled")).toBe(true);
      fireEvent.click(zoomIn);
      expect(host.style.transform).toContain("scale(1.5)");
      fireEvent.click(zoomIn);
      expect(host.style.transform).toContain("scale(2)");
      fireEvent.click(zoomIn);
      expect(host.style.transform).toContain("scale(3)");
      expect(zoomIn.hasAttribute("disabled")).toBe(true);
      fireEvent.click(zoomOut);
      expect(host.style.transform).toContain("scale(2)");
      fireEvent.click(reset);
      expect(host.style.transform).toBeFalsy();
      expect(reset.textContent).toContain("100");
    });

    it("sin el ajuste de pellizco no hay botones de zoom", async () => {
      render(<Harness tool="select" pinchZoomEnabled={false} />);
      await waitForPreview();
      expect(screen.queryByRole("group", { name: strings.zoomGroupLabel })).toBeNull();
    });
  });

  describe("cambiar el tipo no pierde lo tecleado", () => {
    const TEXT: DetectedField = { ...NAME_FIELD, id: "txt-conv", label: "Dato" };
    const typeButton = (name: string) =>
      within(openTypePicker()).getByRole("button", { name });
    const select = () => {
      fireEvent.pointerDown(textGroup("Dato"), { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerUp(textGroup("Dato"), { pointerId: 1 });
      fireEvent.keyDown(window, { key: "Escape" });
    };

    it("texto -> iniciales abrevia a la inicial de cada palabra (mayusculas, 4 letras) y volver a texto recupera el original", async () => {
      let values: Record<string, string> = {};
      render(
        <Harness
          tool="select"
          richFieldTypesEnabled
          undoDeleteEnabled
          initialTextFields={[TEXT]}
          initialValues={{ [TEXT.id]: "Ana Maria Perez" }}
          onValuesChange={(next) => (values = next)}
        />,
      );
      await waitForPreview();
      select();
      await waitFor(() => expect(floatingBar()).toBeTruthy());
      fireEvent.click(typeButton(strings.fieldTypeInitials));
      expect(values[TEXT.id]).toBe("AMP");
      // No hay aviso de borrado: el valor se conserva.
      expect(screen.queryByRole("button", { name: strings.undoTypeChange })).toBeNull();
      fireEvent.click(typeButton(strings.fieldTypeText));
      expect(values[TEXT.id]).toBe("Ana Maria Perez");
    });

    it("texto -> fecha con un valor que no es una fecha lo borra, avisa y 'Deshacer' repone tipo y valor", async () => {
      let texts: DetectedField[] = [];
      let values: Record<string, string> = {};
      render(
        <Harness
          tool="select"
          richFieldTypesEnabled
          undoDeleteEnabled
          initialTextFields={[TEXT]}
          initialValues={{ [TEXT.id]: "Hola mundo" }}
          onTextFieldsChange={(next) => (texts = next)}
          onValuesChange={(next) => (values = next)}
        />,
      );
      await waitForPreview();
      select();
      await waitFor(() => expect(floatingBar()).toBeTruthy());
      fireEvent.click(typeButton(strings.fieldTypeDate));
      expect(texts[0].type).toBe("date");
      expect(values[TEXT.id]).toBe("");
      const notice = strings.typeChangeClearedNotice(strings.fieldTypeDate);
      expect(screen.getByText(notice)).toBeTruthy();
      // La region viva lo anuncia.
      await waitFor(() =>
        expect(document.querySelector("[data-canvas-announcer]")!.textContent).toContain(notice),
      );
      fireEvent.click(screen.getByRole("button", { name: strings.undoTypeChange }));
      expect(texts[0].type).toBeUndefined();
      expect(values[TEXT.id]).toBe("Hola mundo");
      expect(screen.queryByText(notice)).toBeNull();
    });

    it("sin 'Deshacer' en Ajustes el valor invalido tambien se borra y se anuncia (sin snackbar)", async () => {
      let values: Record<string, string> = {};
      render(
        <Harness
          tool="select"
          richFieldTypesEnabled
          undoDeleteEnabled={false}
          initialTextFields={[TEXT]}
          initialValues={{ [TEXT.id]: "Hola" }}
          onValuesChange={(next) => (values = next)}
        />,
      );
      await waitForPreview();
      select();
      await waitFor(() => expect(floatingBar()).toBeTruthy());
      fireEvent.click(typeButton(strings.fieldTypeDate));
      expect(values[TEXT.id]).toBe("");
      expect(screen.queryByRole("button", { name: strings.undoTypeChange })).toBeNull();
    });

    it("fecha valida -> texto conserva el valor", async () => {
      let values: Record<string, string> = {};
      render(
        <Harness
          tool="select"
          richFieldTypesEnabled
          initialTextFields={[{ ...TEXT, type: "date" }]}
          initialValues={{ [TEXT.id]: "2026-10-08" }}
          onValuesChange={(next) => (values = next)}
        />,
      );
      await waitForPreview();
      select();
      await waitFor(() => expect(floatingBar()).toBeTruthy());
      fireEvent.click(typeButton(strings.fieldTypeText));
      expect(values[TEXT.id] ?? "2026-10-08").toBe("2026-10-08");
      expect(screen.queryByRole("button", { name: strings.undoTypeChange })).toBeNull();
    });

    it("texto -> casilla borra el texto con 'Deshacer', y deshacer devuelve el texto", async () => {
      let texts: DetectedField[] = [];
      let values: Record<string, string> = {};
      render(
        <Harness
          tool="select"
          richFieldTypesEnabled
          undoDeleteEnabled
          initialTextFields={[TEXT]}
          initialValues={{ [TEXT.id]: "Ana" }}
          onTextFieldsChange={(next) => (texts = next)}
          onValuesChange={(next) => (values = next)}
        />,
      );
      await waitForPreview();
      select();
      await waitFor(() => expect(floatingBar()).toBeTruthy());
      fireEvent.click(typeButton(strings.fieldTypeCheckbox));
      expect(texts[0].type).toBe("checkbox");
      expect(values[TEXT.id]).toBe("");
      fireEvent.click(screen.getByRole("button", { name: strings.undoTypeChange }));
      expect(texts[0].type).toBeUndefined();
      expect(values[TEXT.id]).toBe("Ana");
    });
  });

  describe("barra flotante: nombres, una fila y selector de tipo", () => {
    it("el grupo y las acciones nombran el elemento al que afectan", async () => {
      render(<Harness tool="select" initialTextFields={[NAME_FIELD]} />);
      await waitForPreview();
      fireEvent.pointerDown(textGroup("Nombre"), { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerUp(textGroup("Nombre"), { pointerId: 1 });
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(floatingBar()).toBeTruthy());
      const target = "Nombre, pendiente";
      expect(floatingBar().getAttribute("aria-label")).toBe(strings.selectionBarLabel(target));
      expect(
        within(floatingBar()).getByRole("button", {
          name: strings.elementAction(strings.duplicateElement, target),
        }),
      ).toBeTruthy();
      expect(
        within(floatingBar()).getByRole("button", {
          name: strings.elementAction(strings.removeTextField, target),
        }),
      ).toBeTruthy();
    });

    it("el hueco: grupo, tipo, firmante, duplicar y quitar nombran el hueco", async () => {
      render(<Harness tool="select" initialFields={[SLOT_FIELD]} />);
      await waitForPreview();
      fireEvent.pointerDown(screen.getByRole("group", { name: signatureLabel }), {
        pointerId: 1,
        clientX: 300,
        clientY: 600,
      });
      fireEvent.pointerUp(screen.getByRole("group", { name: signatureLabel }), { pointerId: 1 });
      await waitFor(() => expect(floatingBar()).toBeTruthy());
      const target = signatureLabel; // "Ana — Firma, hueco de firma"
      expect(floatingBar().getAttribute("aria-label")).toBe(strings.selectionBarLabel(target));
      for (const action of [strings.duplicateElement, strings.removeField]) {
        expect(
          within(floatingBar()).getByRole("button", { name: strings.elementAction(action, target) }),
        ).toBeTruthy();
      }
      expect(
        within(floatingBar()).getByRole("combobox", {
          name: strings.elementAction(strings.signerOfSlotLabel, target),
        }),
      ).toBeTruthy();
    });

    it("el selector de tipo es un solo boton que abre las opciones en la propia barra, con 'Volver' y foco gestionado", async () => {
      render(<Harness tool="select" richFieldTypesEnabled initialTextFields={[NAME_FIELD]} />);
      await waitForPreview();
      fireEvent.pointerDown(textGroup("Nombre"), { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerUp(textGroup("Nombre"), { pointerId: 1 });
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(floatingBar()).toBeTruthy());
      const bar = floatingBar();
      // Cerrado: 5 botones (tipo, duplicar, anterior, siguiente, quitar), una sola fila de botones.
      expect(within(bar).getAllByRole("button")).toHaveLength(5);
      const opener = within(bar).getByRole("button", { name: CHANGE_TYPE });
      expect(opener.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(opener);
      const group = within(floatingBar()).getByRole("group", {
        name: startsWith(strings.textFieldTypeLabel),
      });
      // Abierto: el tipo actual recibe el foco.
      await waitFor(() =>
        expect(document.activeElement).toBe(
          within(group).getByRole("button", { name: strings.fieldTypeText }),
        ),
      );
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      // Escape cierra el selector (no deselecciona) y devuelve el foco al boton.
      await waitFor(() =>
        expect(document.activeElement).toBe(
          within(floatingBar()).getByRole("button", { name: CHANGE_TYPE }),
        ),
      );
      expect(floatingBar()).toBeTruthy();
    });
  });

  describe("casilla", () => {
    it("creada arrastrando es cuadrada (el menor lado), no un rectangulo", async () => {
      let texts: DetectedField[] = [];
      render(
        <Harness tool="select" richFieldTypesEnabled onTextFieldsChange={(next) => (texts = next)} />,
      );
      await waitForPreview();
      pickTool(strings.fieldTypeCheckbox);
      const host = hostOf();
      // 300 x 80 px sobre una hoja de 600 x 800.
      fireEvent.pointerDown(host, { pointerId: 8, clientX: 60, clientY: 80 });
      fireEvent.pointerMove(host, { pointerId: 8, clientX: 360, clientY: 160 });
      fireEvent.pointerUp(host, { pointerId: 8, clientX: 360, clientY: 160 });
      const rect = texts[0].rect;
      expect(rect.width * HOST_WIDTH).toBeCloseTo(rect.height * HOST_HEIGHT, 3);
      expect(rect.width * HOST_WIDTH).toBeCloseTo(80, 3);
    });

    it("un arrastre minusculo (temblor) vale el tamano por defecto: cuadrado y >= 24 px", async () => {
      let texts: DetectedField[] = [];
      render(
        <Harness tool="select" richFieldTypesEnabled onTextFieldsChange={(next) => (texts = next)} />,
      );
      await waitForPreview();
      pickTool(strings.fieldTypeCheckbox);
      const host = hostOf();
      fireEvent.pointerDown(host, { pointerId: 8, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(host, { pointerId: 8, clientX: 113, clientY: 117 });
      fireEvent.pointerUp(host, { pointerId: 8, clientX: 113, clientY: 117 });
      const rect = texts[0].rect;
      expect(rect.width * HOST_WIDTH).toBeGreaterThanOrEqual(24 - 1e-6);
      expect(rect.width * HOST_WIDTH).toBeCloseTo(rect.height * HOST_HEIGHT, 3);
    });

    it("creada con un toque mide al menos 24 px de lado en pantalla", async () => {
      let texts: DetectedField[] = [];
      render(
        <Harness tool="select" richFieldTypesEnabled onTextFieldsChange={(next) => (texts = next)} />,
      );
      await waitForPreview();
      pickTool(strings.fieldTypeCheckbox);
      fireEvent.pointerDown(hostOf(), { pointerId: 7, clientX: 300, clientY: 400 });
      fireEvent.pointerUp(hostOf(), { pointerId: 7, clientX: 300, clientY: 400 });
      expect(texts[0].rect.width * HOST_WIDTH).toBeGreaterThanOrEqual(24 - 1e-6);
    });
  });
});

/* ------------------------------------------------------------------ *
 * W2-C: modo "Solo yo" sobre el lienzo y pulido de W2-B
 * ------------------------------------------------------------------ */

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SOLO_SLOT: SignatureField = {
  id: "solo-signature",
  signerId: "solo",
  pageIndex: 0,
  type: "signature",
  rect: { x: 0.3, y: 0.6, width: 0.32, height: 0.072 },
};
const soloLabel = `${strings.soloSignatureLabel}, ${strings.soloSignatureA11y}`;
const soloConfig = (patch: Partial<SoloConfig> = {}): SoloConfig => ({
  signaturePng: PNG,
  ratio: 0.3,
  onCreateSignature: () => {},
  ...patch,
});
const soloProps = { signers: [] as Signer[], activeSignerId: null, tool: "select" as PlacementTool };

describe("DocumentCanvas — modo Solo yo (W2-C)", () => {
  it("al llegar la firma se coloca sola en la pagina visible (centrada, tercio inferior, con su proporcion) y queda seleccionada", async () => {
    let slots: SignatureField[] = [];
    let selection: CanvasSelection | null = null;
    render(
      <Harness
        {...soloProps}
        solo={soloConfig()}
        onFieldsChange={(next) => (slots = next)}
        onSelectionChange={(next) => (selection = next)}
      />,
    );
    await waitForPreview();
    await waitFor(() => expect(slots).toHaveLength(1));
    expect(slots[0].id).toBe("solo-signature");
    expect(slots[0].signerId).toBe("solo");
    expect(slots[0].pageIndex).toBe(0);
    expect(slots[0].rect.width).toBeCloseTo(0.32, 6);
    // alto = ancho x proporcion del PNG x (ancho/alto de la hoja): 0.32 x 0.3 x 0.75
    expect(slots[0].rect.height).toBeCloseTo(0.072, 6);
    expect(slots[0].rect.x).toBeCloseTo(0.5 - 0.16, 6);
    expect(slots[0].rect.y).toBeCloseTo(0.74 - 0.036, 6);
    expect(selection).toEqual({ kind: "slot", id: "solo-signature" });
    expect(screen.getByRole("group", { name: soloLabel })).toBeTruthy();
    // La firma se ve tal como quedara: la imagen dentro del hueco.
    const box = screen.getByRole("group", { name: soloLabel });
    expect(box.querySelector("img")?.getAttribute("src")).toBe(PNG);
  });

  it("no pide firmantes: ni radiogrupo de firmante activo ni herramienta Iniciales; si estan Firma, Texto, Casilla y Fecha", async () => {
    render(<Harness {...soloProps} solo={soloConfig()} richFieldTypesEnabled />);
    await waitForPreview();
    expect(screen.queryByRole("radiogroup", { name: strings.activeSignerLabel })).toBeNull();
    expect(screen.queryByText(strings.slotsNeedSigners)).toBeNull();
    const names = within(palette())
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    expect(names).toEqual([
      strings.toolSelect,
      strings.fieldSignature,
      strings.fieldTypeText,
      strings.fieldTypeCheckbox,
      strings.fieldTypeDate,
      strings.prevField,
      strings.nextField,
    ]);
  });

  it("sin firma creada, la herramienta Firma (y su atajo F) abre el compositor y no arma nada", async () => {
    const onCreateSignature = vi.fn();
    render(
      <Harness
        {...soloProps}
        solo={soloConfig({ signaturePng: "", ratio: 0, onCreateSignature })}
      />,
    );
    await waitForPreview();
    armTool(strings.fieldSignature);
    expect(onCreateSignature).toHaveBeenCalledTimes(1);
    expect(
      within(palette()).getByRole("button", { name: strings.toolSelect }).getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.keyDown(document.body, { key: "f" });
    expect(onCreateSignature).toHaveBeenCalledTimes(2);
    // El propio lienzo ofrece crearla: boton visible y el aviso.
    expect(screen.getByText(strings.noSignature)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.createSignature }));
    expect(onCreateSignature).toHaveBeenCalledTimes(3);
  });

  it("con firma creada el boton del lienzo es 'Rehacer firma'", async () => {
    const onCreateSignature = vi.fn();
    render(<Harness {...soloProps} solo={soloConfig({ onCreateSignature })} />);
    await waitForPreview();
    fireEvent.click(screen.getByRole("button", { name: strings.changeSignature }));
    expect(onCreateSignature).toHaveBeenCalledTimes(1);
  });

  it("volver a usar la herramienta Firma MUEVE la unica firma (mismo id), no la duplica", async () => {
    let slots: SignatureField[] = [];
    render(
      <Harness
        {...soloProps}
        solo={soloConfig()}
        initialFields={[SOLO_SLOT]}
        onFieldsChange={(next) => (slots = next)}
      />,
    );
    await waitForPreview();
    armTool(strings.fieldSignature);
    fireEvent.click(screen.getByRole("button", { name: strings.soloPlaceHere }));
    expect(slots).toHaveLength(1);
    expect(slots[0].id).toBe("solo-signature");
    expect(slots[0].rect.y).not.toBeCloseTo(SOLO_SLOT.rect.y, 3);
    expect(screen.getAllByRole("group", { name: soloLabel })).toHaveLength(1);
  });

  it("una firma ya colocada no se vuelve a colocar al montar, pero se ajusta a la proporcion de una firma nueva", async () => {
    let slots: SignatureField[] = [];
    const { rerender } = render(
      <Harness
        {...soloProps}
        solo={soloConfig()}
        initialFields={[SOLO_SLOT]}
        onFieldsChange={(next) => (slots = next)}
      />,
    );
    await waitForPreview();
    // Misma proporcion: ni un cambio.
    expect(slots).toEqual([]);
    rerender(
      <Harness
        {...soloProps}
        solo={soloConfig({ signaturePng: `${PNG}#2`, ratio: 0.5 })}
        initialFields={[SOLO_SLOT]}
        onFieldsChange={(next) => (slots = next)}
      />,
    );
    await waitFor(() => expect(slots).toHaveLength(1));
    expect(slots[0].rect.x).toBe(SOLO_SLOT.rect.x);
    expect(slots[0].rect.width).toBe(SOLO_SLOT.rect.width);
    expect(slots[0].rect.height).toBeCloseTo(0.32 * 0.5 * 0.75, 6);
  });

  it("rehacer la firma desde OTRA pagina ajusta el alto a la proporcion de la pagina donde esta la firma, no de la que se ve", async () => {
    let slots: SignatureField[] = [];
    // La firma esta en la pagina 2 (apaisada, indice 1) y se esta viendo la 1 (vertical).
    const onPage2: SignatureField = { ...SOLO_SLOT, pageIndex: 1, rect: { x: 0.3, y: 0.4, width: 0.32, height: 0.18 } };
    const { rerender } = render(
      <Harness {...soloProps} solo={soloConfig({ ratio: 0.3 })} initialFields={[onPage2]} onFieldsChange={(next) => (slots = next)} />,
    );
    await waitForPreview();
    rerender(
      <Harness {...soloProps} solo={soloConfig({ signaturePng: `${PNG}#2`, ratio: 0.5 })} initialFields={[onPage2]} onFieldsChange={(next) => (slots = next)} />,
    );
    await waitFor(() => expect(slots).toHaveLength(1));
    expect(slots[0].pageIndex).toBe(1);
    expect(slots[0].rect.x).toBe(0.3);
    expect(slots[0].rect.width).toBe(0.32);
    // 0,32 x 0,5 x (800 / 600) de la pagina apaisada; con la proporcion de la visible saldria 0,12.
    expect(slots[0].rect.height).toBeCloseTo(0.32 * 0.5 * (800 / 600), 6);
  });

  it("la barra de la firma solo ofrece quitar (con el nombre del elemento); quitar avisa y 'Deshacer' la repone, y no se coloca de nuevo sola", async () => {
    let slots: SignatureField[] = [];
    render(
      <Harness
        {...soloProps}
        solo={soloConfig()}
        undoDeleteEnabled
        initialFields={[SOLO_SLOT]}
        onFieldsChange={(next) => (slots = next)}
      />,
    );
    await waitForPreview();
    fireEvent.pointerDown(screen.getByRole("group", { name: soloLabel }), {
      pointerId: 1,
      clientX: 300,
      clientY: 500,
    });
    fireEvent.pointerUp(screen.getByRole("group", { name: soloLabel }), { pointerId: 1 });
    await waitFor(() => expect(floatingBar()).toBeTruthy());
    const buttons = within(floatingBar()).getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute("aria-label")).toBe(
      strings.elementAction(strings.soloRemoveSignature, soloLabel),
    );
    fireEvent.click(buttons[0]);
    expect(slots).toEqual([]);
    expect(screen.getByText(strings.soloSignatureDeletedNotice)).toBeTruthy();
    expect(screen.queryByText(strings.fieldDeletedNotice)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: strings.undoRemoveField }));
    expect(slots).toHaveLength(1);
    expect(slots[0]).toEqual(SOLO_SLOT);
  });

  it("el tirador de la firma se llama 'Cambiar el tamaño de la firma' y la nombra en solo-yo", async () => {
    render(<Harness {...soloProps} solo={soloConfig()} initialFields={[SOLO_SLOT]} />);
    await waitForPreview();
    fireEvent.pointerDown(screen.getByRole("group", { name: soloLabel }), {
      pointerId: 1,
      clientX: 300,
      clientY: 500,
    });
    fireEvent.pointerUp(screen.getByRole("group", { name: soloLabel }), { pointerId: 1 });
    expect(screen.getByRole("button", { name: strings.soloResizeSignature })).toBeTruthy();
  });

  it("los campos de texto, casillas y fechas se rellenan en linea igual que en el paso Documento", async () => {
    let values: Record<string, string> = {};
    let texts: DetectedField[] = [];
    render(
      <Harness
        {...soloProps}
        solo={soloConfig()}
        richFieldTypesEnabled
        initialFields={[SOLO_SLOT]}
        initialTextFields={[NAME_FIELD_SOLO]}
        onValuesChange={(next) => (values = next)}
        onTextFieldsChange={(next) => (texts = next)}
      />,
    );
    await waitForPreview();
    fireEvent.pointerDown(textGroup("Nombre"), { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(textGroup("Nombre"), { pointerId: 1 });
    const input = await screen.findByRole("textbox", { name: "Nombre" });
    fireEvent.change(input, { target: { value: "Ana Perez" } });
    expect(values[NAME_FIELD_SOLO.id]).toBe("Ana Perez");
    fireEvent.blur(input);
    // Un campo manual con la paleta.
    armTool(strings.fieldTypeCheckbox);
    fireEvent.click(screen.getByRole("button", { name: strings.addTextFieldHere }));
    expect(texts.some((field) => field.type === "checkbox")).toBe(true);
    // Los resumenes hablan de firma, no de huecos.
    expect(
      screen.getByText(new RegExp(`^${strings.soloPageSummary(1, 2).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)),
    ).toBeTruthy();
  });

  it("no hay ningun formulario ni campo de formulario fuera del lienzo (solo el editor en linea)", async () => {
    const { container } = render(
      <Harness {...soloProps} solo={soloConfig()} initialTextFields={[NAME_FIELD_SOLO]} />,
    );
    await waitForPreview();
    const host = container.querySelector('[data-canvas="host"]')!;
    const stray = [...container.querySelectorAll("form, input, textarea, select")].filter(
      (node) => !host.contains(node),
    );
    expect(stray).toEqual([]);
  });
});

const NAME_FIELD_SOLO: DetectedField = {
  id: "txt-solo-a",
  pageIndex: 0,
  rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
  label: "Nombre",
  source: "acroform",
  confidence: "high",
};

describe("DocumentCanvas — pulido tactil y de teclado (W2-C)", () => {
  it("zoom y paginas viven en una barra pegajosa y miden 44 px con puntero grueso (clase, no solo zona de toque)", async () => {
    render(<Harness tool="select" pinchZoomEnabled />);
    await waitForPreview();
    const sticky = document.querySelector("[data-canvas-sticky]") as HTMLElement;
    expect(sticky).toBeTruthy();
    expect(sticky.className).toContain("sticky");
    for (const name of [
      strings.zoomOut,
      strings.resetZoomButton,
      strings.zoomIn,
      strings.previousPage,
      strings.nextPage,
    ]) {
      const button = within(sticky).getByRole("button", { name });
      expect(button.className).toContain("pointer-coarse:h-11");
    }
    // El grupo de zoom esta dentro de la barra pegajosa.
    expect(within(sticky).getByRole("group", { name: strings.zoomGroupLabel })).toBeTruthy();
  });

  it("la pagina se escribe completa para lectores de pantalla y compacta ('1 / 2') en pantallas estrechas, para que la barra quepa en una fila", async () => {
    render(<Harness tool="select" pinchZoomEnabled />);
    await waitForPreview();
    const full = await screen.findByText(strings.pageOf(1, 2));
    expect(full.className).toContain("max-[420px]:sr-only");
    const compact = full.parentElement!.querySelector('[aria-hidden="true"]')!;
    expect(compact.textContent).toBe("1 / 2");
    expect(compact.className).toContain("max-[420px]:inline");
    expect(compact.className).toContain("hidden");
  });

  it("Tab desde el elemento entra en la barra; si la barra no admite foco (oculta) no se traga la tecla", async () => {
    render(<Harness tool="select" initialTextFields={[NAME_FIELD]} />);
    await waitForPreview();
    fireEvent.pointerDown(textGroup("Nombre"), { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(textGroup("Nombre"), { pointerId: 1 });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(floatingBar()).toBeTruthy());
    // Con barra visible: entra (y la tecla se consume).
    textGroup("Nombre").focus();
    expect(fireEvent.keyDown(textGroup("Nombre"), { key: "Tab" })).toBe(false);
    expect(floatingBar().contains(document.activeElement)).toBe(true);
    // Barra que no recibe el foco: Tab sigue su camino natural.
    textGroup("Nombre").focus();
    const first = within(floatingBar()).getAllByRole("button")[0];
    const spy = vi.spyOn(first, "focus").mockImplementation(() => {});
    expect(fireEvent.keyDown(textGroup("Nombre"), { key: "Tab" })).toBe(true);
    spy.mockRestore();
  });

  it("el lienzo marca <html> con data-fixed-palette mientras esta montado (reserva el alto de la paleta fija)", async () => {
    const { unmount } = render(<Harness tool="select" />);
    expect(document.documentElement.hasAttribute("data-fixed-palette")).toBe(true);
    unmount();
    expect(document.documentElement.hasAttribute("data-fixed-palette")).toBe(false);
  });

  describe("selector de tipo de la barra", () => {
    const openOn = async (fields = [NAME_FIELD, EMAIL_FIELD]) => {
      render(<Harness tool="select" richFieldTypesEnabled initialTextFields={fields} />);
      await waitForPreview();
      fireEvent.pointerDown(textGroup("Nombre"), { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerUp(textGroup("Nombre"), { pointerId: 1 });
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(floatingBar()).toBeTruthy());
    };
    const opener = () => within(floatingBar()).getByRole("button", { name: CHANGE_TYPE });
    const outsideButton = () => {
      const button = document.createElement("button");
      button.textContent = "fuera";
      document.body.appendChild(button);
      return button;
    };

    it("Tab desde 'Volver' (la ultima accion) cierra el selector: la barra vuelve a sus acciones con aria-expanded=false", async () => {
      // Un solo campo: no hay "siguiente elemento", asi que Tab saca el foco de la pagina entera.
      await openOn([NAME_FIELD]);
      fireEvent.click(opener());
      const back = within(floatingBar()).getByRole("button", { name: strings.closeTypePicker });
      back.focus();
      fireEvent.keyDown(back, { key: "Tab" });
      // El navegador mueve el foco al siguiente elemento enfocable, fuera de la barra.
      outsideButton().focus();
      await waitFor(() => expect(within(floatingBar()).queryByRole("button", { name: strings.closeTypePicker })).toBeNull());
      expect(opener().getAttribute("aria-expanded")).toBe("false");
      // El foco salio de la barra: el selector no le roba el foco de vuelta.
      expect(floatingBar().contains(document.activeElement)).toBe(false);
    });

    it("Mayus+Tab desde la primera opcion tambien lo cierra", async () => {
      await openOn();
      fireEvent.click(opener());
      const group = within(floatingBar()).getByRole("group", { name: startsWith(strings.textFieldTypeLabel) });
      const first = within(group).getAllByRole("button")[0];
      first.focus();
      fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
      outsideButton().focus();
      await waitFor(() => expect(within(floatingBar()).queryByRole("button", { name: strings.closeTypePicker })).toBeNull());
      expect(opener().getAttribute("aria-expanded")).toBe("false");
    });

    it("el foco que sale por cualquier via (focusout hacia fuera de la barra) cierra el selector; moverse dentro de la barra no", async () => {
      await openOn();
      fireEvent.click(opener());
      const group = within(floatingBar()).getByRole("group", { name: startsWith(strings.textFieldTypeLabel) });
      const [first, second] = within(group).getAllByRole("button");
      fireEvent.focusOut(first, { relatedTarget: second });
      expect(within(floatingBar()).getByRole("button", { name: strings.closeTypePicker })).toBeTruthy();
      fireEvent.focusOut(first, { relatedTarget: document.body.appendChild(document.createElement("button")) });
      await waitFor(() => expect(within(floatingBar()).queryByRole("button", { name: strings.closeTypePicker })).toBeNull());
    });

    it("Escape lo cierra y devuelve el foco al boton que lo abre, sin deseleccionar", async () => {
      await openOn();
      fireEvent.click(opener());
      const group = within(floatingBar()).getByRole("group", { name: startsWith(strings.textFieldTypeLabel) });
      const current = within(group).getByRole("button", { name: strings.fieldTypeText });
      await waitFor(() => expect(document.activeElement).toBe(current));
      fireEvent.keyDown(current, { key: "Escape" });
      await waitFor(() => expect(document.activeElement).toBe(opener()));
      expect(opener().getAttribute("aria-expanded")).toBe("false");
    });

    it("si se deselecciona con el selector abierto, al volver a elegir el campo no reaparece abierto", async () => {
      await openOn();
      fireEvent.click(opener());
      expect(within(floatingBar()).getByRole("button", { name: strings.closeTypePicker })).toBeTruthy();
      // Toque corto en vacio: deselecciona.
      const host = screen.getByAltText(strings.documentTitle).parentElement!;
      fireEvent.pointerDown(host, { pointerId: 5, clientX: 500, clientY: 700 });
      fireEvent.pointerUp(host, { pointerId: 5, clientX: 500, clientY: 700 });
      await waitFor(() => expect(screen.queryByRole("group", { name: BAR_NAME })).toBeNull());
      fireEvent.pointerDown(textGroup("Nombre"), { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerUp(textGroup("Nombre"), { pointerId: 1 });
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(floatingBar()).toBeTruthy());
      expect(within(floatingBar()).queryByRole("button", { name: strings.closeTypePicker })).toBeNull();
      expect(opener().getAttribute("aria-expanded")).toBe("false");
    });
  });

  describe("texto -> iniciales", () => {
    const TEXT: DetectedField = { ...NAME_FIELD_SOLO, id: "txt-ini", label: "Dato" };
    const run = async (initial: string) => {
      let values: Record<string, string> = {};
      render(
        <Harness
          tool="select"
          richFieldTypesEnabled
          undoDeleteEnabled
          initialTextFields={[TEXT]}
          initialValues={{ [TEXT.id]: initial }}
          onValuesChange={(next) => (values = next)}
        />,
      );
      await waitForPreview();
      fireEvent.pointerDown(textGroup("Dato"), { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerUp(textGroup("Dato"), { pointerId: 1 });
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(floatingBar()).toBeTruthy());
      const group = () =>
        within(floatingBar()).getByRole("group", { name: startsWith(strings.textFieldTypeLabel) });
      const toType = (name: string) => {
        fireEvent.click(within(floatingBar()).getByRole("button", { name: CHANGE_TYPE }));
        fireEvent.click(within(group()).getByRole("button", { name }));
      };
      return { values: () => values, toType };
    };

    it.each([
      ["  Ana  Maria  ", "AM"],
      ["Hola mundo", "HM"],
      ["Supercalifragilistico", "SUPE"],
      ["uno dos tres cuatro cinco seis", "UDTC"],
      ["  ana", "ANA"],
    ])("%j -> %j y de vuelta a texto recupera el original exacto", async (original, expected) => {
      const { values, toType } = await run(original);
      toType(strings.fieldTypeInitials);
      expect(values()[TEXT.id]).toBe(expected);
      toType(strings.fieldTypeText);
      expect(values()[TEXT.id]).toBe(original);
    });

    it("ida y vuelta pasando por un tipo que borra: 'Deshacer' repone las iniciales y volver a texto sigue dando el original", async () => {
      const { values, toType } = await run("Hola mundo");
      toType(strings.fieldTypeInitials);
      toType(strings.fieldTypeDate); // "HM" no es una fecha: se borra, con aviso
      expect(values()[TEXT.id]).toBe("");
      fireEvent.click(screen.getByRole("button", { name: strings.undoTypeChange }));
      expect(values()[TEXT.id]).toBe("HM");
      toType(strings.fieldTypeText);
      expect(values()[TEXT.id]).toBe("Hola mundo");
    });
  });
});
