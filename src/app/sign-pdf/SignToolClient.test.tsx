import "fake-indexeddb/auto";
import { useCallback, useEffect, useState, type MutableRefObject } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PDFDocument } from "@cantoo/pdf-lib";
import {
  MultiFlow,
  SignToolClient,
  migrateStep,
  type SignToolOptions,
} from "@/app/sign-pdf/SignToolClient";
import { documentContentKey } from "@/app/sign-pdf/documentKey";
import {
  captureStamp,
  pendingSigners,
  validCapture,
  type CaptureMap,
} from "@/app/sign-pdf/SigningCeremony";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { LanguageProvider, LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { fileKey } from "@/app/organize-pdf/pageToolkit";
import {
  normalizeFieldLabel,
  signerColorAt,
  type SignatureField,
  type Signer,
} from "@/lib/pdf/sign";
import { detectFields, type DetectedField } from "@/lib/pdf/detectFields";
import { clearAllDrafts, listDrafts } from "@/app/sign-pdf/signDrafts";
import { exportSignConfig } from "@/app/sign-pdf/signConfig";
import {
  __resetValueHistoryCacheForTests,
  recordValue,
} from "@/lib/valueHistory";
import {
  __resetSignPdfFeatureFlagsCacheForTests,
  setSignPdfFeatureFlag,
} from "@/app/sign-pdf/signFeatureFlags";
import { __resetSignTemplatesCacheForTests } from "@/app/sign-pdf/signTemplates";

/**
 * `detectFields` abre el documento con pdf-lib y pdf.js de verdad; los
 * ficheros de prueba de este archivo son bytes cualquiera, no PDFs
 * validos. Sin mock, la deteccion real ya se resuelve sola en "fallo,
 * sigue siendo manual" (el efecto la captura), pero para probar el paso
 * de texto de forma determinista se sustituye por un mock controlable.
 */
vi.mock("@/lib/pdf/detectFields", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/detectFields")>();
  return { ...actual, detectFields: vi.fn(async () => []) };
});

const strings = SIGN_STRINGS.es;

/** Plazo para que una `Sheet` termine su animacion de salida (muelle de tiempo real) incluso con la maquina saturada. */
const SHEET_EXIT_TIMEOUT_MS = 8000;

/**
 * Paleta del paso Documento (W2-B): la herramienta por defecto es Seleccionar
 * y cada una es de un solo uso, asi que se arma antes de cada alta.
 */
function armTool(name: string) {
  fireEvent.click(
    within(screen.getByRole("toolbar", { name: strings.paletteLabel })).getByRole(
      "button",
      { name },
    ),
  );
}
function addTextFieldHere() {
  armTool(strings.fieldTypeText);
  fireEvent.click(screen.getByRole("button", { name: strings.addTextFieldHere }));
}
function addSlotHere() {
  armTool(strings.fieldSignature);
  fireEvent.click(screen.getByRole("button", { name: strings.addFieldHere }));
}

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };

const PRIMERO = new File([new Uint8Array([1, 2, 3])], "contrato.pdf", {
  type: "application/pdf",
  lastModified: 1_700_000_000_000,
});
const SEGUNDO = new File([new Uint8Array([9, 9, 9, 9])], "anexo.pdf", {
  type: "application/pdf",
  lastModified: 1_700_000_999_999,
});
/** Otro documento que se hace pasar por el primero: misma ficha, otro contenido. */
const IMPOSTOR = new File([new Uint8Array([7, 7, 7])], "contrato.pdf", {
  type: "application/pdf",
  lastModified: 1_700_000_000_000,
});

const FIELDS: SignatureField[] = [
  {
    id: "f1",
    signerId: ANA.id,
    pageIndex: 0,
    type: "signature",
    rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
  },
];

let CLAVE_PRIMERO = "";
let CLAVE_SEGUNDO = "";
let CLAVE_IMPOSTOR = "";

beforeAll(async () => {
  CLAVE_PRIMERO = await documentContentKey(PRIMERO);
  CLAVE_SEGUNDO = await documentContentKey(SEGUNDO);
  CLAVE_IMPOSTOR = await documentContentKey(IMPOSTOR);
});

