import { useCallback, useState } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MultiFlow, type SignToolOptions } from "@/app/sign-pdf/SignToolClient";
import { documentContentKey } from "@/app/sign-pdf/documentKey";
import { captureStamp, type CaptureMap } from "@/app/sign-pdf/SigningCeremony";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { fileKey } from "@/app/organize-pdf/pageToolkit";
import type { SignatureField, Signer } from "@/lib/pdf/sign";
import { detectFields, type DetectedField } from "@/lib/pdf/detectFields";

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
    expect(screen.getByRole("textbox", { name: "Nombre" })).toBeTruthy();
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
    window.sessionStorage.setItem(
      "optimuspdf:sign-fill:lastValues",
      JSON.stringify({ nombre: "Ana Garcia" }),
    );
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
    fireEvent.click(
      screen.getByRole("button", { name: strings.reuseValuesAccept }),
    );

    await waitFor(() =>
      expect(last.textValues[last.textFields[0].id]).toBe("Ana Garcia"),
    );
    expect(screen.queryByText(strings.reuseValuesPrompt)).toBeNull();
  });
});
