import { useState } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MultiFlow, type SignToolOptions } from "@/app/sign-pdf/SignToolClient";
import { documentContentKey } from "@/app/sign-pdf/documentKey";
import { captureStamp, type CaptureMap } from "@/app/sign-pdf/SigningCeremony";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { fileKey } from "@/app/organize-pdf/pageToolkit";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

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
  };
}

type HarnessProps = {
  file: File;
  onOptions: (options: SignToolOptions) => void;
};

function Harness({ file, onOptions }: HarnessProps) {
  const [options, setOptions] = useState<SignToolOptions>(() =>
    optionsFor(CLAVE_PRIMERO),
  );
  onOptions(options);
  return (
    <MultiFlow
      file={file}
      options={options}
      setOptions={(patch) =>
        setOptions((previous) => ({ ...previous, ...patch }))
      }
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