beforeEach(() => {
  vi.mocked(detectFields).mockReset();
  vi.mocked(detectFields).mockResolvedValue([]);
  window.sessionStorage.clear();
  window.localStorage.clear();
  __resetValueHistoryCacheForTests();
  __resetSignPdfFeatureFlagsCacheForTests();
  __resetSignTemplatesCacheForTests();
  // `localStorage.clear()` de arriba tambien borra el idioma: sin esto,
  // `<SignToolClient>` (a diferencia de `<MultiFlow>`, que recibe
  // `strings` ya resuelto) lee `useI18n()` el mismo y pintaria en el
  // idioma por defecto del entorno de pruebas en vez de en "es".
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

/** Ronda ya firmada sobre `PRIMERO`, esperando en el paso de firma. */
function optionsFor(documentKey: string): SignToolOptions {
  return {
    mode: "multi",
    signaturePng: "",
    ratio: 0,
    pageIndex: 0,
    rect: { x: 0, y: 0, width: 0, height: 0 },
    signature: documentKey,
    step: "sign",
    signers: [ANA],
    fields: FIELDS,
    captures: {
      [ANA.id]: {
        signature: {
          dataUrl: "data:image/png;base64,iVBORw0KGgo=",
          ratio: 0.3,
        },
        initials: null,
        stamp: captureStamp(documentKey, FIELDS, ANA.id),
      } satisfies CaptureMap[string],
    },
    activeSignerId: ANA.id,
    fieldPageIndex: 0,
    selectedFieldId: null,
    placementTool: "select",
    textFields: [],
    textValues: {},
    selectedTextFieldId: null,
    editingTextFieldId: null,
    textFieldsDetectedFor: null,
  };
}

type HarnessProps = {
  file: File;
  onOptions: (options: SignToolOptions) => void;
  initialOptions?: SignToolOptions;
};

function Harness({ file, onOptions, initialOptions }: HarnessProps) {
  const [options, setOptions] = useState<SignToolOptions>(
    () => initialOptions ?? optionsFor(CLAVE_PRIMERO),
  );
  onOptions(options);
  // Igual que el `setOptions` de verdad (`ToolShell`, `useCallback` con
  // dependencias vacias): una referencia estable entre renders. Sin
  // esto, un `useEffect` con `setOptions` en sus dependencias (como el
  // de reinicio+deteccion de `MultiFlow`) se re-dispara en cada render y
  // cancela su propia deteccion en marcha antes de que resuelva.
  const patchOptions = useCallback(
    (patch: Partial<SignToolOptions>) =>
      setOptions((previous) => ({ ...previous, ...patch })),
    [],
  );
  return (
    <MultiFlow
      file={file}
      options={options}
      setOptions={patchOptions}
      onFinish={() => {}}
      strings={strings}
    />
  );
}

/** La ronda solo se pinta cuando ya hay huella del documento. */
async function settled(): Promise<void> {
  await waitFor(() =>
    expect(screen.queryByText(strings.checkingDocument)).toBeNull(),
  );
}

describe("MultiFlow — src/app/sign-pdf/SignToolClient.tsx", () => {
  it("mantiene huecos y trazos mientras el archivo cargado sea el mismo", async () => {
    let last: SignToolOptions = optionsFor(CLAVE_PRIMERO);
    const { rerender } = render(
      <Harness file={PRIMERO} onOptions={(options) => (last = options)} />,
    );
    await settled();

    rerender(
      <Harness file={PRIMERO} onOptions={(options) => (last = options)} />,
    );
    await settled();

    expect(last.fields).toHaveLength(1);
    expect(last.captures[ANA.id]?.signature).not.toBeNull();
    expect(last.signature).toBe(CLAVE_PRIMERO);
    expect(screen.getByText(strings.statusSigned)).toBeTruthy();
  });

  it("al reemplazar el PDF cargado reinicia huecos y trazos y conserva a los firmantes", async () => {
    let last: SignToolOptions = optionsFor(CLAVE_PRIMERO);
    const { rerender } = render(
      <Harness file={PRIMERO} onOptions={(options) => (last = options)} />,
    );
    await settled();
    expect(last.fields).toHaveLength(1);

    rerender(
      <Harness file={SEGUNDO} onOptions={(options) => (last = options)} />,
    );
    await waitFor(() => expect(last.signature).toBe(CLAVE_SEGUNDO));

    expect(last.fields).toEqual([]);
    expect(last.captures).toEqual({});
    expect(last.selectedFieldId).toBeNull();
    expect(last.step).toBe("signers");
    expect(last.signers.map((signer) => signer.id)).toEqual([ANA.id]);
    // Nadie arrastra el "ya firmado" del documento anterior.
    expect(screen.getByLabelText(strings.signerNameLabel(1))).toBeTruthy();
  });

  it("otro PDF con el mismo nombre, tamaño y fecha tambien reinicia la ronda", async () => {
    // La identidad barata no los distingue; la del contenido si.
    expect(fileKey(IMPOSTOR)).toBe(fileKey(PRIMERO));

    let last: SignToolOptions = optionsFor(CLAVE_PRIMERO);
    const { rerender } = render(
      <Harness file={PRIMERO} onOptions={(options) => (last = options)} />,
    );
    await settled();
    expect(last.captures[ANA.id]?.signature).not.toBeNull();

    rerender(
      <Harness file={IMPOSTOR} onOptions={(options) => (last = options)} />,
    );
    await waitFor(() => expect(last.signature).toBe(CLAVE_IMPOSTOR));

    expect(last.fields).toEqual([]);
    expect(last.captures).toEqual({});
    expect(last.step).toBe("signers");
  });
});

/**
 * Documento "recien cargado" (huella sin sellar todavia) sin ningun hueco
 * de firma: cuando llega la huella, `MultiFlow` solo la sella y lanza la
 * deteccion, igual que con un archivo de verdad. Arranca en el paso
 * "signers" (como `DEFAULT_OPTIONS`); las pruebas navegan a "document" a
 * mano, como haria una persona real. Sin firmantes, el lienzo solo ofrece
 * la herramienta de campos de texto.
 */
function freshTextOnlyOptions(): SignToolOptions {
  return {
    ...optionsFor(""),
    step: "signers",
    fields: [],
    captures: {},
    signers: [],
  };
}

/** Paso "Documento" (W2-A): el antiguo paso de texto y el de huecos, fusionados. */
const textStepButton = () =>
  screen.getByRole("button", { name: `2. ${strings.stepDocument}` });
const signStepButton = () =>
  screen.getByRole("button", {
    name: `3. ${strings.stepSign}`,
  }) as HTMLButtonElement;

describe("MultiFlow — paso Documento, campos de texto (src/app/sign-pdf/SignToolClient.tsx)", () => {
  it("detecta campos al cargar el documento y los deja en `textFields`", async () => {
    const detected: DetectedField[] = [
      {
        id: "d1",
        pageIndex: 0,
        rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
        label: "Nombre",
        source: "acroform",
        confidence: "high",
      },
    ];
    vi.mocked(detectFields).mockResolvedValue(detected);

    let last: SignToolOptions = freshTextOnlyOptions();
    render(
      <Harness
        file={PRIMERO}
        initialOptions={freshTextOnlyOptions()}
        onOptions={(options) => (last = options)}
      />,
    );
    await settled();
    await waitFor(() => expect(last.textFields).toHaveLength(1));

    fireEvent.click(textStepButton());
    expect(last.textFields[0].label).toBe("Nombre");
    // Detectado, no tocado todavia: esta sobre el lienzo (con su estado
    // en el nombre accesible), pero no se abre ningun editor (eso solo
    // pasa al tocarlo). Ya no hay ningun indice ni formulario aparte.
    expect(
      screen.getByRole("group", { name: `Nombre, ${strings.a11yPending}` }),
    ).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Nombre" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Nombre" })).toBeNull();
  });

  it("el paso Documento siempre es alcanzable, y firmar se habilita en cuanto un campo tiene valor", async () => {
    let last: SignToolOptions = freshTextOnlyOptions();
    render(
      <Harness
        file={PRIMERO}
        initialOptions={freshTextOnlyOptions()}
        onOptions={(options) => (last = options)}
      />,
    );
    await settled();

    // Sin firmantes no hay a quien asignar un hueco, pero "Documento" no
    // depende de ellos (campos de texto): siempre se puede entrar.
    expect((textStepButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(textStepButton());
    expect(last.step).toBe("document");

    addTextFieldHere();
    await waitFor(() => expect(last.textFields).toHaveLength(1));

    // Sin ningun valor todavia, "Firmar" no es alcanzable: no hay huecos
    // de firma (fields=[]) ni ningun campo de texto relleno.
    expect(signStepButton().disabled).toBe(true);

    const label = strings.textFieldFallbackLabel(1);
    const input = screen.getAllByRole("textbox", { name: label })[0];
    fireEvent.change(input, { target: { value: "Ana" } });

    await waitFor(() => expect(signStepButton().disabled).toBe(false));
    expect(last.fields).toEqual([]);
    expect(last.textValues[last.textFields[0].id]).toBe("Ana");
  });

  it("propone reutilizar los valores de la ultima sesion si las etiquetas coinciden", async () => {
    recordValue(normalizeFieldLabel("Nombre"), "Ana Garcia");
    vi.mocked(detectFields).mockResolvedValue([
      {
        id: "d1",
        pageIndex: 0,
        rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
        label: "Nombre",
        source: "acroform",
        confidence: "high",
      },
    ]);

    let last: SignToolOptions = freshTextOnlyOptions();
    render(
      <Harness
        file={PRIMERO}
        initialOptions={freshTextOnlyOptions()}
        onOptions={(options) => (last = options)}
      />,
    );
    await settled();
    await waitFor(() => expect(last.textFields).toHaveLength(1));
    fireEvent.click(textStepButton());

    expect(screen.getByText(strings.reuseValuesPrompt)).toBeTruthy();
    // El valor se muestra explicitamente antes de aceptar (no es un
    // "usar los mismos datos" a ciegas): ver la revision de arquitectura
    // de WS5, riesgo de fuga entre clientes con la misma etiqueta.
    expect(screen.getByText("Ana Garcia")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: strings.reuseValuesAccept }),
    );

    await waitFor(() =>
      expect(last.textValues[last.textFields[0].id]).toBe("Ana Garcia"),
    );
    expect(screen.queryByText(strings.reuseValuesPrompt)).toBeNull();
  });

  it("declinar reutilizar lo recuerda en sessionStorage por documento, para que sobreviva a un remonte de MultiFlow", async () => {
    recordValue(normalizeFieldLabel("Nombre"), "Ana Garcia");
    vi.mocked(detectFields).mockResolvedValue([
      {
        id: "d1",
        pageIndex: 0,
        rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
        label: "Nombre",
        source: "acroform",
        confidence: "high",
      },
    ]);

    render(
      <Harness
        file={PRIMERO}
        initialOptions={freshTextOnlyOptions()}
        onOptions={() => {}}
      />,
    );
    await settled();
    fireEvent.click(textStepButton());
    await waitFor(() =>
      expect(screen.getByText(strings.reuseValuesPrompt)).toBeTruthy(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.reuseValuesDecline }),
    );
    expect(screen.queryByText(strings.reuseValuesPrompt)).toBeNull();

    // La marca de "declinado" vive en `sessionStorage`, atada a la huella
    // real del documento -- a diferencia de un `ref` de componente,
    // sobrevive a que `MultiFlow` se desmonte y remonte (ej. alternar
    // "Solo yo" <-> "Varios firmantes"), que es justo cuando el banner
    // resucitaba antes de este cambio.
    const stored = window.sessionStorage.getItem(
      "optimuspdf:sign-fill:declinedReuse",
    );
    expect(stored).toContain(CLAVE_PRIMERO);
  });
});

describe("MultiFlow — aviso de campos pendientes (Recomendacion #2)", () => {
  it("avisa, sin bloquear, si queda algun campo de texto sin rellenar", async () => {
    let last: SignToolOptions = freshTextOnlyOptions();
    render(
      <Harness
        file={PRIMERO}
        initialOptions={freshTextOnlyOptions()}
        onOptions={(options) => (last = options)}
      />,
    );
    await settled();
    fireEvent.click(textStepButton());

    addTextFieldHere();
    await waitFor(() => expect(last.textFields).toHaveLength(1));

    // Rellenar el primero MIENTRAS sigue en edicion: el siguiente click
    // en "anadir" (otro elemento) le hace perder el foco y cierra su
    // editor, igual que tocaria otro campo un usuario real.
    const firstLabel = strings.textFieldFallbackLabel(1);
    fireEvent.change(screen.getByRole("textbox", { name: firstLabel }), {
      target: { value: "Ana" },
    });

    addTextFieldHere();
    await waitFor(() => expect(last.textFields).toHaveLength(2));

    await waitFor(() =>
      expect(
        screen.getByText(strings.pendingTextFieldsWarning(1)),
      ).toBeTruthy(),
    );
    // No bloquea: "Siguiente" solo depende de poder alcanzar el paso
    // siguiente, no de que todos los campos esten rellenos.
    const next = screen.getByRole("button", {
      name: strings.next,
    }) as HTMLButtonElement;
    expect(next.disabled).toBe(false);
  });

  it("no muestra nada si todos los campos ya tienen valor", async () => {
    let last: SignToolOptions = freshTextOnlyOptions();
    render(
      <Harness
        file={PRIMERO}
        initialOptions={freshTextOnlyOptions()}
        onOptions={(options) => (last = options)}
      />,
    );
    await settled();
    fireEvent.click(textStepButton());

    addTextFieldHere();
    await waitFor(() => expect(last.textFields).toHaveLength(1));

    const label = strings.textFieldFallbackLabel(1);
    const input = screen.getAllByRole("textbox", { name: label })[0];
    fireEvent.change(input, { target: { value: "Ana" } });

    await waitFor(() => expect(last.textValues[last.textFields[0].id]).toBe("Ana"));
    expect(screen.queryByText(strings.pendingTextFieldsWarning(1))).toBeNull();
  });

  it("con la funcion apagada en Ajustes, no se muestra aunque falten campos", async () => {
    setSignPdfFeatureFlag("fieldsCompleteNotice", false);
    let last: SignToolOptions = freshTextOnlyOptions();
    render(
      <Harness
        file={PRIMERO}
        initialOptions={freshTextOnlyOptions()}
        onOptions={(options) => (last = options)}
      />,
    );
    await settled();
    fireEvent.click(textStepButton());

    addTextFieldHere();
    await waitFor(() => expect(last.textFields).toHaveLength(1));

    const firstLabel = strings.textFieldFallbackLabel(1);
    fireEvent.change(screen.getByRole("textbox", { name: firstLabel }), {
      target: { value: "Ana" },
    });

    addTextFieldHere();
    await waitFor(() => expect(last.textFields).toHaveLength(2));

    expect(screen.queryByText(strings.pendingTextFieldsWarning(1))).toBeNull();
  });
});

