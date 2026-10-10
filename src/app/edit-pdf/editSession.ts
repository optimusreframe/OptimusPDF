import {
  MAX_STROKE_WIDTH,
  MIN_ELEMENT_SIDE,
  MIN_LINE_LENGTH,
  MIN_STROKE_WIDTH,
  type CheckElement,
  type CheckMark,
  type EditElement,
  type EllipseElement,
  type HighlightElement,
  type ImageElement,
  type LineElement,
  type RectElement,
} from "@/lib/pdf/editPdf";
import { coverForBlock } from "@/lib/pdf/editCover";
import type {
  CatalogFontKey,
  CoverOriented,
  CoverSpec,
  SourceFontInfo,
  TextAlign,
  TextBlock,
  TextEdit,
  UserBox,
} from "@/lib/pdf/editTypes";

/**
 * Sesion de edicion del editor de PDF (Wave 5 · U3): estado PURO e inmutable.
 *
 * El PDF original NUNCA se muta: la sesion solo guarda la LISTA de cambios
 * (ediciones de texto, imagenes, formas) y el historial para deshacer/rehacer.
 * Al exportar se parte en `TextEdit[]` (motor nuevo, espacio de usuario PDF) y
 * `EditElement[]` (motor de `editPdf.ts`, coordenadas normalizadas 0..1) con
 * `splitForExport`, y siempre se reconstruye desde los bytes originales.
 *
 * MODELO DE COORDENADAS (cada item usa el de su motor, no se mezclan):
 *  - `kind: "text"`  -> `UserBox` en puntos PDF, origen ABAJO a la izquierda
 *    (`dy > 0` sube). Es el espacio de `TextBlock`/`TextEdit`.
 *  - `kind: "image" | "shape"` -> fracciones 0..1 de la pagina tal y como se ve,
 *    origen ARRIBA a la izquierda (`dy > 0` baja). Es el espacio de `editPdf.ts`.
 * `move`/`resize` reciben valores en el modelo NATIVO del item; la interfaz
 * convierte con `canvasGeometry`/`core.ts` antes de despachar.
 *
 * HISTORIAL CON CURSOR: cada entrada guarda las listas de items antes y despues
 * (arreglos inmutables que comparten estructura, por eso es barato). `cursor` es
 * cuantas entradas estan aplicadas; deshacer/rehacer solo lo mueven. Una
 * operacion nueva con cursor < largo descarta lo rehacible.
 *
 * AGRUPADO: ops `update` (tecleo) y `restyle` (arrastrar un control) consecutivas
 * sobre el MISMO item (y las mismas propiedades) dentro de `EDIT_GROUP_WINDOW_MS`
 * se funden en una entrada. El tiempo se inyecta (`now`) para que sea
 * determinista; la ventana es deslizante (cuenta desde la ultima op del grupo).
 * Deshacer, rehacer, reset y cualquier otra op rompen el grupo.
 *
 * Las imagenes viven en `assets` (id -> bytes); los items solo llevan `assetId`,
 * asi una op no copia bytes. Todo lo que entra (ops, JSON de un borrador) pasa
 * por el mismo validador: lo invalido se descarta sin lanzar.
 */

/* ------------------------------------------------------------------ *
 * Constantes
 * ------------------------------------------------------------------ */

export const EDIT_SESSION_SCHEMA = 1 as const;
/** Ventana (ms) en la que ops consecutivas del mismo item se funden. */
export const EDIT_GROUP_WINDOW_MS = 500;
/** Entradas maximas de historial; las mas antiguas se olvidan. */
export const EDIT_HISTORY_LIMIT = 200;
/** Items maximos por sesion (cota defensiva ante JSON enorme o corrupto). */
export const EDIT_MAX_ITEMS = 2000;
/** Largo maximo del texto de una edicion. */
export const EDIT_MAX_TEXT_LENGTH = 200_000;

const MIN_TEXT_FONT_SIZE = 1;
const MAX_TEXT_FONT_SIZE = 1000;
/** Holgura numerica al validar fracciones 0..1 (errores de coma flotante). */
const UNIT_EPSILON = 1e-6;

const CATALOG_FONT_KEYS: readonly CatalogFontKey[] = [
  "helvetica",
  "times",
  "courier",
  "liberation-sans",
  "liberation-serif",
  "liberation-mono",
];
const TEXT_ALIGNS: readonly TextAlign[] = ["left", "center", "right"];
const CHECK_MARKS: readonly CheckMark[] = ["check", "cross"];
const ASSET_ID = /^[\w-]{1,64}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/* ------------------------------------------------------------------ *
 * Tipos publicos
 * ------------------------------------------------------------------ */

/** Formas que la sesion envuelve tal cual las define `editPdf.ts`. */
export type EditShapeElement =
  | RectElement
  | EllipseElement
  | LineElement
  | HighlightElement
  | CheckElement;

/** Imagen sin bytes: el contenido vive en `EditSession.assets[assetId]`. */
export type EditImageRef = Omit<ImageElement, "bytes" | "previewUrl"> & {
  assetId: string;
};

export type ImageAsset = {
  /** PNG o JPG tal cual los subio la persona. */
  bytes: Uint8Array;
  /** Data URL solo para la vista previa. */
  previewUrl: string;
};

export type EditTextItem = { kind: "text"; id: string; edit: TextEdit };
export type EditImageItem = { kind: "image"; id: string; element: EditImageRef };
export type EditShapeItem = { kind: "shape"; id: string; element: EditShapeElement };
/**
 * (Adicion W5-U5) «Aplanar pagina»: marca de que, al exportar, esa pagina se
 * sustituye por una imagen de lo que se ve (con todas las ediciones ya
 * horneadas). Es un item mas, asi entra en deshacer/rehacer, en los borradores y
 * en la cuenta de cambios sin tocar el resto del modelo. Como mucho UNA por pagina.
 */
export type EditFlattenItem = { kind: "flatten"; id: string; pageIndex: number };
export type EditItem = EditTextItem | EditImageItem | EditShapeItem | EditFlattenItem;

/** Caja en el modelo NATIVO del item (ver la cabecera). */
export type ItemBox = { x: number; y: number; width: number; height: number };

/** Contenido editable: hoy solo el texto de una edicion de texto. */
export type UpdatePatch = { text?: string };

