import { describe, expect, it } from "vitest";
import { documentContentKey } from "@/app/sign-pdf/documentKey";
import {
  captureStamp,
  pendingSigners,
  validCapture,
  type CaptureMap,
} from "@/app/sign-pdf/SigningCeremony";
import { fileKey } from "@/app/organize-pdf/pageToolkit";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };

const FIELDS: SignatureField[] = [
  {
    id: "f1",
    signerId: ANA.id,
    pageIndex: 0,
    type: "signature",
    rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
  },
];

const META = {
  type: "application/pdf",
  lastModified: 1_700_000_000_000,
} as const;

/** Mismo nombre, mismo tamaño y misma fecha; contenido distinto. */
const ORIGINAL = new File([new Uint8Array([1, 2, 3])], "contrato.pdf", META);
const SUPLANTADOR = new File([new Uint8Array([9, 9, 9])], "contrato.pdf", META);
/** El mismo documento vuelto a cargar: otro `File`, los mismos bytes. */
const RECARGADO = new File([new Uint8Array([1, 2, 3])], "contrato.pdf", META);

function capturesFor(documentKey: string): CaptureMap {
  return {
    [ANA.id]: {
      signature: { dataUrl: "data:image/png;base64,iVBORw0KGgo=", ratio: 0.3 },
      initials: null,
      stamp: captureStamp(documentKey, FIELDS, ANA.id),
    },
  };
}

describe("documentContentKey — src/app/sign-pdf/documentKey.ts", () => {
  it("dos PDF distintos con el mismo nombre, tamaño y fecha no comparten identidad", async () => {
    // La identidad barata los confunde: por eso aqui se mira el contenido.
    expect(fileKey(ORIGINAL)).toBe(fileKey(SUPLANTADOR));

    const original = await documentContentKey(ORIGINAL);
    const suplantador = await documentContentKey(SUPLANTADOR);
    expect(original).not.toBe(suplantador);

    const captures = capturesFor(original);
    const capture = validCapture(captures, FIELDS, ANA.id, suplantador);
    expect(capture.signature).toBeNull();
    expect(pendingSigners([ANA], FIELDS, captures, suplantador)).toHaveLength(1);
  });

  it("el mismo documento cargado otra vez conserva su identidad y sus trazos", async () => {
    const original = await documentContentKey(ORIGINAL);
    const recargado = await documentContentKey(RECARGADO);
    expect(recargado).toBe(original);

    const captures = capturesFor(original);
    const capture = validCapture(captures, FIELDS, ANA.id, recargado);
    expect(capture.signature).not.toBeNull();
    expect(pendingSigners([ANA], FIELDS, captures, recargado)).toHaveLength(0);
  });

  it("sin identidad calculada no se da por buena ninguna captura", async () => {
    const captures = capturesFor(await documentContentKey(ORIGINAL));

    const capture = validCapture(captures, FIELDS, ANA.id, null);
    expect(capture.signature).toBeNull();
    expect(capture.initials).toBeNull();
    expect(pendingSigners([ANA], FIELDS, captures, null)).toHaveLength(1);
  });
});