describe("SignToolClient — flujo completo (firmar -> prompt -> aceptar)", () => {
  /** El input de PDF, no el de zip que pinta la fila de "Importar configuracion". */
  function pdfInput(container: HTMLElement): HTMLInputElement {
    const input = container.querySelector('input[type="file"][accept*="pdf"]');
    if (!input) throw new Error("no se encontro el input de archivo PDF");
    return input as HTMLInputElement;
  }

  async function pdfFile(name: string): Promise<File> {
    const document = await PDFDocument.create();
    // Tamano de pagina propio (distinto del 300x300 que usa el describe
    // de "borradores locales" mas abajo con el mismo nombre de archivo,
    // "contrato.pdf"): `pdf-lib` genera bytes deterministas para una
    // creacion identica, y `documentContentKey` solo mira el contenido.
    // Este describe SI llega hasta firmar (autoguarda con `step: "sign"`
    // via el autoguardado real de SignToolClient) -- coincidir de huella
    // con el otro describe hacia que su lectura de "el borrador que YO
    // acabo de guardar" pudiera devolver este, con un paso distinto.
    document.addPage([310, 310]);
    const bytes = await document.save({ useObjectStreams: true });
    return new File([bytes as unknown as BlobPart], name, {
      type: "application/pdf",
    });
  }

  it("tras firmar y descargar, aceptar \"firmar otro\" vuelve a firmantes con el mismo roster y sin archivo", async () => {
    const file = await pdfFile("contrato.pdf");
    const { container } = render(
      <LanguageProvider>
        <SignToolClient />
      </LanguageProvider>,
    );

    // 1. Cargar el archivo y pasar a "Varios firmantes". Selector
    // especifico (no el generico `input[type="file"]`): la fila de
    // "Importar configuracion" del propio `SignToolClient` tambien pinta
    // un input de archivo (para zips), asi que un selector generico
    // acertaria al equivocado.
    const input = pdfInput(container);
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(
      await screen.findByRole("tab", { name: strings.modeMulti }),
    );

    // 2. Anadir un firmante y pasar al paso Documento (sin huecos de
    // imagen: el paso de firma usa el panel simple "Aplicar y descargar").
    fireEvent.click(
      screen.getByRole("button", { name: strings.addSigner }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: `2. ${strings.stepDocument}` }),
    );

    // 3. Con firmantes la herramienta por defecto es "hueco": cambiar a
    // campo de texto, anadir uno (se abre editando de inmediato, ver
    // `addTextField` en DocumentCanvas.tsx) y escribir un valor.
    addTextFieldHere();
    const textInput = await screen.findByRole("textbox", {
      name: strings.textFieldFallbackLabel(1),
    });
    fireEvent.change(textInput, { target: { value: "Ana Perez" } });
    fireEvent.blur(textInput);

    // 4. Pasar al paso de firma y descargar (sin huecos de imagen).
    fireEvent.click(
      screen.getByRole("button", { name: `3. ${strings.stepSign}` }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.finishAndDownload }),
    );

    // 5. Tras terminar: aparece el prompt de "firmar otro".
    await waitFor(() =>
      expect(screen.getByText(strings.signAgainTitle)).toBeTruthy(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.signAgainAccept }),
    );

    // 6. De vuelta a "idle" (sin archivo cargado)...
    await waitFor(() => expect(pdfInput(container)).toBeTruthy());
    expect(screen.queryByText(strings.signAgainTitle)).toBeNull();

    // ...pero con el roster de firmantes conservado: cargar otro archivo
    // y el firmante ya esta ahi, sin tener que anadirlo de nuevo.
    const secondFile = await pdfFile("anexo.pdf");
    fireEvent.change(pdfInput(container), { target: { files: [secondFile] } });
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: strings.removeSigner(strings.defaultSignerName(1)),
        }),
      ).toBeTruthy(),
    );
  });
});

describe("SignToolClient — borradores locales y configuracion (WS8/WS9)", () => {
  async function pdfFile(name: string): Promise<File> {
    const document = await PDFDocument.create();
    // Tamano de pagina propio: `pdf-lib` genera bytes deterministas para
    // una creacion identica, y `documentContentKey` (la identidad de
    // "que borrador es este") solo mira el contenido, nunca el nombre de
    // archivo. Este describe lee de vuelta lo que EL PROPIO autoguardado
    // real escribio (no un `Harness` con estado fijo) -- si otro
    // describe de este archivo usara el mismo tamano por defecto de
    // 300x300 para su "contrato.pdf", ambos compartirian huella y una
    // escritura tardia de uno (el autoguardado no se cancela solo por
    // desmontar) podria aterrizar en el borrador que este lee.
    document.addPage([305, 305]);
    const bytes = await document.save({ useObjectStreams: true });
    return new File([bytes as unknown as BlobPart], name, {
      type: "application/pdf",
    });
  }

  function pdfInput(container: HTMLElement): HTMLInputElement {
    const input = container.querySelector('input[type="file"][accept*="pdf"]');
    if (!input) throw new Error("no se encontro el input de archivo PDF");
    return input as HTMLInputElement;
  }

  beforeEach(async () => {
    await clearAllDrafts();
  });

  it(
    "autoguarda un borrador con progreso real y lo reanuda con el mismo estado",
    async () => {
      const file = await pdfFile("contrato.pdf");
      const id = await documentContentKey(file);
      const { container, unmount } = render(
        <LanguageProvider>
          <SignToolClient />
        </LanguageProvider>,
      );

      fireEvent.change(pdfInput(container), { target: { files: [file] } });
      fireEvent.click(
        await screen.findByRole("tab", { name: strings.modeMulti }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: strings.addSigner }),
      );

      // El autoguardado tiene un debounce real (~800ms): se espera a que
      // el borrador aparezca en IndexedDB en vez de simular el tiempo.
      await waitFor(
        async () => {
          const drafts = await listDrafts();
          expect(drafts.some((draft) => draft.id === id)).toBe(true);
        },
        { interval: 100 },
      );

      const saved = (await listDrafts()).find((draft) => draft.id === id);
      expect(saved?.signers).toHaveLength(1);
      expect(saved?.step).toBe("signers");

      // Simula una pestaña nueva: se desmonta el componente (los
      // contadores de id de firmante/campo tambien se comparten a nivel
      // de modulo, asi que esto no los reinicia, pero el estado de React
      // si arranca de cero).
      unmount();

      const { container: freshContainer } = render(
        <LanguageProvider>
          <SignToolClient />
        </LanguageProvider>,
      );
      fireEvent.click(
        screen.getByRole("button", { name: strings.draftsButton }),
      );
      fireEvent.click(
        await screen.findByRole("button", { name: strings.draftsResume }),
      );

      await waitFor(() =>
        expect(
          screen.getByRole("button", {
            name: strings.removeSigner(strings.defaultSignerName(1)),
          }),
        ).toBeTruthy(),
      );
      // El archivo quedo cargado sin pasar por el dropzone.
      expect(freshContainer.querySelector('input[type="file"]')).toBeTruthy();
    },
  );

  it("importa una configuracion exportada y carga firmantes/campos sin volver a detectar", async () => {
    const originalFile = await pdfFile("plantilla.pdf");
    const manifest = {
      mode: "multi" as const,
      signers: [{ id: "sg-imported-1", name: "Luis", color: "#0d4bff" }],
      fields: [],
      textFields: [
        {
          id: "txt-imported-1",
          pageIndex: 0,
          rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
          label: "Nombre",
          source: "manual" as const,
          confidence: "high" as const,
        },
      ],
      textValues: { "txt-imported-1": "Luis Gomez" },
    };
    const zipBlob = await exportSignConfig(originalFile, manifest);
    const zipFile = new File([zipBlob], "plantilla-config.zip", {
      type: "application/zip",
    });

    const { container } = render(
      <LanguageProvider>
        <SignToolClient />
      </LanguageProvider>,
    );

    const importInput = container.querySelector(
      'input[type="file"][accept*="zip"]',
    );
    if (!importInput) throw new Error("no se encontro el input de importar");
    fireEvent.change(importInput, { target: { files: [zipFile] } });

    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: strings.removeSigner("Luis"),
        }),
      ).toBeTruthy(),
    );
  });
});