/** Estilo, plano: cada item solo toma las claves que entiende (el resto se ignora). */
export type RestylePatch = Partial<{
  // Texto
  fontSize: number;
  color: string;
  align: TextAlign;
  fontKey: CatalogFontKey;
  bold: boolean;
  italic: boolean;
  rotation: number;
  lineHeight: number;
  cover: CoverSpec;
  // Formas
  strokeColor: string;
  strokeWidth: number;
  fill: boolean;
  fillColor: string;
  fillOpacity: number;
  opacity: number;
  mark: CheckMark;
}>;

export type EditOp =
  | { type: "add"; item: EditItem; asset?: ImageAsset }
  | { type: "update"; id: string; patch: UpdatePatch }
  | { type: "remove"; id: string }
  | { type: "move"; id: string; dx: number; dy: number }
  | { type: "resize"; id: string; box: ItemBox }
  | { type: "restyle"; id: string; patch: RestylePatch }
  /**
   * (Adicion W5-U4b) Mueve los DOS extremos de una linea a la vez (arrastrar un
   * extremo, voltear la diagonal). `resize` no sirve: conserva el sentido de la
   * linea y obliga a un ancho/alto minimo, asi que no representa una horizontal
   * perfecta ni un extremo que cruza al otro lado. Solo lineas; fracciones 0..1.
   */
  | { type: "reshape"; id: string; points: LinePoints };

/** Extremos de una linea, en fracciones 0..1 de la pagina como se ve. */
export type LinePoints = { x1: number; y1: number; x2: number; y2: number };

export type EditOpType = EditOp["type"];

export type HistoryEntry = {
  op: EditOpType;
  itemId: string;
  before: readonly EditItem[];
  after: readonly EditItem[];
  /** Marca de tiempo (ms) de la ultima op fundida en esta entrada. */
  at: number;
};

export type EditSession = {
  readonly schema: typeof EDIT_SESSION_SCHEMA;
  readonly items: readonly EditItem[];
  readonly assets: Readonly<Record<string, ImageAsset>>;
  readonly history: readonly HistoryEntry[];
  /** Entradas aplicadas (0..history.length). */
  readonly cursor: number;
  readonly selectedId: string | null;
  /** Grupo de tecleo abierto, o `null`. */
  readonly group: { key: string; at: number } | null;
};

/* ------------------------------------------------------------------ *
 * Validacion
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Bytes de un valor que puede venir de otro "realm" (IndexedDB, jsdom, iframes):
 * `instanceof Uint8Array` falla ahi aunque sea un Uint8Array de verdad. Devuelve
 * un `Uint8Array` del realm actual sobre el mismo buffer, o `null`.
 */
export function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Fraccion 0..1 (con holgura) recortada, o `null` si no lo es. */
function unit(value: unknown): number | null {
  if (!isFiniteNumber(value)) return null;
  if (value < -UNIT_EPSILON || value > 1 + UNIT_EPSILON) return null;
  return clamp(value, 0, 1);
}

function hex(value: unknown): string | null {
  return typeof value === "string" && HEX_COLOR.test(value)
    ? value.toLowerCase()
    : null;
}

/** True si todos los campos numericos de la edicion son numeros finitos. */
export function hasFiniteGeometry(edit: TextEdit): boolean {
  const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
  const box = (b: UserBox | undefined) =>
    b === undefined || (finite(b.x) && finite(b.y) && finite(b.width) && finite(b.height));
  const oriented = edit.coverOriented;
  return (
    box(edit.box) &&
    box(edit.coverBox) &&
    (edit.obstacles ?? []).every((o) => box(o.box)) &&
    (edit.coverClip ?? []).every((b) => box(b)) &&
    (oriented === undefined ||
      (finite(oriented.origin?.x) &&
        finite(oriented.origin?.y) &&
        finite(oriented.width) &&
        finite(oriented.height) &&
        finite(oriented.rotation))) &&
    finite(edit.fontSize) &&
    finite(edit.rotation) &&
    finite(edit.cover?.padding) &&
    (edit.lineHeight === undefined || finite(edit.lineHeight))
  );
}

function parseCoverOriented(value: unknown): CoverOriented | null {
  if (!isRecord(value) || !isRecord(value.origin)) return null;
  const { x, y } = value.origin;
  const { width, height, rotation } = value;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height) ||
    !isFiniteNumber(rotation) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { origin: { x, y }, width, height, rotation };
}

function parseUserBox(value: unknown): UserBox | null {
  if (!isRecord(value)) return null;
  const { x, y, width, height } = value;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { x, y, width, height };
}

function parseCover(value: unknown): CoverSpec | null {
  if (!isRecord(value)) return null;
  const color = value.color === null ? null : hex(value.color);
  if (value.color !== null && color === null) return null;
  if (!isFiniteNumber(value.padding) || value.padding < 0) return null;
  return value.uniform === false
    ? { color, padding: value.padding, uniform: false }
    : { color, padding: value.padding };
}

