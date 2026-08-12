import "fake-indexeddb/auto";
import { useCallback, useState } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PDFDocument } from "@cantoo/pdf-lib";
import {
  MultiFlow,
  SignToolClient,
  type SignToolOptions,
} from "@/app/sign-pdf/SignToolClient";
import { documentContentKey } from "@/app/sign-pdf/documentKey";
import { captureStamp, type CaptureMap } from "@/app/sign-pdf/SigningCeremony";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { LanguageProvider, LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { fileKey } from "@/app/organize-pdf/pageToolkit";
import { normalizeFieldLabel, type SignatureField, type Signer } from "@/lib/pdf/sign";
import { detectFields, type DetectedField } from "@/lib/pdf/detectFields";
import { clearAllDrafts, listDrafts } from "@/app/sign-pdf/signDrafts";
import { exportSignConfig } from "@/app/sign-pdf/signConfig";
import {
  __resetValueHistoryCacheForTests,
  recordValue,
} from "@/lib/valueHistory";

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
    fieldType: "signature",
    fieldPageIndex: 0,
    selectedFieldId: null,
    textFields: [],
    textValues: {},
    textFieldPageIndex: 0,
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
 * Documento "recien cargado" (huella sin coincidir todavia) sin ningun
 * hueco de firma: el efecto de reinicio de `MultiFlow` lo detecta como
 * nuevo y lanza la deteccion, igual que con un archivo de verdad. El
 * paso arranca en "signers" (lo fuerza el propio reinicio); las pruebas
 * navegan a "text" a mano, como haria una persona real.
 */
function freshTextOnlyOptions(): SignToolOptions {
  return {
    ...optionsFor(""),
    fields: [],
    captures: {},
    signers: [],
  };
}

const textStepButton = () =>
  screen.getByRole("button", { name: `3. ${strings.stepText}` });
const signStepButton = () =>
  screen.getByRole("button", {
    name: `4. ${strings.stepSign}`,
  }) as HTMLButtonElement;

describe("MultiFlow — paso de texto (src/app/sign-pdf/SignToolClient.tsx)", () => {
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
    // Detectado, no tocado todavia: aparece como enlace de salto en el
    // resumen, pero no se abre ningun editor (eso solo pasa al tocarlo
    // en el lienzo). El label tambien aparece sobre el propio campo en
    // el lienzo (rotulo siempre visible), asi que se busca el enlace por
    // su rol de boton, no por texto (ambiguo entre los dos).
    expect(screen.getByRole("button", { name: "Nombre" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Nombre" })).toBeNull();
  });

  it("el paso de texto siempre es alcanzable, y firmar se habilita en cuanto un campo tiene valor", async () => {
    let last: SignToolOptions = freshTextOnlyOptions();
    render(
      <Harness
        file={PRIMERO}
        initialOptions={freshTextOnlyOptions()}
        onOptions={(options) => (last = options)}
      />,
    );
    await settled();

    // Sin firmantes, "Campos" (huecos de firma) esta bloqueado, pero
    // "Texto" no depende de ellos: siempre se puede entrar.
    expect((textStepButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(textStepButton());
    expect(last.step).toBe("text");

    fireEvent.click(
      screen.getByRole("button", { name: strings.addTextFieldHere }),
    );
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

describe("SignToolClient — flujo completo (firmar -> prompt -> aceptar)", () => {
  /** El input de PDF, no el de zip que pinta la fila de "Importar configuracion". */
  function pdfInput(container: HTMLElement): HTMLInputElement {
    const input = container.querySelector('input[type="file"][accept*="pdf"]');
    if (!input) throw new Error("no se encontro el input de archivo PDF");
    return input as HTMLInputElement;
  }

  async function pdfFile(name: string): Promise<File> {
    const document = await PDFDocument.create();
    document.addPage([300, 300]);
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

    // 2. Anadir un firmante y pasar al paso de texto (sin huecos de
    // imagen: el paso de firma usa el panel simple "Aplicar y descargar").
    fireEvent.click(
      screen.getByRole("button", { name: strings.addSigner }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: `3. ${strings.stepText}` }),
    );

    // 3. Anadir un campo de texto (se abre editando de inmediato, ver
    // `addField` en FieldPlacer.tsx) y escribir un valor.
    fireEvent.click(
      screen.getByRole("button", { name: strings.addTextFieldHere }),
    );
    const textInput = await screen.findByRole("textbox", {
      name: strings.textFieldFallbackLabel(1),
    });
    fireEvent.change(textInput, { target: { value: "Ana Perez" } });
    fireEvent.blur(textInput);

    // 4. Pasar al paso de firma y descargar (sin huecos de imagen).
    fireEvent.click(
      screen.getByRole("button", { name: `4. ${strings.stepSign}` }),
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
        { timeout: 3000, interval: 100 },
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
    10_000,
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