describe("SignToolClient — borrador durante la ventana de 'Deshacer' (limitacion 4.3)", () => {
  async function pdfFile(name: string): Promise<File> {
    const document = await PDFDocument.create();
    // Tamano de pagina distinto al resto de fixtures de este archivo
    // (algunos usan 300x300): `pdf-lib` genera bytes deterministas para
    // una creacion identica, y `documentContentKey` solo mira el
    // contenido -- coincidir de tamano coincidiria de huella tambien, y
    // una escritura tardia de otro describe (una promesa que sigue en
    // vuelo tras desmontar) podria aterrizar en el borrador de este test.
    document.addPage([301, 301]);
    const bytes = await document.save({ useObjectStreams: true });
    return new File([bytes as unknown as BlobPart], name, {
      type: "application/pdf",
    });
  }

  function pdfInput(container: HTMLElement): HTMLInputElement {
    const input = container.querySelector('input[type="file"][accept*="pdf"]');
    if (!input) throw new Error("no se encontro el input de archivo PDF");
    return input as HTMLInputElement;
  }

  beforeEach(async () => {
    await clearAllDrafts();
  });

  /**
   * No hay forma de "recargar la pestaña" de verdad en jsdom: se simula
   * desmontando el componente, que es exactamente lo que dispara la
   * limpieza del autoguardado (SignToolClient.tsx) -- el mismo camino de
   * codigo que corre en un reload real justo antes de que el navegador
   * descarte el arbol de React.
   */
  it(
    "borrar un firmante y desmontar dentro de los 6s de 'Deshacer' persiste el estado limpio, sin el firmante",
    async () => {
      const file = await pdfFile("contrato-4-3.pdf");
      const id = await documentContentKey(file);
      const { container, unmount } = render(
        <LanguageProvider>
          <SignToolClient />
        </LanguageProvider>,
      );

      fireEvent.change(pdfInput(container), { target: { files: [file] } });
      fireEvent.click(
        await screen.findByRole("tab", { name: strings.modeMulti }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: strings.addSigner }),
      );

      const signerName = strings.defaultSignerName(1);
      await waitFor(async () => {
        const drafts = await listDrafts();
        const saved = drafts.find((draft) => draft.id === id);
        expect(saved?.signers).toHaveLength(1);
      });

      // Borra al unico firmante: entra a la ventana de "Deshacer" de 6s.
      fireEvent.click(
        screen.getByRole("button", { name: strings.removeSigner(signerName) }),
      );
      expect(screen.getByText(strings.signerDeletedNotice)).toBeTruthy();

      // "Recarga" (desmontar) muy dentro de la ventana de 6s, sin esperar
      // el debounce de 800ms del autoguardado: la limpieza del efecto la
      // vacia igual con el estado actual (ya sin el firmante -- sin
      // progreso, el borrador entero se borra en vez de quedar a medias,
      // ver el comentario junto al efecto de autoguardado). El propio
      // borrado sigue siendo asincrono (escritura real en IndexedDB), asi
      // que se espera a que aterrice -- igual que el resto de este archivo
      // espera al autoguardado real en vez de simular el tiempo.
      unmount();

      await waitFor(async () => {
        const drafts = await listDrafts();
        expect(drafts.some((draft) => draft.id === id)).toBe(false);
      });
      // Limpio: nada a medias tampoco en la lista completa (ni un
      // borrador huerfano con huecos o capturas sueltas de otro id).
      const remaining = await listDrafts();
      expect(remaining.every((draft) => draft.id !== id)).toBe(true);

      // Reabrir (nueva pestaña / reload real): no hay nada que reanudar,
      // y desde luego no el firmante borrado ni ningun rastro de
      // "Deshacer" -- ese estado era efimero y no se esperaba que
      // sobreviviera.
      render(
        <LanguageProvider>
          <SignToolClient />
        </LanguageProvider>,
      );
      fireEvent.click(
        screen.getByRole("button", { name: strings.draftsButton }),
      );

      expect(
        screen.queryByRole("button", { name: strings.draftsResume }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: strings.removeSigner(signerName) }),
      ).toBeNull();
      expect(screen.queryByText(strings.signerDeletedNotice)).toBeNull();
    },
  );
});

describe("SignToolClient — plantillas de disposicion (Recomendacion #4)", () => {
  async function pdfFile(name: string): Promise<File> {
    const document = await PDFDocument.create();
    document.addPage([300, 300]);
    const bytes = await document.save({ useObjectStreams: true });
    return new File([bytes as unknown as BlobPart], name, {
      type: "application/pdf",
    });
  }

  function pdfInput(container: HTMLElement): HTMLInputElement {
    const input = container.querySelector('input[type="file"][accept*="pdf"]');
    if (!input) throw new Error("no se encontro el input de archivo PDF");
    return input as HTMLInputElement;
  }

  it("guardar como plantilla la deja disponible para aplicar, y aplicar pide confirmacion porque ya hay firmantes", async () => {
    const file = await pdfFile("contrato.pdf");
    const { container } = render(
      <LanguageProvider>
        <SignToolClient />
      </LanguageProvider>,
    );

    fireEvent.change(pdfInput(container), { target: { files: [file] } });
    fireEvent.click(
      await screen.findByRole("tab", { name: strings.modeMulti }),
    );
    fireEvent.click(screen.getByRole("button", { name: strings.addSigner }));

    // Guardar como plantilla.
    fireEvent.click(
      screen.getByRole("button", { name: strings.saveAsTemplateButton }),
    );
    const nameInput = screen.getByLabelText(strings.saveTemplateNameLabel, {
      selector: "input",
    }) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Contrato estandar" } });
    fireEvent.click(
      screen.getByRole("button", { name: strings.saveTemplateConfirm }),
    );
    await waitFor(() =>
      expect(screen.getByText(strings.saveTemplateSuccess)).toBeTruthy(),
    );

    // Aparece en "Plantillas".
    fireEvent.click(
      screen.getByRole("button", { name: strings.templatesButton }),
    );
    await waitFor(() =>
      expect(screen.getByText("Contrato estandar")).toBeTruthy(),
    );

    // Aplicar pide confirmacion: ya hay un firmante cargado.
    fireEvent.click(screen.getByRole("button", { name: strings.templatesApply }));
    expect(screen.getByText(strings.applyTemplateConfirmBody)).toBeTruthy();

    const dialog = screen.getByRole("dialog", {
      name: strings.applyTemplateConfirmTitle,
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: strings.applyTemplateConfirm }),
    );

    // W2-A: aplicar una plantilla deja al usuario en el paso unico "Documento".
    // Se espera a ESTE efecto, que solo depende de promesas (loadPdf + huella,
    // ~2 ms medidos): es la senal determinista de que la aplicacion termino. Antes
    // se esperaba al desmontaje de la hoja, que no es eso (ver abajo).
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: `2. ${strings.stepDocument}` })
          .getAttribute("aria-current"),
      ).toBe("step"),
    );
    // El sheet de plantillas se cierra tras aplicar con exito. La hoja sale con
    // un muelle de tiempo real (`springs.gentle`, ~0,5-0,8 s) y se desmonta en su
    // `onComplete`: con los 1000 ms por defecto de `waitFor` el margen era de
    // centesimas y bajo carga (suite completa + CPU saturada) los fotogramas se
    // retrasan y no llega. El plazo es el de la animacion mas holgura, no una
    // espera a ciegas por el trabajo de `loadPdf`.
    await waitFor(
      () => expect(screen.queryByText(strings.templatesTitle)).toBeNull(),
      { timeout: SHEET_EXIT_TIMEOUT_MS },
    );
  });

  it("con la funcion apagada en Ajustes, no aparecen los botones de plantillas", async () => {
    setSignPdfFeatureFlag("reusableTemplates", false);
    const file = await pdfFile("contrato.pdf");
    const { container } = render(
      <LanguageProvider>
        <SignToolClient />
      </LanguageProvider>,
    );

    fireEvent.change(pdfInput(container), { target: { files: [file] } });
    fireEvent.click(
      await screen.findByRole("tab", { name: strings.modeMulti }),
    );
    fireEvent.click(screen.getByRole("button", { name: strings.addSigner }));

    expect(
      screen.queryByRole("button", { name: strings.templatesButton }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: strings.saveAsTemplateButton }),
    ).toBeNull();
  });
});