/** Reconstruye una `TextEdit` campo a campo (descarta claves ajenas); `null` si algo falla. */
export function parseTextEdit(raw: unknown): TextEdit | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  if (!Number.isInteger(raw.pageIndex) || (raw.pageIndex as number) < 0) return null;
  const box = parseUserBox(raw.box);
  if (!box) return null;
  if (typeof raw.text !== "string" || raw.text.length > EDIT_MAX_TEXT_LENGTH) return null;
  if (
    !isFiniteNumber(raw.fontSize) ||
    raw.fontSize < MIN_TEXT_FONT_SIZE ||
    raw.fontSize > MAX_TEXT_FONT_SIZE
  ) {
    return null;
  }
  const color = hex(raw.color);
  if (!color) return null;
  if (!TEXT_ALIGNS.includes(raw.align as TextAlign)) return null;
  if (!CATALOG_FONT_KEYS.includes(raw.fontKey as CatalogFontKey)) return null;
  if (typeof raw.bold !== "boolean" || typeof raw.italic !== "boolean") return null;
  if (!isFiniteNumber(raw.rotation)) return null;
  const cover = parseCover(raw.cover);
  if (!cover) return null;

  const edit: TextEdit = {
    id: raw.id,
    pageIndex: raw.pageIndex as number,
    box,
    text: raw.text,
    fontSize: raw.fontSize,
    color,
    align: raw.align as TextAlign,
    fontKey: raw.fontKey as CatalogFontKey,
    bold: raw.bold,
    italic: raw.italic,
    rotation: raw.rotation,
    cover,
  };
  if (raw.blockId !== undefined) {
    if (typeof raw.blockId !== "string" || raw.blockId.length === 0) return null;
    edit.blockId = raw.blockId;
  }
  if (raw.coverBox !== undefined) {
    const coverBox = parseUserBox(raw.coverBox);
    if (!coverBox) return null;
    edit.coverBox = coverBox;
  }
  if (raw.obstacles !== undefined) {
    if (!Array.isArray(raw.obstacles)) return null;
    const obstacles: Array<{ id: string; box: UserBox }> = [];
    for (const item of raw.obstacles) {
      const obstacleBox = isRecord(item) ? parseUserBox(item.box) : null;
      if (!isRecord(item) || typeof item.id !== "string" || !obstacleBox) return null;
      obstacles.push({ id: item.id, box: obstacleBox });
    }
    edit.obstacles = obstacles;
  }
  if (raw.coverClip !== undefined) {
    if (!Array.isArray(raw.coverClip)) return null;
    const clip: UserBox[] = [];
    for (const item of raw.coverClip) {
      const parsed = parseUserBox(item);
      if (!parsed) return null;
      clip.push(parsed);
    }
    edit.coverClip = clip;
  }
  if (raw.coverOriented !== undefined) {
    const oriented = parseCoverOriented(raw.coverOriented);
    if (!oriented) return null;
    edit.coverOriented = oriented;
  }
  if (raw.lineHeight !== undefined) {
    if (!isFiniteNumber(raw.lineHeight) || raw.lineHeight <= 0 || raw.lineHeight > 10) {
      return null;
    }
    edit.lineHeight = raw.lineHeight;
  }
  // (W5-U5 · N4) Antes se descartaban: sin ellos el exportador no avisaba «fuente parecida» y el editor y la lista de
  // descarga se contradecian.
  if (raw.sourceFont !== undefined) {
    const font = parseSourceFont(raw.sourceFont);
    if (!font) return null;
    edit.sourceFont = font;
  }
  if (raw.mixedStyle === true) edit.mixedStyle = true;
  return edit;
}

function parseSourceFont(raw: unknown): SourceFontInfo | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.pdfName !== "string" || raw.pdfName.length === 0 || raw.pdfName.length > 200) return null;
  if (raw.family !== "sans" && raw.family !== "serif" && raw.family !== "mono") return null;
  for (const flag of ["bold", "italic", "subset", "embedded", "symbolic", "type3"] as const) {
    if (typeof raw[flag] !== "boolean") return null;
  }
  return {
    pdfName: raw.pdfName,
    family: raw.family,
    bold: raw.bold as boolean,
    italic: raw.italic as boolean,
    subset: raw.subset as boolean,
    embedded: raw.embedded as boolean,
    symbolic: raw.symbolic as boolean,
    type3: raw.type3 as boolean,
  };
}

type NormBox = { x: number; y: number; width: number; height: number };

/** Caja normalizada: origen y tamano validos, recortada a la pagina. */
function parseNormBox(value: Record<string, unknown>): NormBox | null {
  const x = unit(value.x);
  const y = unit(value.y);
  if (x === null || y === null) return null;
  if (!isFiniteNumber(value.width) || !isFiniteNumber(value.height)) return null;
  const width = Math.min(1 - x, value.width);
  const height = Math.min(1 - y, value.height);
  if (width < MIN_ELEMENT_SIDE || height < MIN_ELEMENT_SIDE) return null;
  return { x, y, width, height };
}

function parseBase(
  raw: Record<string, unknown>,
): { id: string; pageIndex: number } | null {
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  if (!Number.isInteger(raw.pageIndex) || (raw.pageIndex as number) < 0) return null;
  return { id: raw.id, pageIndex: raw.pageIndex as number };
}

function parseImageRef(raw: unknown): EditImageRef | null {
  if (!isRecord(raw) || raw.type !== "image") return null;
  const base = parseBase(raw);
  const box = parseNormBox(raw);
  if (!base || !box) return null;
  if (!isFiniteNumber(raw.ratio) || raw.ratio <= 0) return null;
  if (typeof raw.assetId !== "string" || !ASSET_ID.test(raw.assetId)) return null;
  return { type: "image", ...base, ...box, ratio: raw.ratio, assetId: raw.assetId };
}

export function parseShapeElement(raw: unknown): EditShapeElement | null {
  if (!isRecord(raw)) return null;
  const base = parseBase(raw);
  if (!base) return null;

  switch (raw.type) {
    case "rect":
    case "ellipse": {
      const box = parseNormBox(raw);
      const strokeColor = hex(raw.strokeColor);
      const fillColor = hex(raw.fillColor);
      if (!box || !strokeColor || !fillColor) return null;
      if (typeof raw.fill !== "boolean") return null;
      if (!isFiniteNumber(raw.strokeWidth) || !isFiniteNumber(raw.fillOpacity)) return null;
      return {
        type: raw.type,
        ...base,
        ...box,
        strokeColor,
        strokeWidth: clamp(raw.strokeWidth, 0, MAX_STROKE_WIDTH),
        fill: raw.fill,
        fillColor,
        fillOpacity: clamp(raw.fillOpacity, 0.05, 1),
      };
    }
    case "line": {
      const x1 = unit(raw.x1);
      const y1 = unit(raw.y1);
      const x2 = unit(raw.x2);
      const y2 = unit(raw.y2);
      const strokeColor = hex(raw.strokeColor);
      if (x1 === null || y1 === null || x2 === null || y2 === null || !strokeColor) {
        return null;
      }
      if (!isFiniteNumber(raw.strokeWidth)) return null;
      if (Math.hypot(x2 - x1, y2 - y1) < MIN_LINE_LENGTH) return null;
      return {
        type: "line",
        ...base,
        x1,
        y1,
        x2,
        y2,
        strokeColor,
        strokeWidth: clamp(raw.strokeWidth, MIN_STROKE_WIDTH, MAX_STROKE_WIDTH),
      };
    }
    case "highlight": {
      const box = parseNormBox(raw);
      const color = hex(raw.color);
      if (!box || !color || !isFiniteNumber(raw.opacity)) return null;
      return {
        type: "highlight",
        ...base,
        ...box,
        color,
        opacity: clamp(raw.opacity, 0.05, 1),
      };
    }
    case "check": {
      const box = parseNormBox(raw);
      const strokeColor = hex(raw.strokeColor);
      if (!box || !strokeColor) return null;
      if (!CHECK_MARKS.includes(raw.mark as CheckMark)) return null;
      if (!isFiniteNumber(raw.strokeWidth)) return null;
      return {
        type: "check",
        ...base,
        ...box,
        mark: raw.mark as CheckMark,
        strokeColor,
        strokeWidth: clamp(raw.strokeWidth, MIN_STROKE_WIDTH, MAX_STROKE_WIDTH),
      };
    }
    default:
      return null;
  }
}

