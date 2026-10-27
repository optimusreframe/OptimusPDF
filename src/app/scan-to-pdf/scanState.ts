import type {
  ScanFilterMode,
  ScanPage,
  ScanPageAdjust,
  ScanPageFlags,
  ScanRotation,
  ScanSession,
  ScanSettings,
} from "@/lib/scan/types";
import { DEFAULT_SCAN_SETTINGS } from "@/lib/scan/types";
import type { QuadCorners } from "@/lib/scan/perspective";

/*
 * Modelo PURO de la sesion del Escaner (sin React ni DOM): operaciones sobre la lista de paginas y un historial
 * deshacer/rehacer de las operaciones de ORGANIZACION (mover, girar, borrar, duplicar, filtro, recorte, repetir captura,
 * insertar...). Lo que llega del motor en segundo plano (miniaturas, avisos de calidad) se aplica a la pagina en el presente Y
 * en todas las instantaneas del historial, sin crear entradas: deshacer nunca "pierde" una miniatura ya calculada.
 */

export const HISTORY_LIMIT = 60;
/** Dos operaciones con la misma clave de fusion separadas menos de esto cuentan como un solo paso de deshacer. */
export const COALESCE_MS = 2000;

/* ------------------------------------------------------------------ *
 * Operaciones sobre la lista (todas devuelven una lista NUEVA)
 * ------------------------------------------------------------------ */

const ROTATIONS: ScanRotation[] = [0, 90, 180, 270];

export function normalizeRotation(value: number): ScanRotation {
  const turn = (((Math.round(value / 90) * 90) % 360) + 360) % 360;
  return ROTATIONS.includes(turn as ScanRotation) ? (turn as ScanRotation) : 0;
}