describe("MultiFlow — deshacer al borrar un firmante (deferred #1)", () => {
  const LUIS_ID = "sg-luis-undo";

  function twoSignerOptions(): SignToolOptions {
    const ana: Signer = { ...ANA, color: signerColorAt(0) };
    const luis: Signer = { id: LUIS_ID, name: "Luis", color: signerColorAt(1) };
    const fieldAna: SignatureField = {
      id: "f-ana-undo",
      signerId: ana.id,
      pageIndex: 0,
      type: "signature",
      rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
    };
    const fieldLuis: SignatureField = {
      id: "f-luis-undo",
      signerId: luis.id,
      pageIndex: 0,
      type: "signature",
      rect: { x: 0.1, y: 0.3, width: 0.3, height: 0.1 },
    };
    const captures: CaptureMap = {
      [ana.id]: {
        signature: { dataUrl: "data:image/png;base64,iVBORw0KGgo=", ratio: 0.3 },
        initials: null,
        stamp: captureStamp(CLAVE_PRIMERO, [fieldAna], ana.id),
      },
      [luis.id]: {
        signature: { dataUrl: "data:image/png;base64,iVBORw0KGgo=", ratio: 0.3 },
        initials: null,
        stamp: captureStamp(CLAVE_PRIMERO, [fieldLuis], luis.id),
      },
    };
    return {
      ...optionsFor(CLAVE_PRIMERO),
      step: "signers",
      signers: [ana, luis],
      fields: [fieldAna, fieldLuis],
      captures,
      activeSignerId: luis.id,
    };
  }

  it("borrar a un firmante muestra 'Deshacer' y se lleva sus huecos y su captura", async () => {
    let last: SignToolOptions = twoSignerOptions();
    render(
      <Harness
        file={PRIMERO}
        initialOptions={twoSignerOptions()}
        onOptions={(options) => (last = options)}
      />,
    );
    await settled();

    fireEvent.click(screen.getByRole("button", { name: strings.removeSigner("Luis") }));

    expect(last.signers).toHaveLength(1);
    expect(last.signers[0].id).toBe(ANA.id);
    expect(last.fields).toHaveLength(1);
    expect(last.fields[0].signerId).toBe(ANA.id);
    expect(last.captures[LUIS_ID]).toBeUndefined();
    expect(screen.getByText(strings.signerDeletedNotice)).toBeTruthy();
  });

  it("'Deshacer' repone al firmante, sus huecos, su captura y el color de todos, exactamente como antes", async () => {
    let last: SignToolOptions = twoSignerOptions();
    render(
      <Harness
        file={PRIMERO}
        initialOptions={twoSignerOptions()}
        onOptions={(options) => (last = options)}
      />,
    );
    await settled();

    fireEvent.click(screen.getByRole("button", { name: strings.removeSigner("Luis") }));
    expect(last.signers).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("button", { name: strings.undoRemoveSigner }),
    );

    expect(last.signers).toHaveLength(2);
    expect(last.signers.map((s) => s.id)).toEqual([ANA.id, LUIS_ID]);
    // Colores recalculados por posicion para TODOS, no solo el repuesto.
    expect(last.signers[0].color).toBe(signerColorAt(0));
    expect(last.signers[1].color).toBe(signerColorAt(1));
    expect(last.fields).toHaveLength(2);
    expect(last.fields.some((f) => f.id === "f-luis-undo")).toBe(true);
    // La captura vuelve intacta: mismo id/rect de hueco, mismo stamp ->
    // sigue validando sin pedirle a Luis que vuelva a firmar.
    expect(last.captures[LUIS_ID]).toBeDefined();
    expect(last.captures[LUIS_ID].stamp).toBe(
      captureStamp(CLAVE_PRIMERO, [last.fields.find((f) => f.id === "f-luis-undo")!], LUIS_ID),
    );
    // Luis estaba activo antes de borrarlo: al deshacer, vuelve a estarlo.
    expect(last.activeSignerId).toBe(LUIS_ID);
    expect(screen.queryByText(strings.signerDeletedNotice)).toBeNull();
  });

  it("renombrar a un firmante NO activa ningun 'Deshacer' (mismo callback que borrar)", async () => {
    render(
      <Harness
        file={PRIMERO}
        initialOptions={twoSignerOptions()}
        onOptions={() => {}}
      />,
    );
    await settled();

    fireEvent.change(screen.getByDisplayValue("Luis"), {
      target: { value: "Luisa" },
    });

    expect(screen.queryByText(strings.signerDeletedNotice)).toBeNull();
  });

  it("con la funcion apagada, borrar un firmante no muestra ningun aviso (comportamiento previo)", async () => {
    setSignPdfFeatureFlag("undoDelete", false);
    let last: SignToolOptions = twoSignerOptions();
    render(
      <Harness
        file={PRIMERO}
        initialOptions={twoSignerOptions()}
        onOptions={(options) => (last = options)}
      />,
    );
    await settled();

    fireEvent.click(screen.getByRole("button", { name: strings.removeSigner("Luis") }));

    expect(last.signers).toHaveLength(1);
    expect(screen.queryByText(strings.signerDeletedNotice)).toBeNull();
  });

  it("borrar un segundo firmante reemplaza el 'Deshacer' pendiente: el primero ya quedo en firme", async () => {
    const ana: Signer = { ...ANA, color: signerColorAt(0) };
    const luis: Signer = { id: LUIS_ID, name: "Luis", color: signerColorAt(1) };
    const marta: Signer = { id: "sg-marta-undo", name: "Marta", color: signerColorAt(2) };
    const options: SignToolOptions = {
      ...optionsFor(CLAVE_PRIMERO),
      step: "signers",
      signers: [ana, luis, marta],
      fields: [],
      captures: {},
      activeSignerId: null,
    };
    let last: SignToolOptions = options;
    render(
      <Harness
        file={PRIMERO}
        initialOptions={options}
        onOptions={(o) => (last = o)}
      />,
    );
    await settled();

    fireEvent.click(screen.getByRole("button", { name: strings.removeSigner("Luis") }));
    fireEvent.click(screen.getByRole("button", { name: strings.removeSigner("Marta") }));

    fireEvent.click(
      screen.getByRole("button", { name: strings.undoRemoveSigner }),
    );

    // Solo Marta (la ultima borrada) vuelve; Luis ya quedo en firme.
    expect(last.signers.map((s) => s.name)).toEqual(["Ana", "Marta"]);
  });

  it("si tras borrar se da de alta OTRO firmante, 'Deshacer' ya no cabe (MAX_SIGNERS): no deja 3 y lo dice con amabilidad", async () => {
    let last: SignToolOptions = twoSignerOptions();
    render(
      <Harness
        file={PRIMERO}
        initialOptions={twoSignerOptions()}
        onOptions={(options) => (last = options)}
      />,
    );
    await settled();

    fireEvent.click(screen.getByRole("button", { name: strings.removeSigner("Luis") }));
    expect(screen.getByRole("button", { name: strings.undoRemoveSigner })).toBeTruthy();

    // Se da de alta otro firmante: la ronda vuelve a tener 2.
    fireEvent.click(screen.getByRole("button", { name: strings.addSigner }));
    expect(last.signers).toHaveLength(2);

    expect(screen.queryByRole("button", { name: strings.undoRemoveSigner })).toBeNull();
    expect(screen.getByText(strings.undoRemoveSignerUnavailable)).toBeTruthy();
    expect(last.signers).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * La huella del archivo llega DESPUES del trabajo de la persona
 * ------------------------------------------------------------------ *
 * La huella (`useDocumentKey`) se calcula en segundo plano: con un PDF
 * grande tarda, y una persona rapida ya ha creado firmante, hueco y campo
 * cuando llega. Lo que cambia con el archivo (reinicio) es el ARCHIVO, no la
 * llegada de su huella: esta solo SELLA el trabajo (W1-D).
 *
 * Para que la llegada sea determinista (sin temporizadores), `crypto.subtle.
 * digest` espera una puerta por contenido hasta que la prueba la abre.
 */
describe("MultiFlow — la huella llega despues del trabajo de la persona", () => {
  type Gate = { bytes: Uint8Array; open: () => void; opened: Promise<void> };
  const gates: Gate[] = [];
  let digestSpy: ReturnType<typeof vi.spyOn> | null = null;

  const viewOf = (data: BufferSource): Uint8Array =>
    ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
  const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index]);

  beforeEach(() => {
    const subtle = globalThis.crypto.subtle;
    const original = subtle.digest.bind(subtle);
    digestSpy = vi
      .spyOn(subtle, "digest")
      .mockImplementation((async (
        algorithm: AlgorithmIdentifier,
        data: BufferSource,
      ) => {
        const view = viewOf(data);
        const gate = gates.find((candidate) => sameBytes(candidate.bytes, view));
        if (gate) await gate.opened;
        return original(algorithm, data);
      }) as typeof subtle.digest);
  });

  afterEach(() => {
    digestSpy?.mockRestore();
    digestSpy = null;
    gates.length = 0;
  });

  /** Archivo nuevo en cada prueba: la huella calculada se cachea por objeto `File`. */
  function freshFile(name: string, seed: number): File {
    return new File([new Uint8Array([seed, seed + 1, seed + 2, seed + 3])], name, {
      type: "application/pdf",
      lastModified: 1_700_000_000_000 + seed,
    });
  }

  /** Cierra la puerta de la huella de `file`; devuelve su huella real y como abrirla. */
  async function holdHash(file: File): Promise<{ key: string; release: () => void }> {
    const key = await documentContentKey(file); // antes de registrar la puerta
    const bytes = new Uint8Array(await file.arrayBuffer());
    let open: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    gates.push({ bytes, open, opened });
    return { key, release: open };
  }

  /** Documento nuevo, sin sellar: lo que hay en `ToolShell` al cargar el primer archivo. */
  function unsealedOptions(): SignToolOptions {
    return {
      ...optionsFor(""),
      step: "signers",
      signers: [],
      fields: [],
      captures: {},
      activeSignerId: null,
    };
  }

  /** Sellado con la huella de `key` y con trabajo hecho (firmante, hueco y trazo vigente). */
  function sealedOptions(key: string, step: SignToolOptions["step"]): SignToolOptions {
    return { ...optionsFor(key), step };
  }

  /** Como `Harness`, pero el padre puede cambiar archivo Y opciones a la vez (`ToolShell.loadWith`). */
  function LoadHarness({
    initialFile,
    initialOptions,
    loadRef,
    onOptions,
  }: {
    initialFile: File;
    initialOptions: SignToolOptions;
    loadRef: MutableRefObject<
      ((file: File, options: SignToolOptions) => void) | null
    >;
    onOptions: (options: SignToolOptions) => void;
  }) {
    const [file, setFile] = useState<File>(initialFile);
    const [options, setOptions] = useState<SignToolOptions>(initialOptions);
    onOptions(options);
    useEffect(() => {
      loadRef.current = (nextFile, nextOptions) => {
        setFile(nextFile);
        setOptions(nextOptions);
      };
      return () => {
        loadRef.current = null;
      };
    }, [loadRef]);
    const patchOptions = useCallback(
      (patch: Partial<SignToolOptions>) =>
        setOptions((previous) => ({ ...previous, ...patch })),
      [],
    );
    return (
      <MultiFlow
        file={file}
        options={options}
        setOptions={patchOptions}
        onFinish={() => {}}
        strings={strings}
      />
    );
  }

  const stepButton = (n: number, label: string) =>
    screen.getByRole("button", { name: `${n}. ${label}` });

  it("conserva firmante, hueco y campo creados antes de que llegue la huella, y la sella al llegar", async () => {
    const file = freshFile("contrato.pdf", 11);
    const hold = await holdHash(file);
    let last: SignToolOptions = unsealedOptions();
    render(
      <Harness
        file={file}
        initialOptions={unsealedOptions()}
        onOptions={(options) => (last = options)}
      />,
    );

    // La persona avanza sin esperar: firmante -> hueco -> campo de texto
    // (ambos sobre el mismo lienzo del paso Documento).
    fireEvent.click(screen.getByRole("button", { name: strings.addSigner }));
    expect(last.signers).toHaveLength(1);
    fireEvent.click(stepButton(2, strings.stepDocument));
    addSlotHere();
    expect(last.fields).toHaveLength(1);
    addTextFieldHere();
    await waitFor(() => expect(last.textFields).toHaveLength(1));
    fireEvent.change(
      screen.getByRole("textbox", { name: strings.textFieldFallbackLabel(1) }),
      { target: { value: "Ana Perez" } },
    );
    expect(last.signature).toBe(""); // la huella sigue sin llegar

    hold.release();
    await waitFor(() => expect(last.signature).toBe(hold.key));
    // La deteccion (que arranca al sellar) tambien termina sin pisar lo hecho.
    await waitFor(() => expect(last.textFieldsDetectedFor).toBe(hold.key));

    expect(last.signers).toHaveLength(1);
    expect(last.fields).toHaveLength(1);
    expect(last.textFields).toHaveLength(1);
    expect(Object.values(last.textValues)).toEqual(["Ana Perez"]);
    expect(last.step).toBe("document");
  });

  it("sin huella la ronda de firma espera (no firma ni pierde el trabajo) y se abre al llegar", async () => {
    const file = freshFile("contrato.pdf", 12);
    const hold = await holdHash(file);
    let last: SignToolOptions = unsealedOptions();
    render(
      <Harness
        file={file}
        initialOptions={unsealedOptions()}
        onOptions={(options) => (last = options)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: strings.addSigner }));
    fireEvent.click(stepButton(2, strings.stepDocument));
    addSlotHere();
    expect(last.fields).toHaveLength(1);
    fireEvent.click(stepButton(3, strings.stepSign));

    // Estado de espera: ni turno de firma ni boton para empezar a firmar.
    expect(screen.getByText(strings.checkingDocument)).toBeTruthy();
    expect(
      screen.queryAllByRole("button", { name: strings.handoffReady }),
    ).toHaveLength(0);
    expect(last.signature).toBe("");

    hold.release();
    await waitFor(() => expect(last.signature).toBe(hold.key));
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: strings.handoffReady }).length,
      ).toBeGreaterThan(0),
    );
    expect(last.fields).toHaveLength(1);
    expect(last.step).toBe("sign");
  });

  it("sin sellar (\"\") ninguna captura vale, ni siquiera la de sello coherente: la ronda no se da por firmada", () => {
    const captures = optionsFor("").captures; // sello calculado con la huella ""
    expect(captures[ANA.id]?.stamp).toBe(captureStamp("", FIELDS, ANA.id));
    expect(validCapture(captures, FIELDS, ANA.id, "").signature).toBeNull();
    expect(pendingSigners([ANA], FIELDS, captures, "").map((s) => s.id)).toEqual([
      ANA.id,
    ]);
    // Con la huella de verdad, la misma captura (sellada con ella) si vale.
    const sealed = optionsFor(CLAVE_PRIMERO).captures;
    expect(validCapture(sealed, FIELDS, ANA.id, CLAVE_PRIMERO).signature).not.toBeNull();
    expect(pendingSigners([ANA], FIELDS, sealed, CLAVE_PRIMERO)).toEqual([]);
  });

  it("al cambiar de archivo limpia AL INSTANTE lo del anterior, conserva a los firmantes y respeta lo que se haga en el nuevo antes de que llegue su huella", async () => {
    const fileA = freshFile("a.pdf", 21);
    const fileB = freshFile("b.pdf", 31);
    const keyA = await documentContentKey(fileA);
    const holdB = await holdHash(fileB);

    let last: SignToolOptions = sealedOptions(keyA, "document");
    const { rerender } = render(
      <Harness
        file={fileA}
        initialOptions={sealedOptions(keyA, "document")}
        onOptions={(options) => (last = options)}
      />,
    );
    expect(last.fields).toHaveLength(1);

    rerender(
      <Harness
        file={fileB}
        initialOptions={sealedOptions(keyA, "document")}
        onOptions={(options) => (last = options)}
      />,
    );

    // La huella de B sigue sin llegar y lo de A ya no esta (ni sellado):
    // se limpia en el acto, sin esperar nada (ni siquiera un `waitFor`).
    expect(last.fields).toEqual([]);
    expect(last.signature).toBe("");
    expect(last.captures).toEqual({});
    expect(last.selectedFieldId).toBeNull();
    expect(last.step).toBe("signers");
    expect(last.signers.map((signer) => signer.id)).toEqual([ANA.id]);

    // Trabajo en B antes de que llegue su huella...
    fireEvent.click(stepButton(2, strings.stepDocument));
    addSlotHere();
    expect(last.fields).toHaveLength(1);
    expect(last.signature).toBe("");

    // ...se conserva al llegar: la huella solo sella.
    holdB.release();
    await waitFor(() => expect(last.signature).toBe(holdB.key));
    await waitFor(() => expect(last.textFieldsDetectedFor).toBe(holdB.key));
    expect(last.fields).toHaveLength(1);
    expect(last.step).toBe("document");
    expect(last.signers.map((signer) => signer.id)).toEqual([ANA.id]);
  });

  it("un borrador restaurado (ya sellado con su huella) no se borra ni se reinicia al llegar la huella, y lo hecho mientras llegaba se conserva", async () => {
    const file = freshFile("borrador.pdf", 41);
    const hold = await holdHash(file);
    let last: SignToolOptions = sealedOptions(hold.key, "sign");
    render(
      <Harness
        file={file}
        initialOptions={sealedOptions(hold.key, "sign")}
        onOptions={(options) => (last = options)}
      />,
    );
    expect(last.captures[ANA.id]?.signature).not.toBeNull();

    // Mientras llega la huella la persona sigue trabajando sobre el borrador.
    fireEvent.click(stepButton(1, strings.stepSigners));
    fireEvent.click(screen.getByRole("button", { name: strings.addSigner }));
    expect(last.signers).toHaveLength(2);

    hold.release();
    await waitFor(() => expect(last.textFieldsDetectedFor).toBe(hold.key));

    expect(last.signature).toBe(hold.key);
    expect(last.signers).toHaveLength(2);
    expect(last.fields).toHaveLength(1);
    expect(last.captures[ANA.id]?.signature).not.toBeNull();
    expect(last.step).toBe("signers");
  });

  it("la deteccion que termina despues no pisa los campos de texto restaurados o anadidos a mano: se suman a ellos", async () => {
    const detected: DetectedField = {
      id: "d1",
      pageIndex: 0,
      rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
      label: "Nombre",
      source: "acroform",
      confidence: "high",
    };
    vi.mocked(detectFields).mockResolvedValue([detected]);
    const manual: DetectedField = {
      id: "m1",
      pageIndex: 0,
      rect: { x: 0.2, y: 0.5, width: 0.3, height: 0.05 },
      label: "Anotacion",
      source: "manual",
      confidence: "high",
    };

    const file = freshFile("borrador-texto.pdf", 51);
    const key = await documentContentKey(file);
    // Borrador guardado ANTES de que terminara la deteccion: lleva su campo
    // manual y `textFieldsDetectedFor` aun a null.
    const restored: SignToolOptions = {
      ...sealedOptions(key, "document"),
      signers: [],
      fields: [],
      captures: {},
      textFields: [manual],
      textValues: { m1: "dato" },
      textFieldsDetectedFor: null,
    };
    let last: SignToolOptions = restored;
    render(
      <Harness
        file={file}
        initialOptions={restored}
        onOptions={(options) => (last = options)}
      />,
    );

    await waitFor(() => expect(last.textFieldsDetectedFor).toBe(key));
    expect(last.textFields.map((field) => field.id).sort()).toEqual(["d1", "m1"]);
    expect(last.textValues).toEqual({ m1: "dato" });
  });

  it("la deteccion arranca ya sellada: al volver a un archivo ya conocido no arrastra los campos del anterior", async () => {
    const fileA = freshFile("a.pdf", 111);
    const fileB = freshFile("b.pdf", 121);
    const keyA = await documentContentKey(fileA);
    const keyB = await documentContentKey(fileB);
    const detectedA: DetectedField = {
      id: "dA",
      pageIndex: 0,
      rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
      label: "Campo de A",
      source: "acroform",
      confidence: "high",
    };
    vi.mocked(detectFields).mockImplementation(async (target) =>
      target === fileA ? [detectedA] : [],
    );

    let last: SignToolOptions = unsealedOptions();
    const view = (file: File) => (
      <Harness
        file={file}
        initialOptions={unsealedOptions()}
        onOptions={(options) => (last = options)}
      />
    );
    const { rerender } = render(view(fileA));
    await waitFor(() => expect(last.textFieldsDetectedFor).toBe(keyA));
    expect(last.textFields.map((field) => field.id)).toEqual(["dA"]);

    // En B la persona anade un campo a mano.
    rerender(view(fileB));
    await waitFor(() => expect(last.textFieldsDetectedFor).toBe(keyB));
    fireEvent.click(textStepButton());
    addTextFieldHere();
    await waitFor(() => expect(last.textFields).toHaveLength(1));
    const manualId = last.textFields[0].id;

    // Vuelve a A: su huella ya esta calculada (llega en el mismo render).
    rerender(view(fileA));
    await waitFor(() => expect(last.textFieldsDetectedFor).toBe(keyA));
    expect(last.textFields.map((field) => field.id)).toEqual(["dA"]);
    expect(last.textFields.some((field) => field.id === manualId)).toBe(false);
    expect(last.signature).toBe(keyA);
  });

  it("un cambio externo a OTRA huella no vacia sigue reiniciando la ronda (no se mezclan documentos)", async () => {
    const file = freshFile("otro.pdf", 61);
    const hold = await holdHash(file);
    // El estado sellado pertenece a otro documento (CLAVE_SEGUNDO), p. ej. una
    // configuracion o un borrador restaurado para otro archivo.
    let last: SignToolOptions = sealedOptions(CLAVE_SEGUNDO, "sign");
    render(
      <Harness
        file={file}
        initialOptions={sealedOptions(CLAVE_SEGUNDO, "sign")}
        onOptions={(options) => (last = options)}
      />,
    );

    hold.release();
    await waitFor(() => expect(last.signature).toBe(hold.key));

    expect(last.fields).toEqual([]);
    expect(last.captures).toEqual({});
    expect(last.step).toBe("signers");
    expect(last.signers.map((signer) => signer.id)).toEqual([ANA.id]);
  });

  it("una carga externa que trae archivo Y opciones a la vez (reanudar un borrador con otro archivo abierto) conserva lo restaurado", async () => {
    const fileA = freshFile("abierto.pdf", 71);
    const fileB = freshFile("borrador-b.pdf", 81);
    const keyA = await documentContentKey(fileA);
    const holdB = await holdHash(fileB);

    // Igual que `ToolShell.loadWith`: archivo y opciones cambian en el mismo render.
    const loadRef: MutableRefObject<
      ((file: File, options: SignToolOptions) => void) | null
    > = { current: null };
    let last: SignToolOptions = sealedOptions(keyA, "document");

    render(
      <LoadHarness
        initialFile={fileA}
        initialOptions={sealedOptions(keyA, "document")}
        loadRef={loadRef}
        onOptions={(options) => (last = options)}
      />,
    );
    expect(last.fields).toHaveLength(1);

    const luis: Signer = { id: "sg-luis", name: "Luis", color: "#0d4bff" };
    const restored: SignToolOptions = {
      ...sealedOptions(holdB.key, "sign"),
      signers: [luis],
      fields: [{ ...FIELDS[0], id: "f-luis", signerId: luis.id }],
      captures: {},
      textFieldsDetectedFor: holdB.key,
    };
    act(() => loadRef.current?.(fileB, restored));

    // Nada se limpia: el estado restaurado describe el archivo nuevo.
    expect(last.signers.map((signer) => signer.id)).toEqual(["sg-luis"]);
    expect(last.fields.map((field) => field.id)).toEqual(["f-luis"]);
    expect(last.signature).toBe(holdB.key);
    expect(last.step).toBe("sign");
    expect(screen.getByText(strings.checkingDocument)).toBeTruthy();

    // Al llegar la huella de B la ronda se abre sobre lo restaurado.
    holdB.release();
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: strings.handoffReady }).length,
      ).toBeGreaterThan(0),
    );
    expect(last.signers.map((signer) => signer.id)).toEqual(["sg-luis"]);
    expect(last.fields.map((field) => field.id)).toEqual(["f-luis"]);
    expect(last.signature).toBe(holdB.key);
    expect(last.step).toBe("sign");
  });
});

