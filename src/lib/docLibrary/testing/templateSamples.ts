import type { SignFieldInput, TemplateDraft, TextFieldInput, VariantInput } from "../templateTypes";

/** Plantillas ARMADAS A MANO para las pruebas (datos sintéticos; sin documentos reales). */

export const R = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

/** Geometría observada en los contratos reales (plan §11): esquina inferior derecha de cada página. */
export const INITIALS_BASE = R(0.79, 0.84, 0.11, 0.03);

export function signField(overrides: Partial<SignFieldInput> = {}): SignFieldInput {
  return { roleIndex: 0, pageIndex: 3, type: "signature", rect: R(0.16, 0.5, 0.25, 0.05), ...overrides };
}

export function textField(overrides: Partial<TextFieldInput> = {}): TextFieldInput {
  return { pageIndex: 0, rect: R(0.1, 0.2, 0.3, 0.025), type: "text", label: "Nombre", ...overrides };
}

export function variantOf(fields: SignFieldInput[], textFields: TextFieldInput[] = []): VariantInput {
  return { fields, textFields };
}

/** Plantilla de 2 firmantes (+ variante de 1) de un contrato de 4 páginas. */
export function sampleDraft(documentId: string | null, overrides: Partial<TemplateDraft> = {}): TemplateDraft {
  return {
    documentId,
    name: "Contrato de servicio",
    variants: {
      "1": variantOf(
        [signField({ pageIndex: 3 }), signField({ pageIndex: 0, type: "initials", rect: R(0.79, 0.84, 0.11, 0.03) })],
        [textField({ dataKey: "insuredName1" })],
      ),
      "2": variantOf(
        [
          signField({ pageIndex: 3 }),
          signField({ pageIndex: 3, roleIndex: 1, rect: R(0.55, 0.5, 0.25, 0.05) }),
          signField({ pageIndex: 0, type: "initials", rect: R(0.79, 0.84, 0.05, 0.03) }),
          signField({ pageIndex: 0, type: "initials", roleIndex: 1, rect: R(0.85, 0.84, 0.05, 0.03) }),
        ],
        [textField({ dataKey: "insuredName1" }), textField({ pageIndex: 3, type: "date", label: "Fecha", dataKey: "today", rule: "today" })],
      ),
    },
    ...overrides,
  };
}

let counter = 0;
/** Generador de ids de plantilla predecible para las pruebas. */
export function idSequence(prefix = "tpl-test"): () => string {
  return () => `${prefix}-${(counter += 1)}`;
}

/** Reloj controlado: cada llamada avanza un segundo. */
export function clock(startIso = "2026-03-01T10:00:00.000Z"): () => Date {
  let t = Date.parse(startIso);
  return () => {
    const d = new Date(t);
    t += 1000;
    return d;
  };
}
