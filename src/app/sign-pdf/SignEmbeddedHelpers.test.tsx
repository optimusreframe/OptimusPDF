import { describe, expect, it } from "vitest";
import { embeddedWarnings, hasSignProgress } from "@/app/sign-pdf/SignEmbedded";
import { multiReady, type SignToolOptions } from "@/app/sign-pdf/SignToolClient";
import { captureStamp } from "@/app/sign-pdf/SigningCeremony";
import { validCapture, type CaptureMap } from "@/app/sign-pdf/captures";
import { stampKeyOf } from "@/app/sign-pdf/textEdits";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

function view(overrides: Partial<SignToolOptions> = {}): SignToolOptions {
  return {
    mode: "single",
    signaturePng: "",
    ratio: 0,
    pageIndex: 0,
    rect: { x: 0, y: 0, width: 0, height: 0 },
    signature: "huella-a",
    step: "signers",
    signers: [],
    fields: [],
    captures: {},
    activeSignerId: null,
    fieldPageIndex: 0,
    selectedFieldId: null,
    placementTool: "select",
    textFields: [],
    textValues: {},
    selectedTextFieldId: null,
    editingTextFieldId: null,
    textFieldsDetectedFor: null,
    ...overrides,
  };
}

describe("hasSignProgress: lo que se perderia al descartar la sesion", () => {
  it("una sesion recien abierta no tiene trabajo", () => {
    expect(hasSignProgress(view())).toBe(false);
  });

  it("una firma creada, aunque no este colocada, cuenta", () => {
    expect(hasSignProgress(view({ signaturePng: "data:image/png;base64,AAAA", ratio: 0.3 }))).toBe(true);
  });

  it("una firma colocada cuenta", () => {
    expect(hasSignProgress(view({ rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 } }))).toBe(true);
  });

  it("un valor escrito cuenta; uno en blanco no", () => {
    expect(hasSignProgress(view({ textValues: { a: "  " } }))).toBe(false);
    expect(hasSignProgress(view({ textValues: { a: "Ana" } }))).toBe(true);
  });

  it("un campo puesto a mano cuenta aunque este vacio; uno detectado, no", () => {
    const base = { id: "t1", pageIndex: 0, rect: { x: 0, y: 0, width: 0.1, height: 0.1 }, confidence: "high" as const };
    expect(hasSignProgress(view({ textFields: [{ ...base, source: "manual" }] }))).toBe(true);
    expect(hasSignProgress(view({ textFields: [{ ...base, source: "acroform" }] }))).toBe(false);
  });

  it("un firmante con nombre, un hueco o un trazo cuentan; un firmante sin nombre no", () => {
    const ana: Signer = { id: "s1", name: "Ana", color: "#000" };
    const sinNombre: Signer = { id: "s2", name: "  ", color: "#111" };
    expect(hasSignProgress(view({ signers: [ana] }))).toBe(true);
    expect(hasSignProgress(view({ signers: [sinNombre] }))).toBe(false);
    const field: SignatureField = { id: "f1", signerId: "s1", pageIndex: 0, type: "signature", rect: { x: 0, y: 0, width: 0.2, height: 0.1 } };
    expect(hasSignProgress(view({ fields: [field] }))).toBe(true);
    expect(hasSignProgress(view({ captures: { s1: { signature: null, initials: null, stamp: "x" } } }))).toBe(true);
  });

  it("texto original editado cuenta", () => {
    expect(
      hasSignProgress(
        view({
          textEdits: [
            { id: "e1", kind: "text", pageIndex: 0, blockId: "b", text: "hola" } as unknown as NonNullable<SignToolOptions["textEdits"]>[number],
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe("embeddedWarnings", () => {
  it("sin datos no hay avisos", () => {
    expect(embeddedWarnings(undefined)).toEqual([]);
    expect(embeddedWarnings({})).toEqual([]);
    expect(embeddedWarnings({ signatures: "none", encrypted: false })).toEqual([]);
  });

  it("firmas digitales activas -> signaturesInvalidated; sin poder comprobar -> signaturesUnknown", () => {
    expect(embeddedWarnings({ signatures: "active" })).toEqual([{ code: "signaturesInvalidated" }]);
    expect(embeddedWarnings({ signatures: "unknown" })).toEqual([{ code: "signaturesUnknown" }]);
  });

  it("copia descifrada -> decryptedCopy y el orden es firmas, luego cifrado", () => {
    expect(embeddedWarnings({ encrypted: true })).toEqual([{ code: "decryptedCopy" }]);
    expect(embeddedWarnings({ signatures: "active", encrypted: true }).map((warning) => warning.code)).toEqual([
      "signaturesInvalidated",
      "decryptedCopy",
    ]);
  });
});

describe("sellos de firma: no valen para los bytes de otro snapshot", () => {
  const ana: Signer = { id: "s1", name: "Ana", color: "#000" };
  const fields: SignatureField[] = [
    { id: "f1", signerId: "s1", pageIndex: 0, type: "signature", rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 } },
  ];
  const draft = { dataUrl: "data:image/png;base64,iVBORw0KGgo=", ratio: 0.3 };
  const captures = (key: string): CaptureMap => ({
    [ana.id]: { signature: draft, initials: null, stamp: captureStamp(key, fields, ana.id) },
  });

  it("la captura sellada con la huella del snapshot A es valida para A", () => {
    expect(validCapture(captures("huella-a"), fields, ana.id, "huella-a").signature).toEqual(draft);
  });

  it("la misma captura NO es valida con la huella del snapshot B (los bytes cambiaron por fuera del modo)", () => {
    expect(validCapture(captures("huella-a"), fields, ana.id, "huella-b").signature).toBeNull();
  });

  it("sin huella (aun calculandose) no vale ninguna captura", () => {
    expect(validCapture(captures("huella-a"), fields, ana.id, null).signature).toBeNull();
  });

  it("una ronda con huecos NO esta lista con una captura de otro snapshot, y si con la propia", () => {
    const own = view({ mode: "multi", signers: [ana], fields, captures: captures("huella-a"), signature: "huella-a" });
    expect(multiReady(own, "huella-a")).toBe(true);
    expect(multiReady({ ...own, signature: "huella-b" }, "huella-b")).toBe(false);
  });

  it("las ediciones de texto entran en el sello: cambiarlas invalida la captura (stampKeyOf)", () => {
    const edit = { id: "e1", kind: "text", pageIndex: 0, blockId: "b", text: "x" } as unknown as NonNullable<SignToolOptions["textEdits"]>[number];
    expect(stampKeyOf("huella-a", [])).toBe("huella-a");
    expect(stampKeyOf("huella-a", [edit])).not.toBe("huella-a");
  });
});