/* ------------------------------------------------------------------ *
 * W2-A: migracion de pasos ("fields"/"text" -> "document") y paso
 * Documento con lienzo unificado, sin formulario inferior.
 * ------------------------------------------------------------------ */
describe("SignToolClient — migracion de pasos a 'document' (W2-A)", () => {
  async function pdfFile(name: string): Promise<File> {
    const document = await PDFDocument.create();
    // Tamano propio (ver el resto de describes): la huella es el contenido.
    document.addPage([320, 320]);
    const bytes = await document.save({ useObjectStreams: true });
    return new File([bytes as unknown as BlobPart], name, {
      type: "application/pdf",
    });
  }

  function pdfInput(container: HTMLElement): HTMLInputElement {
    const input = container.querySelector('input[type="file"][accept*="pdf"]');
    if (!input) throw new Error("no se encontro el input de archivo PDF");
    return input as HTMLInputElement;
  }

  /**
   * Escribe un borrador tal como lo dejaba la version ANTERIOR a W2-A
   * (paso "fields" o "text"), directamente en IndexedDB -- `saveDraft`
   * ya no admite esos pasos, y lo que se prueba es justo leer lo viejo.
   */
  async function writeLegacyDraft(
    id: string,
    file: File,
    meta: Record<string, unknown>,
  ): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      // Sin numero de version: la base ya esta en v2 (la abrio `clearAllDrafts`) y
      // pedir la 1 daria VersionError; las filas v1 viven en los mismos almacenes.
      const request = indexedDB.open("optimuspdf-sign-drafts");
      request.onupgradeneeded = () => {
        const upgraded = request.result;
        if (!upgraded.objectStoreNames.contains("draftFiles")) {
          upgraded.createObjectStore("draftFiles", { keyPath: "id" });
        }
        if (!upgraded.objectStoreNames.contains("draftMeta")) {
          upgraded.createObjectStore("draftMeta", { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["draftFiles", "draftMeta"], "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore("draftFiles").put({ id, bytes });
      tx.objectStore("draftMeta").put({
        id,
        fileName: file.name,
        fileSize: bytes.byteLength,
        savedAt: new Date().toISOString(),
        mode: "multi",
        captures: {},
        textFieldsDetectedFor: id,
        ...meta,
      });
    });
    db.close();
  }

  const documentStep = () =>
    screen.getByRole("button", { name: `2. ${strings.stepDocument}` });

  beforeEach(async () => {
    await clearAllDrafts();
  });

  it("migrateStep: los pasos antiguos caen en 'document', los vigentes no cambian y lo desconocido vuelve al principio", () => {
    expect(migrateStep("fields")).toBe("document");
    expect(migrateStep("text")).toBe("document");
    expect(migrateStep("signers")).toBe("signers");
    expect(migrateStep("document")).toBe("document");
    expect(migrateStep("sign")).toBe("sign");
    expect(migrateStep("algo-raro")).toBe("signers");
    expect(migrateStep(undefined)).toBe("signers");
  });

  it(
    "un borrador guardado con step 'text' (version anterior) se reanuda en 'Documento' con sus campos y valores intactos",
    async () => {
      const file = await pdfFile("legado-texto.pdf");
      const id = await documentContentKey(file);
      await writeLegacyDraft(id, file, {
        step: "text",
        signers: [],
        fields: [],
        textFields: [
          {
            id: "txt-legacy-1",
            pageIndex: 0,
            rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
            label: "Nombre",
            source: "manual",
            confidence: "high",
          },
        ],
        textValues: { "txt-legacy-1": "Ana Perez" },
      });

      render(
        <LanguageProvider>
          <SignToolClient />
        </LanguageProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: strings.draftsButton }));
      fireEvent.click(await screen.findByRole("button", { name: strings.draftsResume }));

      // Aterriza en el paso Documento (ya no existe "Texto")...
      await waitFor(() =>
        expect(documentStep().getAttribute("aria-current")).toBe("step"),
      );
      // ...con el campo restaurado sobre el lienzo, relleno con su valor.
      expect(
        screen.getByRole("group", { name: `Nombre, ${strings.a11yFilled}` }),
      ).toBeTruthy();
      expect(screen.getByText("Ana Perez")).toBeTruthy();
      // Y sin ningun formulario ni lista de campos fuera del lienzo.
      expect(screen.queryByRole("button", { name: "Nombre" })).toBeNull();
      expect(document.querySelector("form")).toBeNull();
    },
  );

  it(
    "un borrador guardado con step 'fields' (version anterior) se reanuda en 'Documento' con su firmante y su hueco",
    async () => {
      const file = await pdfFile("legado-huecos.pdf");
      const id = await documentContentKey(file);
      await writeLegacyDraft(id, file, {
        step: "fields",
        signers: [{ id: "sg-legacy-1", name: "Luis", color: signerColorAt(0) }],
        fields: [
          {
            id: "fld-legacy-1",
            signerId: "sg-legacy-1",
            pageIndex: 0,
            type: "signature",
            rect: { x: 0.2, y: 0.6, width: 0.3, height: 0.1 },
          },
        ],
        textFields: [],
        textValues: {},
      });

      render(
        <LanguageProvider>
          <SignToolClient />
        </LanguageProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: strings.draftsButton }));
      fireEvent.click(await screen.findByRole("button", { name: strings.draftsResume }));

      await waitFor(() =>
        expect(documentStep().getAttribute("aria-current")).toBe("step"),
      );
      expect(
        screen.getByRole("group", {
          name: `${strings.fieldOwnerLabel("Luis", strings.fieldSignature)}, ${strings.a11ySlot}`,
        }),
      ).toBeTruthy();
      // Con firmantes, la herramienta por defecto es Seleccionar (W2-B).
      expect(
        within(screen.getByRole("toolbar", { name: strings.paletteLabel }))
          .getByRole("button", { name: strings.toolSelect })
          .getAttribute("aria-pressed"),
      ).toBe("true");
    },
  );

  it(
    "el autoguardado persiste el paso nuevo ('document'), nunca los antiguos",
    async () => {
      const file = await pdfFile("autoguardado-w2a.pdf");
      const id = await documentContentKey(file);
      const { container } = render(
        <LanguageProvider>
          <SignToolClient />
        </LanguageProvider>,
      );

      fireEvent.change(pdfInput(container), { target: { files: [file] } });
      fireEvent.click(await screen.findByRole("tab", { name: strings.modeMulti }));
      fireEvent.click(screen.getByRole("button", { name: strings.addSigner }));
      fireEvent.click(documentStep());

      await waitFor(
        async () => {
          const saved = (await listDrafts()).find((draft) => draft.id === id);
          expect(saved?.step).toBe("document");
        },
        { interval: 100 },
      );
    },
  );

  it("una configuracion importada muestra sus campos y valores en el lienzo del paso Documento", async () => {
    const originalFile = await pdfFile("importada.pdf");
    const manifest = {
      mode: "multi" as const,
      signers: [{ id: "sg-imp-w2a", name: "Luis", color: "#0d4bff" }],
      fields: [
        {
          id: "fld-imp-w2a",
          signerId: "sg-imp-w2a",
          pageIndex: 0,
          type: "signature" as const,
          rect: { x: 0.2, y: 0.6, width: 0.3, height: 0.1 },
        },
      ],
      textFields: [
        {
          id: "txt-imp-w2a",
          pageIndex: 0,
          rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
          label: "Nombre",
          source: "manual" as const,
          confidence: "high" as const,
        },
      ],
      textValues: { "txt-imp-w2a": "Luis Gomez" },
    };
    const zipBlob = await exportSignConfig(originalFile, manifest);
    const zipFile = new File([zipBlob], "importada-config.zip", { type: "application/zip" });

    const { container } = render(
      <LanguageProvider>
        <SignToolClient />
      </LanguageProvider>,
    );
    const importInput = container.querySelector('input[type="file"][accept*="zip"]');
    if (!importInput) throw new Error("no se encontro el input de importar");
    fireEvent.change(importInput, { target: { files: [zipFile] } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: strings.removeSigner("Luis") })).toBeTruthy(),
    );

    fireEvent.click(documentStep());
    expect(
      screen.getByRole("group", { name: `Nombre, ${strings.a11yFilled}` }),
    ).toBeTruthy();
    expect(screen.getByText("Luis Gomez")).toBeTruthy();
    expect(
      screen.getByRole("group", {
        name: `${strings.fieldOwnerLabel("Luis", strings.fieldSignature)}, ${strings.a11ySlot}`,
      }),
    ).toBeTruthy();
  });

  it("el aviso de campos pendientes vive en linea en el paso Documento, no en un panel inferior", async () => {
    let last: SignToolOptions = freshTextOnlyOptions();
    render(
      <Harness
        file={PRIMERO}
        initialOptions={freshTextOnlyOptions()}
        onOptions={(options) => (last = options)}
      />,
    );
    await settled();
    fireEvent.click(textStepButton());
    // La region de estado ya esta montada ANTES de que aparezca el aviso
    // (un `role="status"` que nace con su texto no se anuncia de forma fiable).
    const regionsBefore = screen.getAllByRole("status");
    addTextFieldHere();
    await waitFor(() => expect(last.textFields).toHaveLength(1));
    fireEvent.blur(screen.getByRole("textbox", { name: strings.textFieldFallbackLabel(1) }));

    // Un campo anadido a mano no es "detectado": el resumen de deteccion no lo cuenta.
    expect(screen.queryByText(strings.detectedFieldsSummary(1))).toBeNull();

    const notice = screen.getByText(strings.pendingTextFieldsWarning(1));
    const region = notice.closest('[role="status"]');
    expect(region).not.toBeNull();
    expect(regionsBefore).toContain(region);
    // Ni lista de campos ni formulario: el unico contenido sobre campos es el lienzo.
    expect(document.querySelector("form")).toBeNull();
    expect(
      screen.queryByRole("button", { name: strings.textFieldFallbackLabel(1) }),
    ).toBeNull();
  });
});
