import {
  dataUrlToBytes,
  type SignPlacement,
  type SignatureField,
} from "@/lib/pdf/sign";
import {
  embeddedValueFor,
  fieldTypeOf,
  isFieldFilled,
  type DetectedField,
} from "@/lib/pdf/detectFields";
import type { NormalizedRect } from "@/lib/pdf/watermark";

/*
 * Modo "Solo yo" sobre el lienzo unico (W2-C). La firma propia es UN elemento
 * mas del lienzo, como lo era el hueco en "Varios firmantes", pero su modelo
 * persistido sigue siendo el de siempre (`rect` + `pageIndex` de las opciones,
 * `width: 0` = sin colocar): aqui solo se traduce entre ese modelo y el
 * `SignatureField` que entiende `DocumentCanvas`. Una sola firma colocada,
 * como antes; volver a usar la herramienta Firma la MUEVE, no la duplica.
 */

/** Identificador fijo de la unica firma del modo "Solo yo" (tambien su id de seleccion). */
export const SOLO_SLOT_ID = "solo-signature";
/** Dueño sintetico de esa firma (el lienzo exige un `signerId`). */
export const SOLO_SIGNER_ID = "solo";

export const UNPLACED_RECT: NormalizedRect = { x: 0, y: 0, width: 0, height: 0 };

/** Ancho por defecto de la firma, en fraccion de pagina (el de siempre). */
const DEFAULT_WIDTH_FRACTION = 0.32;
/** Centro vertical por defecto: el tercio inferior, donde se firma casi siempre. */
const DEFAULT_CENTER_Y = 0.74;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** La firma colocada como hueco del lienzo (`[]` si aun no esta colocada). */
export function soloSlotsFrom(placement: {
  rect: NormalizedRect;
  pageIndex: number;
}): SignatureField[] {
  if (placement.rect.width <= 0) return [];
  return [
    {
      id: SOLO_SLOT_ID,
      signerId: SOLO_SIGNER_ID,
      pageIndex: placement.pageIndex,
      type: "signature",
      rect: placement.rect,
    },
  ];
}

/**
 * Lo que el lienzo devuelve (`slots`) a las opciones. Solo hay una firma: si
 * llegan varias (el lienzo añade, no sustituye) manda la ultima, que es la
 * recien creada; sin ninguna, queda sin colocar.
 */
export function soloPlacementFromSlots(slots: readonly SignatureField[]): {
  rect: NormalizedRect;
  pageIndex: number;
} {
  const last = slots[slots.length - 1];
  return last
    ? { rect: last.rect, pageIndex: last.pageIndex }
    : { rect: UNPLACED_RECT, pageIndex: 0 };
}

/**
 * Alto (fraccion de pagina) de una firma de ancho `width` y proporcion
 * `ratio` (alto/ancho del PNG): depende de la proporcion de la hoja en pantalla.
 */
export function soloHeightFor(
  width: number,
  ratio: number,
  pageAspect: number,
): number {
  return Math.min(0.9, width * ratio * pageAspect);
}

/** Colocacion por defecto: centrada y en el tercio inferior de la pagina visible. */
export function defaultSoloRect(ratio: number, pageAspect: number): NormalizedRect {
  const width = DEFAULT_WIDTH_FRACTION;
  const height = soloHeightFor(width, ratio, pageAspect);
  return {
    x: 0.5 - width / 2,
    y: clamp(DEFAULT_CENTER_Y - height / 2, 0, 1 - height),
    width,
    height,
  };
}

/**
 * Ajusta el alto de una firma ya colocada a la proporcion de una firma NUEVA
 * (conserva posicion y ancho; la sube si se saldria por abajo).
 */
export function refitSoloRect(
  rect: NormalizedRect,
  ratio: number,
  pageAspect: number,
): NormalizedRect {
  const height = soloHeightFor(rect.width, ratio, pageAspect);
  return {
    x: rect.x,
    y: clamp(rect.y, 0, Math.max(0, 1 - height)),
    width: rect.width,
    height,
  };
}

/**
 * Los campos de texto/casilla/fecha/iniciales con valor, listos para
 * empotrar. Los compartidos por "Solo yo" y "Varios firmantes": uno vacio
 * simplemente no se empotra (nunca estropea el documento) y la casilla
 * marcada se centra ("X").
 */
export function buildTextPlacements(
  textFields: readonly DetectedField[],
  textValues: Readonly<Record<string, string>>,
  language: "es" | "en",
): SignPlacement[] {
  const placements: SignPlacement[] = [];
  for (const field of textFields) {
    const raw = textValues[field.id] ?? "";
    const value = embeddedValueFor(field, raw, language);
    if (!value) continue;
    placements.push({
      kind: "text",
      value,
      pageIndex: field.pageIndex,
      rect: field.rect,
      align: fieldTypeOf(field) === "checkbox" ? "center" : "left",
    });
  }
  return placements;
}

export type SoloContent = {
  signaturePng: string;
  rect: NormalizedRect;
  pageIndex: number;
  textFields: readonly DetectedField[];
  textValues: Readonly<Record<string, string>>;
};

/** Hay una firma creada Y colocada sobre el documento. */
export function hasPlacedSignature(content: {
  signaturePng: string;
  rect: NormalizedRect;
}): boolean {
  return content.signaturePng !== "" && content.rect.width > 0;
}

/** Algun campo tiene valor que empotrar. */
export function hasFilledField(
  textFields: readonly DetectedField[],
  textValues: Readonly<Record<string, string>>,
): boolean {
  return textFields.some((field) => isFieldFilled(field, textValues[field.id]));
}

/** Hay algo que aplicar: la firma colocada o algun campo relleno. */
export function soloReady(content: SoloContent): boolean {
  return (
    hasPlacedSignature(content) ||
    hasFilledField(content.textFields, content.textValues)
  );
}

/**
 * Lo que se empotra en el modo "Solo yo": la firma (si esta creada y
 * colocada) y los campos con valor. La firma va primero y sola es exactamente
 * la colocacion de siempre (`signPdf`).
 */
export function buildSoloPlacements(
  content: SoloContent,
  language: "es" | "en",
): SignPlacement[] {
  const placements: SignPlacement[] = [];
  if (hasPlacedSignature(content)) {
    placements.push({
      kind: "image",
      png: dataUrlToBytes(content.signaturePng),
      pageIndex: content.pageIndex,
      rect: content.rect,
    });
  }
  placements.push(
    ...buildTextPlacements(content.textFields, content.textValues, language),
  );
  return placements;
}