/** Clave de lo que cambia el resultado procesado de una pagina: si cambia, hay que volver a pedir `renderPage`. */
export function renderKeyOf(page: ScanPage): string {
  const c = page.corners;
  const corners = c
    ? [c.topLeft, c.topRight, c.bottomRight, c.bottomLeft].map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`).join(";")
    : "-";
  return `${page.rotation}|${page.filter}|${page.adjust.brightness.toFixed(3)}|${page.adjust.contrast.toFixed(3)}|${corners}`;
}

export function indexOfId(pages: readonly ScanPage[], id: string): number {
  return pages.findIndex((page) => page.id === id);
}

/** Mueve las paginas `ids` (en su orden relativo actual) para que queden ANTES de la posicion `insertBefore` (0..n) de la lista actual. */
export function movePages(pages: readonly ScanPage[], ids: readonly string[], insertBefore: number): ScanPage[] {
  const set = new Set(ids);
  const moved = pages.filter((page) => set.has(page.id));
  if (moved.length === 0) return [...pages];
  const clamped = Math.max(0, Math.min(pages.length, insertBefore));
  let before = 0;
  for (let index = 0; index < clamped; index += 1) if (set.has(pages[index].id)) before += 1;
  const rest = pages.filter((page) => !set.has(page.id));
  const at = clamped - before;
  return [...rest.slice(0, at), ...moved, ...rest.slice(at)];
}

/** Desplaza las paginas `ids` `delta` puestos (teclado, «Subir»/«Bajar»); los extremos topan sin saltarse a las demas. */
export function shiftPages(pages: readonly ScanPage[], ids: readonly string[], delta: number): ScanPage[] {
  const set = new Set(ids);
  const result = [...pages];
  const order = delta < 0 ? result.map((_, index) => index) : result.map((_, index) => result.length - 1 - index);
  for (const index of order) {
    if (!set.has(result[index].id)) continue;
    const target = index + (delta < 0 ? -1 : 1);
    if (target < 0 || target >= result.length || set.has(result[target].id)) continue;
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

export function removePages(pages: readonly ScanPage[], ids: readonly string[]): ScanPage[] {
  const set = new Set(ids);
  return pages.filter((page) => !set.has(page.id));
}

/** Copia cada pagina indicada justo despues de la original (el id nuevo lo da `makeId`). Las copias no heredan `duplicateOf`. */
export function duplicatePages(pages: readonly ScanPage[], ids: readonly string[], makeId: () => string): ScanPage[] {
  const set = new Set(ids);
  const out: ScanPage[] = [];
  for (const page of pages) {
    out.push(page);
    if (set.has(page.id)) {
      const flags = { ...page.flags };
      delete flags.duplicateOf;
      out.push({ ...page, id: makeId(), flags });
    }
  }
  return out;
}

export function rotatePages(pages: readonly ScanPage[], ids: readonly string[], delta: number): ScanPage[] {
  const set = new Set(ids);
  return pages.map((page) => (set.has(page.id) ? { ...page, rotation: normalizeRotation(page.rotation + delta) } : page));
}

export function setFilterOn(pages: readonly ScanPage[], ids: readonly string[], filter: ScanFilterMode): ScanPage[] {
  const set = new Set(ids);
  return pages.map((page) => (set.has(page.id) && page.filter !== filter ? { ...page, filter } : page));
}

export function setAdjustOn(pages: readonly ScanPage[], ids: readonly string[], adjust: ScanPageAdjust): ScanPage[] {
  const set = new Set(ids);
  return pages.map((page) => (set.has(page.id) ? { ...page, adjust: { ...adjust } } : page));
}

export function setCornersOn(pages: readonly ScanPage[], id: string, corners: QuadCorners | null): ScanPage[] {
  return pages.map((page) => {
    if (page.id !== id) return page;
    const flags = { ...page.flags };
    delete flags.noDocument;
    return { ...page, corners, flags };
  });
}

export function replacePage(pages: readonly ScanPage[], id: string, next: ScanPage): ScanPage[] {
  return pages.map((page) => (page.id === id ? next : page));
}

export function insertPages(pages: readonly ScanPage[], at: number, added: readonly ScanPage[]): ScanPage[] {
  const clamped = Math.max(0, Math.min(pages.length, at));
  return [...pages.slice(0, clamped), ...added, ...pages.slice(clamped)];
}

/* ------------------------------------------------------------------ *
 * Avisos de calidad por pagina
 * ------------------------------------------------------------------ */

export type QualityChipKind = "blank" | "blurry" | "glare" | "dark" | "duplicate" | "noDocument";

/** Orden de importancia: el primero es el que se muestra primero (en tarjetas estrechas, solo cabe uno o dos). */
export const QUALITY_ORDER: QualityChipKind[] = ["blank", "duplicate", "blurry", "glare", "dark", "noDocument"];

export function qualityKinds(flags: ScanPageFlags): QualityChipKind[] {
  const found: QualityChipKind[] = [];
  if (flags.blank) found.push("blank");
  if (flags.duplicateOf) found.push("duplicate");
  if (flags.blurry) found.push("blurry");
  if (flags.glare) found.push("glare");
  if (flags.dark) found.push("dark");
  if (flags.noDocument) found.push("noDocument");
  return found;
}

export function blankPageIds(pages: readonly ScanPage[]): string[] {
  return pages.filter((page) => page.flags.blank).map((page) => page.id);
}

export function clearFlag(pages: readonly ScanPage[], id: string, kind: QualityChipKind): ScanPage[] {
  return pages.map((page) => {
    if (page.id !== id) return page;
    const flags = { ...page.flags };
    if (kind === "blank") delete flags.blank;
    if (kind === "duplicate") delete flags.duplicateOf;
    if (kind === "blurry") delete flags.blurry;
    if (kind === "glare") delete flags.glare;
    if (kind === "dark") delete flags.dark;
    if (kind === "noDocument") delete flags.noDocument;
    return { ...page, flags };
  });
}

/* ------------------------------------------------------------------ *
 * Estado con historial
 * ------------------------------------------------------------------ */

type Snapshot = { pages: ScanPage[]; label: string; key?: string; at?: number };

export type ScanState = {
  id: string;
  createdAt: string;
  name: string;
  /** El nombre lo escribio la persona (o venia de una sesion guardada con nombre): no se vuelve a proponer encima. */
  nameEdited: boolean;
  nameSuggested?: ScanSession["nameSuggested"];
  settings: ScanSettings;
  pages: ScanPage[];
  past: Snapshot[];
  future: Snapshot[];
  /** Paginas que aun se estan creando en el motor (su sitio ya esta reservado). */
  pendingIds: string[];
  /** Cambia con cada modificacion que merece guardarse (el guardado automatico mira esto). */
  rev: number;
};

export function emptyState(id: string, now: string, settings: ScanSettings = DEFAULT_SCAN_SETTINGS): ScanState {
  return { id, createdAt: now, name: "", nameEdited: false, settings, pages: [], past: [], future: [], pendingIds: [], rev: 0 };
}

export function stateFromSession(session: ScanSession): ScanState {
  return {
    id: session.id,
    createdAt: session.createdAt,
    name: session.name,
    nameEdited: session.name.trim() !== "",
    nameSuggested: session.nameSuggested,
    settings: { ...DEFAULT_SCAN_SETTINGS, ...session.settings },
    pages: session.pages,
    past: [],
    future: [],
    pendingIds: [],
    rev: 0,
  };
}

export function sessionFromState(state: ScanState, updatedAt: string): ScanSession {
  return {
    id: state.id,
    createdAt: state.createdAt,
    updatedAt,
    name: state.name,
    nameSuggested: state.nameSuggested,
    pages: state.pages,
    settings: state.settings,
  };
}

export type ScanAction =
  | { type: "load"; session: ScanSession }
  | { type: "reset"; id: string; now: string; settings?: ScanSettings }
  /** Operacion de organizacion: guarda una entrada de historial con `label`. */
  | { type: "commit"; pages: ScanPage[]; label: string; pending?: string[]; coalesce?: { key: string; at: number } }
  | { type: "resolve"; id: string; page: ScanPage }
  | { type: "discard"; id: string }
  | { type: "rendered"; id: string; key: string; processed: Blob | null; thumb: Blob | null }
  | { type: "flags"; flags: Record<string, ScanPageFlags> }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "name"; name: string; edited: boolean }
  | { type: "suggested"; value: ScanSession["nameSuggested"] }
  | { type: "settings"; patch: Partial<ScanSettings> }
  /** Otra pestana modifico la sesion: esta pasa a ser una copia con otro id (sin tocar lo demas). */
  | { type: "fork"; id: string };

function mapEverywhere(state: ScanState, fn: (page: ScanPage) => ScanPage): Pick<ScanState, "pages" | "past" | "future"> {
  const map = (list: ScanPage[]) => {
    let changed = false;
    const next = list.map((page) => {
      const out = fn(page);
      if (out !== page) changed = true;
      return out;
    });
    return changed ? next : list;
  };
  return {
    pages: map(state.pages),
    past: state.past.map((entry) => ({ ...entry, pages: map(entry.pages) })),
    future: state.future.map((entry) => ({ ...entry, pages: map(entry.pages) })),
  };
}

export function scanReducer(state: ScanState, action: ScanAction): ScanState {
  switch (action.type) {
    case "load":
      return stateFromSession(action.session);
    case "reset":
      return emptyState(action.id, action.now, action.settings ?? state.settings);
    case "commit": {
      const last = state.past[state.past.length - 1];
      // Operaciones repetidas sobre lo mismo en pocos segundos (varias flechas, varios giros) son UN solo paso de deshacer.
      const merge = action.coalesce && last && last.key === action.coalesce.key && action.coalesce.at - (last.at ?? 0) < COALESCE_MS;
      const past = merge
        ? [...state.past.slice(0, -1), { ...last, at: action.coalesce!.at }]
        : [...state.past, { pages: state.pages, label: action.label, key: action.coalesce?.key, at: action.coalesce?.at }].slice(-HISTORY_LIMIT);
      const pendingIds = [...state.pendingIds.filter((id) => action.pages.some((page) => page.id === id)), ...(action.pending ?? [])];
      return { ...state, pages: action.pages, past, future: [], pendingIds, rev: state.rev + 1 };
    }
    case "resolve": {
      const next = (page: ScanPage) => (page.id === action.id ? { ...action.page, id: action.id } : page);
      return {
        ...state,
        ...mapEverywhere(state, next),
        pendingIds: state.pendingIds.filter((id) => id !== action.id),
        rev: state.rev + 1,
      };
    }
    case "discard": {
      const drop = (list: ScanPage[]) => list.filter((page) => page.id !== action.id);
      return {
        ...state,
        pages: drop(state.pages),
        past: state.past.map((entry) => ({ ...entry, pages: drop(entry.pages) })),
        future: state.future.map((entry) => ({ ...entry, pages: drop(entry.pages) })),
        pendingIds: state.pendingIds.filter((id) => id !== action.id),
        rev: state.rev + 1,
      };
    }
    case "rendered": {
      const apply = (page: ScanPage) =>
        page.id === action.id && renderKeyOf(page) === action.key ? { ...page, processed: action.processed, thumb: action.thumb } : page;
      const mapped = mapEverywhere(state, apply);
      const changed =
        mapped.pages !== state.pages ||
        mapped.past.some((entry, index) => entry.pages !== state.past[index].pages) ||
        mapped.future.some((entry, index) => entry.pages !== state.future[index].pages);
      return changed ? { ...state, ...mapped, rev: state.rev + 1 } : state;
    }
    case "flags": {
      const apply = (page: ScanPage) => {
        const flags = action.flags[page.id];
        if (!flags) return page;
        const same =
          !!flags.blank === !!page.flags.blank &&
          !!flags.blurry === !!page.flags.blurry &&
          !!flags.glare === !!page.flags.glare &&
          !!flags.dark === !!page.flags.dark &&
          !!flags.noDocument === !!page.flags.noDocument &&
          flags.duplicateOf === page.flags.duplicateOf;
        return same ? page : { ...page, flags };
      };
      const mapped = mapEverywhere(state, apply);
      return mapped.pages === state.pages ? state : { ...state, ...mapped, rev: state.rev + 1 };
    }
    case "undo": {
      const entry = state.past[state.past.length - 1];
      if (!entry) return state;
      return {
        ...state,
        pages: entry.pages,
        past: state.past.slice(0, -1),
        future: [{ pages: state.pages, label: entry.label }, ...state.future],
        pendingIds: state.pendingIds.filter((id) => entry.pages.some((page) => page.id === id)),
        rev: state.rev + 1,
      };
    }
    case "redo": {
      const entry = state.future[0];
      if (!entry) return state;
      return {
        ...state,
        pages: entry.pages,
        past: [...state.past, { pages: state.pages, label: entry.label }],
        future: state.future.slice(1),
        pendingIds: state.pendingIds.filter((id) => entry.pages.some((page) => page.id === id)),
        rev: state.rev + 1,
      };
    }
    case "name":
      return { ...state, name: action.name, nameEdited: action.edited, rev: state.rev + 1 };
    case "suggested":
      return { ...state, nameSuggested: action.value, rev: state.rev + 1 };
    case "settings":
      return { ...state, settings: { ...state.settings, ...action.patch }, rev: state.rev + 1 };
    case "fork":
      return action.id === state.id ? state : { ...state, id: action.id };
  }
}

export function canUndo(state: ScanState): boolean {
  return state.past.length > 0;
}

export function canRedo(state: ScanState): boolean {
  return state.future.length > 0;
}

/* ------------------------------------------------------------------ *
 * Nombre propuesto
 * ------------------------------------------------------------------ */

function two(value: number): string {
  return String(value).padStart(2, "0");
}

/** «Contrato de servicio · 2026-10-26» con titulo reconocido; «Escaneo 2026-10-26 14:32» sin el. */
export function proposeName(
  suggested: ScanSession["nameSuggested"] | undefined,
  language: "es" | "en",
  now: Date = new Date(),
): string {
  const day = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  const title = suggested?.title?.trim();
  if (title) return `${title} · ${suggested?.date ?? day}`;
  return `${language === "es" ? "Escaneo" : "Scan"} ${day} ${two(now.getHours())}:${two(now.getMinutes())}`;
}

/** Nombre de archivo seguro (sin separadores ni caracteres de control) con `.pdf`. */
export function fileNameFor(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Si la persona ya escribio la extension («Contrato.pdf») no se duplica («Contrato.pdf.pdf»).
    .replace(/(?:\s*\.pdf)+$/i, "")
    .trim()
    .slice(0, 120);
  return `${cleaned || fallback}.pdf`;
}

/** Cuantas hojas se giraron un cuarto de vuelta («de lado») y cuantas media vuelta («cabeza abajo») para el aviso de giro automatico. */
export function orientationCounts(notice: { ids: string[]; deltas: Record<string, number> }): { side: number; flipped: number } {
  let side = 0;
  let flipped = 0;
  for (const id of notice.ids) {
    const delta = (((notice.deltas[id] ?? 0) % 360) + 360) % 360;
    if (delta === 180) flipped += 1;
    else side += 1;
  }
  return { side, flipped };
}