/**
 * Valida y reconstruye un item (de una op o de un JSON). El `id` del item se
 * fuerza a ser el del contenido que envuelve. `null` si no es valido.
 */
export function sanitizeEditItem(raw: unknown): EditItem | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "text": {
      const edit = parseTextEdit(raw.edit);
      return edit ? { kind: "text", id: edit.id, edit } : null;
    }
    case "image": {
      const element = parseImageRef(raw.element);
      return element ? { kind: "image", id: element.id, element } : null;
    }
    case "shape": {
      const element = parseShapeElement(raw.element);
      return element ? { kind: "shape", id: element.id, element } : null;
    }
    case "flatten": {
      if (typeof raw.id !== "string" || raw.id.length === 0) return null;
      if (!Number.isInteger(raw.pageIndex) || (raw.pageIndex as number) < 0) return null;
      return { kind: "flatten", id: raw.id, pageIndex: raw.pageIndex as number };
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * Comparacion y utilidades
 * ------------------------------------------------------------------ */

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  const recA = a as Record<string, unknown>;
  const recB = b as Record<string, unknown>;
  return keysA.every(
    (key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(recA[key], recB[key]),
  );
}

export function itemPageIndex(item: EditItem): number {
  if (item.kind === "text") return item.edit.pageIndex;
  if (item.kind === "flatten") return item.pageIndex;
  return item.element.pageIndex;
}

let idCounter = 0;

/** Id nuevo para un item o un asset (unico dentro de la pagina; no criptografico). */
export function newEditId(prefix = "ed"): string {
  idCounter += 1;
  const random = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${idCounter.toString(36)}${random}`;
}

/* ------------------------------------------------------------------ *
 * Constructores de items y ops (comodidad para la interfaz)
 * ------------------------------------------------------------------ */

export function textItem(edit: TextEdit): EditTextItem {
  return { kind: "text", id: edit.id, edit };
}

export function shapeItem(element: EditShapeElement): EditShapeItem {
  return { kind: "shape", id: element.id, element };
}

/** «Aplanar pagina» (`pageIndex` base 0). Se anade con la op `add`. */
export function flattenItem(pageIndex: number): EditFlattenItem {
  return { kind: "flatten", id: newEditId("fl"), pageIndex };
}

/** Paginas que se aplanaran al exportar, ordenadas y sin repetidos. */
export function flattenedPages(session: Pick<EditSession, "items">): number[] {
  const pages = new Set<number>();
  for (const item of session.items) if (item.kind === "flatten") pages.add(item.pageIndex);
  return [...pages].sort((a, b) => a - b);
}

/** El item de aplanado de una pagina, si existe. */
export function findFlattenItem(
  session: Pick<EditSession, "items">,
  pageIndex: number,
): EditFlattenItem | undefined {
  return session.items.find(
    (item): item is EditFlattenItem => item.kind === "flatten" && item.pageIndex === pageIndex,
  );
}

/** Texto NUEVO (sin bloque original): sin cubrir nada. */
export function newTextEdit(
  init: Pick<TextEdit, "pageIndex" | "box" | "fontKey"> & Partial<TextEdit>,
): TextEdit {
  return {
    id: newEditId("tx"),
    text: "",
    fontSize: 12,
    color: "#000000",
    align: "left",
    bold: false,
    italic: false,
    rotation: 0,
    cover: { color: null, padding: 0 },
    ...init,
  };
}

/**
 * Edicion que REEMPLAZA un bloque existente: cubre su caja original y redibuja
 * `text` (por defecto, el mismo). `fontKey` y `cover` los decide quien llama
 * (mapeo de fuentes y muestreo del fondo viven en `editFonts`/`editTextExport`).
 */
export function blockToTextEdit(
  block: TextBlock,
  init: {
    fontKey: CatalogFontKey;
    cover: CoverSpec;
    text?: string;
    id?: string;
    /** Cajas de los bloques vecinos: la cobertura no las tapa. */
    neighbors?: readonly { id?: string; box: UserBox }[];
    /** Franjas de borde fino que la cobertura no pisa (ver `TextEdit.coverClip`). */
    clip?: readonly UserBox[];
  },
): TextEdit {
  // Cobertura ampliada con las metricas de acentos y colas (D4); si el texto
  // esta girado un angulo libre, ademas su rectangulo orientado (D1).
  const cover = coverForBlock(block, init.neighbors ?? [], init.clip ?? []);
  return {
    id: init.id ?? newEditId("tx"),
    blockId: block.id,
    pageIndex: block.pageIndex,
    box: { ...block.box },
    coverBox: cover.box,
    ...(cover.oriented ? { coverOriented: cover.oriented } : {}),
    ...(init.clip && init.clip.length > 0 ? { coverClip: init.clip.map((b) => ({ ...b })) } : {}),
    text: init.text ?? block.text,
    fontSize: block.fontSize,
    color: block.color,
    align: block.align,
    fontKey: init.fontKey,
    bold: block.font.bold,
    italic: block.font.italic,
    rotation: block.rotation,
    cover: init.cover,
    ...(block.mixedStyle === true ? { mixedStyle: true as const } : {}),
  };
}

/**
 * Op `add` para una imagen subida. El `assetId` es el id del elemento salvo que
 * se indique otro; los bytes viajan UNA vez, en la op, y quedan en `assets`.
 */
export function imageAddOp(element: ImageElement, assetId?: string): EditOp {
  const id = assetId ?? element.id;
  const { bytes, previewUrl, ...rest } = element;
  return {
    type: "add",
    item: { kind: "image", id: element.id, element: { ...rest, assetId: id } },
    asset: { bytes, previewUrl },
  };
}

/* ------------------------------------------------------------------ *
 * Sesion: creacion, consultas
 * ------------------------------------------------------------------ */

export function createEditSession(): EditSession {
  return {
    schema: EDIT_SESSION_SCHEMA,
    items: [],
    assets: {},
    history: [],
    cursor: 0,
    selectedId: null,
    group: null,
  };
}

export function canUndo(session: EditSession): boolean {
  return session.cursor > 0;
}

export function canRedo(session: EditSession): boolean {
  return session.cursor < session.history.length;
}

export function getItem(session: EditSession, id: string): EditItem | undefined {
  return session.items.find((item) => item.id === id);
}

export function getSelectedItem(session: EditSession): EditItem | null {
  return session.selectedId === null ? null : (getItem(session, session.selectedId) ?? null);
}

/** Items de una pagina, en orden de creacion (lo ultimo, encima). */
export function itemsOnPage(session: EditSession, pageIndex: number): EditItem[] {
  return session.items.filter((item) => itemPageIndex(item) === pageIndex);
}

/** La edicion que reemplaza un bloque dado, si existe. */
export function findEditForBlock(
  session: EditSession,
  blockId: string,
): EditTextItem | undefined {
  return session.items.find(
    (item): item is EditTextItem => item.kind === "text" && item.edit.blockId === blockId,
  );
}

function producesChange(item: EditItem): boolean {
  if (item.kind !== "text") return true; // imagen, forma o aplanado
  // Reemplazar un bloque cambia la pagina aunque el texto quede vacio (borra el
  // original); un texto nuevo vacio no pinta nada.
  return item.edit.blockId !== undefined || item.edit.text.trim().length > 0;
}

/** Cambios que de verdad se aplicarian al exportar (texto nuevo vacio no cuenta). */
export function pendingChangeCount(session: EditSession): number {
  return session.items.reduce((sum, item) => sum + (producesChange(item) ? 1 : 0), 0);
}

/**
 * Parte la sesion para los dos motores de exportacion: `textEdits` (motor nuevo)
 * y `elements` (`applyEdits` de `editPdf.ts`). Conserva el orden de creacion
 * dentro de cada lista; el orden relativo ENTRE listas lo decide el exportador.
 */
export function splitForExport(session: EditSession): {
  textEdits: TextEdit[];
  elements: EditElement[];
  /** (W5-U5) Paginas (base 0) que se aplanan DESPUES de aplicar lo demas. */
  flattenPages: number[];
} {
  const textEdits: TextEdit[] = [];
  const elements: EditElement[] = [];
  for (const item of session.items) {
    if (!producesChange(item)) continue;
    if (item.kind === "text") {
      textEdits.push(item.edit);
    } else if (item.kind === "shape") {
      elements.push(item.element);
    } else if (item.kind === "image") {
      const asset = session.assets[item.element.assetId];
      if (!asset) continue;
      const { assetId: _assetId, ...rest } = item.element;
      void _assetId;
      elements.push({ ...rest, bytes: asset.bytes, previewUrl: asset.previewUrl });
    }
  }
  return { textEdits, elements, flattenPages: flattenedPages(session) };
}

/* ------------------------------------------------------------------ *
 * Transformaciones de un item por cada op
 * ------------------------------------------------------------------ */

function applyUpdate(item: EditItem, patch: UpdatePatch): EditItem {
  if (item.kind !== "text" || typeof patch.text !== "string") return item;
  if (patch.text.length > EDIT_MAX_TEXT_LENGTH) return item;
  return { ...item, edit: { ...item.edit, text: patch.text } };
}

function applyMove(item: EditItem, dx: number, dy: number): EditItem {
  if (item.kind === "flatten") return item;
  if (!isFiniteNumber(dx) || !isFiniteNumber(dy)) return item;
  if (item.kind === "text") {
    const { box } = item.edit;
    return {
      ...item,
      edit: { ...item.edit, box: { ...box, x: box.x + dx, y: box.y + dy } },
    };
  }
  if (item.kind === "image") {
    const el = item.element;
    return {
      ...item,
      element: {
        ...el,
        x: clamp(el.x + dx, 0, 1 - el.width),
        y: clamp(el.y + dy, 0, 1 - el.height),
      },
    };
  }
  const el = item.element;
  if (el.type === "line") {
    // Un desplazamiento unico para toda la linea, recortado para que ambos extremos queden en la pagina.
    const sx = clamp(dx, -Math.min(el.x1, el.x2), 1 - Math.max(el.x1, el.x2));
    const sy = clamp(dy, -Math.min(el.y1, el.y2), 1 - Math.max(el.y1, el.y2));
    return {
      ...item,
      element: { ...el, x1: el.x1 + sx, x2: el.x2 + sx, y1: el.y1 + sy, y2: el.y2 + sy },
    };
  }
  return {
    ...item,
    element: {
      ...el,
      x: clamp(el.x + dx, 0, 1 - el.width),
      y: clamp(el.y + dy, 0, 1 - el.height),
    },
  };
}

function applyResize(item: EditItem, box: ItemBox): EditItem {
  if (item.kind === "flatten") return item;
  if (
    !isFiniteNumber(box.x) ||
    !isFiniteNumber(box.y) ||
    !isFiniteNumber(box.width) ||
    !isFiniteNumber(box.height)
  ) {
    return item;
  }
  if (item.kind === "text") {
    const width = Math.max(box.width, 1);
    const height = Math.max(box.height, 1);
    return {
      ...item,
      edit: { ...item.edit, box: { x: box.x, y: box.y, width, height } },
    };
  }
  const x = clamp(box.x, 0, 1 - MIN_ELEMENT_SIDE);
  const y = clamp(box.y, 0, 1 - MIN_ELEMENT_SIDE);
  const width = clamp(box.width, MIN_ELEMENT_SIDE, 1 - x);
  const height = clamp(box.height, MIN_ELEMENT_SIDE, 1 - y);
  if (item.kind === "image") {
    return { ...item, element: { ...item.element, x, y, width, height } };
  }
  const el = item.element;
  if (el.type === "line") {
    // Conserva el sentido de la linea: el extremo que estaba a la izquierda/arriba sigue ahi.
    const left = el.x1 <= el.x2;
    const top = el.y1 <= el.y2;
    return {
      ...item,
      element: {
        ...el,
        x1: left ? x : x + width,
        x2: left ? x + width : x,
        y1: top ? y : y + height,
        y2: top ? y + height : y,
      },
    };
  }
  return { ...item, element: { ...el, x, y, width, height } };
}

/** Solo lineas: sustituye los dos extremos (la validacion final descarta lo invalido). */
function applyReshape(item: EditItem, points: LinePoints): EditItem {
  if (item.kind !== "shape" || item.element.type !== "line") return item;
  const { x1, y1, x2, y2 } = points;
  if (![x1, y1, x2, y2].every(isFiniteNumber)) return item;
  return {
    ...item,
    element: {
      ...item.element,
      x1: clamp(x1, 0, 1),
      y1: clamp(y1, 0, 1),
      x2: clamp(x2, 0, 1),
      y2: clamp(y2, 0, 1),
    },
  };
}

/** Aplica solo las claves validas del parche; devuelve tambien cuales se aceptaron. */
function applyRestyle(
  item: EditItem,
  patch: RestylePatch,
): { item: EditItem; keys: string[] } {
  const keys: string[] = [];
  const p = isRecord(patch) ? (patch as Record<string, unknown>) : {};

  if (item.kind === "text") {
    const next: TextEdit = { ...item.edit };
    if (isFiniteNumber(p.fontSize) && p.fontSize >= MIN_TEXT_FONT_SIZE && p.fontSize <= MAX_TEXT_FONT_SIZE) {
      next.fontSize = p.fontSize;
      keys.push("fontSize");
    }
    const color = hex(p.color);
    if (color) {
      next.color = color;
      keys.push("color");
    }
    if (TEXT_ALIGNS.includes(p.align as TextAlign)) {
      next.align = p.align as TextAlign;
      keys.push("align");
    }
    if (CATALOG_FONT_KEYS.includes(p.fontKey as CatalogFontKey)) {
      next.fontKey = p.fontKey as CatalogFontKey;
      keys.push("fontKey");
    }
    if (typeof p.bold === "boolean") {
      next.bold = p.bold;
      keys.push("bold");
    }
    if (typeof p.italic === "boolean") {
      next.italic = p.italic;
      keys.push("italic");
    }
    if (isFiniteNumber(p.rotation)) {
      next.rotation = p.rotation;
      keys.push("rotation");
    }
    if (isFiniteNumber(p.lineHeight) && p.lineHeight > 0 && p.lineHeight <= 10) {
      next.lineHeight = p.lineHeight;
      keys.push("lineHeight");
    }
    const cover = p.cover === undefined ? null : parseCover(p.cover);
    if (cover) {
      next.cover = cover;
      keys.push("cover");
    }
    return { item: keys.length > 0 ? { ...item, edit: next } : item, keys };
  }

  if (item.kind === "image" || item.kind === "flatten") return { item, keys };

  const el = item.element;
  const next = { ...el } as Record<string, unknown>;
  const accept = (key: string, value: unknown) => {
    next[key] = value;
    keys.push(key);
  };
  const strokeColor = hex(p.strokeColor);
  const fillColor = hex(p.fillColor);
  const color = hex(p.color);

  if (el.type === "rect" || el.type === "ellipse") {
    if (strokeColor) accept("strokeColor", strokeColor);
    if (isFiniteNumber(p.strokeWidth)) accept("strokeWidth", clamp(p.strokeWidth, 0, MAX_STROKE_WIDTH));
    if (typeof p.fill === "boolean") accept("fill", p.fill);
    if (fillColor) accept("fillColor", fillColor);
    if (isFiniteNumber(p.fillOpacity)) accept("fillOpacity", clamp(p.fillOpacity, 0.05, 1));
  } else if (el.type === "line") {
    if (strokeColor) accept("strokeColor", strokeColor);
    if (isFiniteNumber(p.strokeWidth)) {
      accept("strokeWidth", clamp(p.strokeWidth, MIN_STROKE_WIDTH, MAX_STROKE_WIDTH));
    }
  } else if (el.type === "check") {
    if (strokeColor) accept("strokeColor", strokeColor);
    if (isFiniteNumber(p.strokeWidth)) {
      accept("strokeWidth", clamp(p.strokeWidth, MIN_STROKE_WIDTH, MAX_STROKE_WIDTH));
    }
    if (CHECK_MARKS.includes(p.mark as CheckMark)) accept("mark", p.mark);
  } else if (el.type === "highlight") {
    if (color) accept("color", color);
    if (isFiniteNumber(p.opacity)) accept("opacity", clamp(p.opacity, 0.05, 1));
  }
  return {
    item: keys.length > 0 ? ({ ...item, element: next } as EditItem) : item,
    keys,
  };
}

/* ------------------------------------------------------------------ *
 * Aplicar, deshacer, rehacer
 * ------------------------------------------------------------------ */

function referencedAssetIds(
  items: readonly EditItem[],
  history: readonly HistoryEntry[],
): Set<string> {
  const ids = new Set<string>();
  const scan = (list: readonly EditItem[]) => {
    for (const item of list) if (item.kind === "image") ids.add(item.element.assetId);
  };
  scan(items);
  for (const entry of history) {
    scan(entry.before);
    scan(entry.after);
  }
  return ids;
}

function pruneAssets(
  assets: Readonly<Record<string, ImageAsset>>,
  items: readonly EditItem[],
  history: readonly HistoryEntry[],
): Readonly<Record<string, ImageAsset>> {
  const keep = referencedAssetIds(items, history);
  const ids = Object.keys(assets);
  if (ids.every((id) => keep.has(id))) return assets;
  const next: Record<string, ImageAsset> = {};
  for (const id of ids) if (keep.has(id)) next[id] = assets[id];
  return next;
}

function fixSelection(selectedId: string | null, items: readonly EditItem[]): string | null {
  return selectedId !== null && items.some((item) => item.id === selectedId)
    ? selectedId
    : null;
}

function isValidAsset(value: unknown): value is ImageAsset {
  return (
    isRecord(value) &&
    asBytes(value.bytes) !== null &&
    (value.bytes as Uint8Array).byteLength >= 4 &&
    typeof value.previewUrl === "string"
  );
}

/**
 * Aplica una op y devuelve la sesion nueva. Una op invalida o que no cambia nada
 * devuelve LA MISMA sesion (misma referencia, sin entrada de historial). Nunca lanza.
 * `now` (ms) se inyecta para que el agrupado sea determinista.
 */
export function applyOp(
  session: EditSession,
  op: EditOp,
  now: number = Date.now(),
): EditSession {
  if (!isRecord(op) || !isFiniteNumber(now)) return session;

  let nextItems: readonly EditItem[] = session.items;
  let nextAssets = session.assets;
  let itemId: string;
  let groupKey: string | null = null;
  let selectedId = session.selectedId;

  switch (op.type) {
    case "add": {
      const item = sanitizeEditItem(op.item);
      if (!item) return session;
      if (session.items.length >= EDIT_MAX_ITEMS) return session;
      if (session.items.some((existing) => existing.id === item.id)) return session;
      // Una edicion con numeros no finitos (NaN, Infinity) nunca entra: el exportador no recibe basura.
      if (item.kind === "text" && !hasFiniteGeometry(item.edit)) return session;
      // Aplanar dos veces la misma pagina no cambia nada.
      if (item.kind === "flatten" && findFlattenItem(session, item.pageIndex)) return session;
      if (item.kind === "image") {
        const assetId = item.element.assetId;
        if (op.asset !== undefined && isValidAsset(op.asset) && !session.assets[assetId]) {
          nextAssets = { ...session.assets, [assetId]: op.asset };
        } else if (!nextAssets[assetId]) {
          return session;
        }
      }
      nextItems = [...session.items, item];
      itemId = item.id;
      selectedId = item.id;
      // (W5-U5) Un texto nace con su primer cambio real y se sigue escribiendo: el `add` abre el grupo del
      // tecleo de ESE item, asi los `update` seguidos se funden con el en UNA entrada (un Ctrl+Z devuelve el
      // bloque al original, un Ctrl+Y a lo ultimo escrito).
      if (item.kind === "text") groupKey = `u:${item.id}`;
      break;
    }
    case "remove": {
      if (!session.items.some((item) => item.id === op.id)) return session;
      nextItems = session.items.filter((item) => item.id !== op.id);
      itemId = op.id;
      if (selectedId === op.id) selectedId = null;
      break;
    }
    case "update":
    case "move":
    case "resize":
    case "reshape":
    case "restyle": {
      const index = session.items.findIndex((item) => item.id === op.id);
      if (index < 0) return session;
      const current = session.items[index];
      let changed: EditItem;
      if (op.type === "update") {
        changed = applyUpdate(current, isRecord(op.patch) ? op.patch : {});
        groupKey = `u:${op.id}`;
      } else if (op.type === "move") {
        changed = applyMove(current, op.dx, op.dy);
      } else if (op.type === "resize") {
        changed = isRecord(op.box) ? applyResize(current, op.box) : current;
      } else if (op.type === "reshape") {
        changed = isRecord(op.points) ? applyReshape(current, op.points) : current;
      } else {
        const result = applyRestyle(current, op.patch);
        changed = result.item;
        groupKey = `r:${op.id}:${[...result.keys].sort().join(",")}`;
      }
      const clean = sanitizeEditItem(changed);
      if (!clean || deepEqual(clean, current)) return session;
      nextItems = session.items.map((item, i) => (i === index ? clean : item));
      itemId = op.id;
      break;
    }
    default:
      return session;
  }

  const grouped =
    groupKey !== null &&
    session.group !== null &&
    session.group.key === groupKey &&
    now - session.group.at <= EDIT_GROUP_WINDOW_MS &&
    now >= session.group.at &&
    session.cursor === session.history.length &&
    session.cursor > 0;

  let history: readonly HistoryEntry[];
  let cursor: number;
  // Descartar lo rehacible o lo mas antiguo deja assets que ya nadie reclama.
  let needsPrune = false;
  if (grouped) {
    const last = session.history[session.cursor - 1];
    history = [...session.history.slice(0, -1), { ...last, after: nextItems, at: now }];
    cursor = session.cursor;
  } else {
    const entry: HistoryEntry = {
      op: op.type,
      itemId,
      before: session.items,
      after: nextItems,
      at: now,
    };
    const kept = [...session.history.slice(0, session.cursor), entry];
    needsPrune = session.cursor < session.history.length || kept.length > EDIT_HISTORY_LIMIT;
    history = kept.length > EDIT_HISTORY_LIMIT ? kept.slice(kept.length - EDIT_HISTORY_LIMIT) : kept;
    cursor = history.length;
  }
  const assets = needsPrune ? pruneAssets(nextAssets, nextItems, history) : nextAssets;

  return {
    ...session,
    items: nextItems,
    assets,
    history,
    cursor,
    selectedId: fixSelection(selectedId, nextItems),
    group: groupKey === null ? null : { key: groupKey, at: now },
  };
}

export function undo(session: EditSession): EditSession {
  if (session.cursor <= 0) return session;
  const entry = session.history[session.cursor - 1];
  return {
    ...session,
    items: entry.before,
    cursor: session.cursor - 1,
    selectedId: fixSelection(session.selectedId, entry.before),
    group: null,
  };
}

export function redo(session: EditSession): EditSession {
  if (session.cursor >= session.history.length) return session;
  const entry = session.history[session.cursor];
  return {
    ...session,
    items: entry.after,
    cursor: session.cursor + 1,
    selectedId: fixSelection(session.selectedId, entry.after),
    group: null,
  };
}

/** Selecciona un item (o ninguno). No entra en el historial. Un id inexistente deselecciona. */
export function selectItem(session: EditSession, id: string | null): EditSession {
  const next = id !== null && session.items.some((item) => item.id === id) ? id : null;
  return next === session.selectedId ? session : { ...session, selectedId: next };
}

/**
 * «Descartar todos los cambios»: devuelve una sesion vacia SIN historial (no se
 * puede deshacer; la interfaz debe pedir confirmacion si hay cambios).
 */
export function resetSession(session: EditSession): EditSession {
  if (session.items.length === 0 && session.history.length === 0 && session.selectedId === null) {
    return session;
  }
  return createEditSession();
}

/* ------------------------------------------------------------------ *
 * Serializacion
 * ------------------------------------------------------------------ */

export type SerializedAsset = {
  mime: "image/png" | "image/jpeg";
  /** Bytes de la imagen. */
  size: number;
  /** Base64 de la imagen; ausente cuando los bytes viajan aparte (borradores). */
  data?: string;
};

export type SerializedEditSession = {
  schema: typeof EDIT_SESSION_SCHEMA;
  items: EditItem[];
  assets: Record<string, SerializedAsset>;
};

export function detectImageMime(bytes: Uint8Array): "image/png" | "image/jpeg" | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return null;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(data: string): Uint8Array | null {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Base64 ya calculado por asset: el autoguardado serializa a menudo y no debe recodificar. */
const base64Cache = new WeakMap<ImageAsset, string>();

function base64Of(asset: ImageAsset): string {
  let data = base64Cache.get(asset);
  if (data === undefined) {
    data = bytesToBase64(asset.bytes);
    base64Cache.set(asset, data);
  }
  return data;
}

/** Imagenes que de verdad usan los items actuales (id -> bytes), para guardarlas aparte. */
export function referencedAssets(
  session: EditSession,
): { assetId: string; bytes: Uint8Array }[] {
  const seen = new Set<string>();
  const list: { assetId: string; bytes: Uint8Array }[] = [];
  for (const item of session.items) {
    if (item.kind !== "image") continue;
    const { assetId } = item.element;
    const asset = session.assets[assetId];
    if (!asset || seen.has(assetId) || detectImageMime(asset.bytes) === null) continue;
    seen.add(assetId);
    list.push({ assetId, bytes: asset.bytes });
  }
  return list;
}

/**
 * Estado serializable de la sesion (sin historial: un borrador restaura el
 * estado actual, no la pila de deshacer). Con `inlineAssets: false` las
 * imagenes no se incluyen (solo su tipo y tamano): quien guarda las lleva
 * aparte con `referencedAssets` (asi un autoguardado no reescribe megas).
 */
export function editSessionToJSON(
  session: EditSession,
  options: { inlineAssets?: boolean } = {},
): SerializedEditSession {
  const inline = options.inlineAssets ?? true;
  const usable = new Map(referencedAssets(session).map((a) => [a.assetId, a]));
  const assets: Record<string, SerializedAsset> = {};
  const items: EditItem[] = [];
  for (const item of session.items) {
    if (item.kind === "image") {
      const found = usable.get(item.element.assetId);
      if (!found) continue; // Imagen sin bytes validos: no se puede exportar, no se guarda.
      if (!assets[found.assetId]) {
        const asset = session.assets[found.assetId];
        assets[found.assetId] = {
          mime: detectImageMime(found.bytes) as "image/png" | "image/jpeg",
          size: found.bytes.byteLength,
          ...(inline ? { data: base64Of(asset) } : {}),
        };
      }
    }
    items.push(item);
  }
  return { schema: EDIT_SESSION_SCHEMA, items, assets };
}

export type EditSessionFromJSONOptions = {
  /** Si se conoce, los items de paginas que ya no existen se descartan. */
  pageCount?: number;
  /** Bytes de las imagenes guardadas aparte (`inlineAssets: false`). */
  assetBytes?:
    | Readonly<Record<string, Uint8Array | undefined>>
    | ((assetId: string) => Uint8Array | undefined);
};

export type EditSessionFromJSONResult = {
  session: EditSession;
  /** Items que no pasaron la validacion (o cuyo asset falta) y se descartaron. */
  discarded: number;
  /**
   * `ok`: todo se recupero; `partial`: se descarto algo; `invalid`: la raiz no
   * es una sesion (se devuelve una sesion vacia); `unsupported`: `schema` desconocido.
   */
  status: "ok" | "partial" | "invalid" | "unsupported";
};

function resolveAssetBytes(
  assetId: string,
  entry: Record<string, unknown>,
  options: EditSessionFromJSONOptions,
): Uint8Array | null {
  if (typeof entry.data === "string") return base64ToBytes(entry.data);
  const source = options.assetBytes;
  if (!source) return null;
  const found = typeof source === "function" ? source(assetId) : source[assetId];
  return asBytes(found);
}

/**
 * Reconstruye una sesion desde JSON (objeto o texto). Valida TODO: lo que no pase
 * se descarta sin lanzar y se cuenta en `discarded`. El historial arranca vacio.
 */
export function editSessionFromJSON(
  raw: unknown,
  options: EditSessionFromJSONOptions = {},
): EditSessionFromJSONResult {
  const empty = (status: "invalid" | "unsupported"): EditSessionFromJSONResult => ({
    session: createEditSession(),
    discarded: 0,
    status,
  });

  let root: unknown = raw;
  if (typeof raw === "string") {
    try {
      root = JSON.parse(raw);
    } catch {
      return empty("invalid");
    }
  }
  if (!isRecord(root)) return empty("invalid");
  if (root.schema !== EDIT_SESSION_SCHEMA) {
    return empty(typeof root.schema === "number" ? "unsupported" : "invalid");
  }
  if (!Array.isArray(root.items)) return empty("invalid");

  // Assets validos: id correcto, tipo conocido, bytes que de verdad son esa imagen.
  const assets: Record<string, ImageAsset> = {};
  if (isRecord(root.assets)) {
    for (const [assetId, entry] of Object.entries(root.assets)) {
      if (!ASSET_ID.test(assetId) || !isRecord(entry)) continue;
      if (entry.mime !== "image/png" && entry.mime !== "image/jpeg") continue;
      const bytes = resolveAssetBytes(assetId, entry, options);
      if (!bytes || detectImageMime(bytes) !== entry.mime) continue;
      assets[assetId] = {
        bytes,
        previewUrl: `data:${entry.mime};base64,${bytesToBase64(bytes)}`,
      };
    }
  }

  const items: EditItem[] = [];
  const ids = new Set<string>();
  let discarded = 0;
  for (const rawItem of root.items) {
    const item = sanitizeEditItem(rawItem);
    const outOfRange =
      item !== null &&
      options.pageCount !== undefined &&
      itemPageIndex(item) >= options.pageCount;
    if (
      !item ||
      outOfRange ||
      ids.has(item.id) ||
      items.length >= EDIT_MAX_ITEMS ||
      (item.kind === "image" && !assets[item.element.assetId])
    ) {
      discarded += 1;
      continue;
    }
    ids.add(item.id);
    items.push(item);
  }

  const used = new Set(
    items.flatMap((item) => (item.kind === "image" ? [item.element.assetId] : [])),
  );
  const keptAssets: Record<string, ImageAsset> = {};
  for (const id of used) keptAssets[id] = assets[id];

  return {
    session: { ...createEditSession(), items, assets: keptAssets },
    discarded,
    status: discarded > 0 ? "partial" : "ok",
  };
}

export { editSessionToJSON as toJSON, editSessionFromJSON as fromJSON };
