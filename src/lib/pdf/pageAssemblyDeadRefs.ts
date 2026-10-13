import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNull,
  PDFRef,
  PDFStream,
  type PDFContext,
  type PDFObject,
} from "@cantoo/pdf-lib";
import {
  KEY,
  LINK_PAGE,
  LINK_TAIL,
  asArray,
  asDict,
  climbDeadFields,
  collectPresentWidgets,
  destTarget,
  forEachActionHolder,
  isWidget,
  livingFieldNodes,
  nameValue,
  numberValue,
  refKey,
  type NamedDests,
} from "@/lib/pdf/pageAssemblyStructure";

/**
 * Paginas que ya no estan y NADA que se conserve debe seguir apuntandoles (Wave 9 · B7 · D1). Modulo puro (sin React).
 *
 * Quitar una hoja del arbol de paginas no basta para que desaparezca del archivo: `collectGarbage` solo suelta lo que
 * no cuelga del catalogo, y una pagina quitada seguia colgando de cualquier cosa que se conserva y la nombre — un boton o
 * una anotacion con una accion de salto (`/A`, `/AA`, cadenas `/Next`), la accion de apertura, el `/P` de una
 * anotacion, las cuentas de un articulo (`/Threads`), un `/IRT`, un `/CO` del formulario... — y con la hoja se quedaban
 * su texto y sus anotaciones dentro del archivo. Las vias que COPIAN paginas (Unir, Dividir) tienen el mismo problema al reves:
 * `copyPages` sigue las referencias y arrastra, como huerfanas, las paginas a las que lleva la copiada.
 *
 * `neutralizeDeadReferences` recorre todo lo que cuelga del catalogo (menos el arbol de estructura, que se poda aparte:
 * ver `pruneStructureTree`) y deja sin referencias hacia las paginas muertas:
 *  1. las ACCIONES de salto (`GoTo`) que llevan a una pagina muerta (directo o por un destino con nombre) se sacan de donde
 *     cuelgan — `/A`, `/PA`, `/AA`, `/OpenAction` y cadenas `/Next` (sueltas o en arreglo) —; las acciones que siguen en
 *     la cadena (un URI, un salto a una pagina que se queda) se conservan; cada una cuenta como un enlace quitado;
 *  2. los ARTICULOS (`/Threads`): las cuentas de paginas muertas salen del anillo y el resto se vuelve a enlazar; un
 *     articulo sin cuentas se va; cada cuenta cuenta como un enlace quitado;
 *  3. cualquier otra referencia a una pagina muerta (o a una anotacion que solo estaba en una pagina muerta, o a una
 *     cuenta quitada) se corta: una clave que apunta a ella se borra, un elemento de arreglo se quita y un destino
 *     explicito `[pagina /Fit]` se retira entero de quien lo tenia;
 *  4. los CAMPOS de formulario que se quedaron sin ningun widget vivo (Wave 9 · lote 2): un campo APARTE de su widget
 *     (con su `/T`, su `/V`, su `/DV`) que otra cosa nombra — el orden de calculo `/CO`, la lista `/Fields` de una accion de
 *     reinicio... — se quedaba con `/Kids []` y su valor; ahora los campos y grupos sin widgets vivos son muertos y se cortan
 *     de donde cuelguen (ver `climbDeadFields`).
 */

const N = PDFName.of;
const THREADS = N("Threads");
const BEAD_FIRST = N("F");
const BEAD_NEXT = N("N");
const BEAD_PREV = N("V");
const BEAD_THREAD = N("T");
const BEADS = N("B");
const ACTIONS = N("AA");
const PAGE_ACTION = N("PA");
const ANNOTATIONS = KEY.Annots;

const MAX_RING = 100_000;
const MAX_CHAIN = 64;

/** Nombres de los destinos explicitos que acompanan a la pagina: `[pagina /Fit]`, `[pagina /XYZ 0 0 0]`... */
const DEST_TYPES = new Set(["XYZ", "Fit", "FitH", "FitV", "FitR", "FitB", "FitBH", "FitBV"]);

/**
 * Hojas que ya no estan: las `known` (hojas originales que se quitaron, aunque les falte el `/Type`) y, si se da
 * `newObjectsFrom` (primer objeto que acaba de traer `copyPages`), las `/Type /Page` de esos objetos que no estan en `live`:
 * las que el copiador arrastro sin que nadie las pidiera. Las paginas que ya estaban fuera del arbol antes de la operacion
 * (plantillas con nombre) no son de nadie que se haya quitado y no se tocan.
 */
export function findDeadPages(
  context: PDFContext,
  live: ReadonlySet<string>,
  known: readonly PDFRef[] = [],
  newObjectsFrom?: number,
): PDFRef[] {
  const dead = new Map<string, PDFRef>();
  for (const ref of known) if (!live.has(refKey(ref))) dead.set(refKey(ref), ref);
  if (newObjectsFrom !== undefined) {
    for (const [ref, object] of context.enumerateIndirectObjects()) {
      if (ref.objectNumber < newObjectsFrom || live.has(refKey(ref)) || dead.has(refKey(ref))) continue;
      if (object instanceof PDFDict && nameValue(context, object.get(KEY.Type)) === "Page") dead.set(refKey(ref), ref);
    }
  }
  return [...dead.values()];
}

/**
 * Depurador de cadenas de acciones: `cleaner(holder, key)` mira la accion que cuelga de `holder[key]` (y sus `/Next`, sueltos
 * o en arreglo) y SACA las que `decide` marque como `dead`, conservando las demas de la cadena. `decide` puede aprovechar para
 * arreglar la accion (reapuntarla). Devuelve cuantas acciones saco; si no queda ninguna, borra la clave.
 */
export function createActionCleaner(
  context: PDFContext,
  decide: (action: PDFDict) => "keep" | "dead",
): (holder: PDFDict, key: PDFName) => number {
  const clean = (
    value: PDFObject,
    depth: number,
    seen: Set<PDFDict>,
    allowArray: boolean,
  ): { value: PDFObject | undefined; removed: number } => {
    if (depth > MAX_CHAIN) return { value, removed: 0 };
    const resolved = value instanceof PDFRef ? context.lookup(value) : value;
    if (resolved instanceof PDFArray) {
      if (!allowArray) return { value, removed: 0 };
      let removed = 0;
      let changed = false;
      const kept: PDFObject[] = [];
      for (let index = 0; index < resolved.size(); index += 1) {
        const item = resolved.get(index);
        const result = clean(item, depth + 1, seen, false);
        removed += result.removed;
        if (result.value !== item) changed = true;
        if (result.value !== undefined) kept.push(result.value);
      }
      if (!changed) return { value, removed };
      return { value: kept.length > 0 ? context.obj(kept) : undefined, removed };
    }
    if (!(resolved instanceof PDFDict) || seen.has(resolved)) return { value, removed: 0 };
    if (nameValue(context, resolved.get(KEY.S)) === undefined) return { value, removed: 0 };
    seen.add(resolved);
    const next = resolved.get(KEY.Next);
    const afterwards = next ? clean(next, depth + 1, seen, true) : undefined;
    if (decide(resolved) === "dead") {
      return { value: afterwards?.value, removed: 1 + (afterwards?.removed ?? 0) };
    }
    if (afterwards && afterwards.removed > 0) {
      if (afterwards.value === undefined) resolved.delete(KEY.Next);
      else if (afterwards.value !== next) resolved.set(KEY.Next, afterwards.value);
    }
    return { value, removed: afterwards?.removed ?? 0 };
  };

  return (holder, key) => {
    const value = holder.get(key);
    if (!value) return 0;
    const result = clean(value, 0, new Set(), false);
    if (result.removed === 0) return 0;
    if (result.value === undefined) holder.delete(key);
    else holder.set(key, result.value);
    return result.removed;
  };
}

/**
 * Tras `copyPages`: reapunta a las paginas COPIADAS las acciones de salto que `sanitizeLeavesForCopy` marco en las hojas
 * dadas (`targetOf(indiceEnElOrigen)` -> hoja copiada) y saca las que llevan a una pagina que no vino. Devuelve cuantas
 * acciones salieron.
 */
export function resolveMarkedActions(
  context: PDFContext,
  leaves: readonly PDFDict[],
  targetOf: (sourceIndex: number) => PDFRef | undefined,
): number {
  const clean = createActionCleaner(context, (action) => {
    const index = numberValue(context, action.get(LINK_PAGE));
    if (index === undefined) return "keep";
    const target = targetOf(index);
    const tail = asArray(context, action.get(LINK_TAIL));
    action.delete(LINK_PAGE);
    action.delete(LINK_TAIL);
    if (!target) return "dead";
    const rest: PDFObject[] = [];
    if (tail) for (let at = 0; at < tail.size(); at += 1) rest.push(tail.get(at));
    action.set(KEY.D, context.obj([target, ...rest]));
    return "keep";
  });
  let removed = 0;
  for (const leaf of leaves) forEachActionHolder(context, leaf, (holder, key) => (removed += clean(holder, key)));
  return removed;
}

export type DeadReferencesInput = {
  /** Hojas que ya no estan (ver `findDeadPages`). */
  deadPages: readonly PDFRef[];
  /** Hojas que se quedan (sus anotaciones NO son muertas aunque otra pagina muerta las nombre). */
  liveLeaves: readonly PDFDict[];
  /**
   * Lo que `pruneAcroForm` quito del formulario (campos, grupos y widgets): se corta de todo lo que lo nombre. Ademas se da
   * por muerto cada campo o grupo que se queda sin widgets vivos al irse las anotaciones de las paginas muertas (incluidas las
   * que `copyPages` arrastro), aunque no cuelgue de `/Fields`.
   */
  deadFields?: readonly PDFRef[];
  /** Destinos con nombre ANTES de podarlos (para saber a donde llevaba cada nombre). */
  named: NamedDests;
  /**
   * Primer numero de objeto que `copyPages` acaba de traer de otro documento (o `0` si todo el documento es nuevo). Las
   * anotaciones (que no son campos de formulario) de esos objetos que no estan en ninguna pagina que se queda — la
   * respuesta (`/IRT`) o la ventana emergente (`/Popup`) de una anotacion de una pagina que no vino — son de paginas
   * muertas: se cortan igual. Sin este valor no se busca nada de esto (en un documento propio, una anotacion fuera de
   * `/Annots` puede ser legitima).
   */
  newObjectsFrom?: number;
};

const ANNOTATION_SUBTYPES_EXCLUDED = new Set(["Widget"]);

/** Anotacion (que no es un campo de formulario): `/Type /Annot`, o un `/Subtype` con `/Rect`. */
function isStrayCandidate(context: PDFContext, dict: PDFDict): boolean {
  const subtype = nameValue(context, dict.get(KEY.Subtype));
  if (subtype === undefined || ANNOTATION_SUBTYPES_EXCLUDED.has(subtype)) return false;
  return nameValue(context, dict.get(KEY.Type)) === "Annot" || dict.has(N("Rect"));
}

/** Destino explicito `[pagina /Fit ...]` cuya pagina esta en `pages`. */
function isDeadDestArray(value: PDFObject | undefined, pages: ReadonlySet<string>): boolean {
  if (!(value instanceof PDFArray) || value.size() === 0) return false;
  const first = value.get(0);
  if (!(first instanceof PDFRef) || !pages.has(refKey(first))) return false;
  if (value.size() === 1) return true;
  const second = value.get(1);
  return second instanceof PDFName && DEST_TYPES.has(second.decodeText());
}

/** Anillo de cuentas (`/F` -> `/N` -> ...) de un articulo. `undefined` si no es legible con seguridad. */
function readRing(context: PDFContext, thread: PDFDict): { ref: PDFRef; dict: PDFDict }[] | undefined {
  const ring: { ref: PDFRef; dict: PDFDict }[] = [];
  const seen = new Set<string>();
  let current: PDFObject | undefined = thread.get(BEAD_FIRST);
  while (current instanceof PDFRef && ring.length < MAX_RING) {
    const key = refKey(current);
    if (seen.has(key)) break;
    const dict = asDict(context, current);
    if (!dict) return undefined;
    seen.add(key);
    ring.push({ ref: current, dict });
    current = dict.get(BEAD_NEXT);
  }
  return ring.length > 0 ? ring : undefined;
}

/**
 * Articulos (`/Threads`): saca del anillo de cada articulo las cuentas cuya pagina esta muerta y vuelve a enlazar las que
 * quedan; un articulo sin cuentas sale de `/Threads`. Devuelve las cuentas quitadas.
 */
function pruneThreads(
  context: PDFContext,
  catalog: PDFDict,
  liveLeaves: readonly PDFDict[],
  deadPages: ReadonlySet<string>,
  deadBeads: Set<string>,
): number {
  const threads: PDFDict[] = [];
  const known = new Set<PDFDict>();
  const add = (object: PDFObject | undefined) => {
    const dict = asDict(context, object);
    if (dict && !known.has(dict)) {
      known.add(dict);
      threads.push(dict);
    }
  };
  const listed = asArray(context, catalog.get(THREADS));
  if (listed) for (let index = 0; index < listed.size(); index += 1) add(listed.get(index));
  // Articulos que solo cuelgan de las cuentas de las paginas que se quedan (copias a otro documento).
  for (const leaf of liveLeaves) {
    const beads = asArray(context, leaf.get(BEADS));
    if (!beads) continue;
    for (let index = 0; index < beads.size(); index += 1) add(asDict(context, beads.get(index))?.get(BEAD_THREAD));
  }

  let removed = 0;
  for (const thread of threads) {
    const ring = readRing(context, thread);
    if (!ring) continue;
    const alive = ring.filter(({ dict }) => {
      const page = dict.get(KEY.P);
      return !(page instanceof PDFRef && deadPages.has(refKey(page)));
    });
    if (alive.length === ring.length) continue;
    for (const bead of ring) if (!alive.includes(bead)) deadBeads.add(refKey(bead.ref));
    removed += ring.length - alive.length;
    if (alive.length === 0) {
      thread.delete(BEAD_FIRST);
      if (listed) {
        for (let index = listed.size() - 1; index >= 0; index -= 1) {
          if (asDict(context, listed.get(index)) === thread) listed.remove(index);
        }
      }
      continue;
    }
    alive.forEach((bead, index) => {
      bead.dict.set(BEAD_NEXT, alive[(index + 1) % alive.length].ref);
      bead.dict.set(BEAD_PREV, alive[(index + alive.length - 1) % alive.length].ref);
    });
    const first = thread.get(BEAD_FIRST);
    if (!(first instanceof PDFRef) || !alive.some((bead) => bead.ref === first)) thread.set(BEAD_FIRST, alive[0].ref);
  }
  return removed;
}

/**
 * Deja sin referencias hacia las paginas de `input.deadPages` (y hacia lo que solo existia en ellas) todo lo que cuelga del
 * catalogo. Devuelve cuantos saltos (acciones y cuentas de articulo) se quitaron: lo que `warnings.linksRemoved` debe contar.
 * Despues hay que soltar los objetos sin referencia (`collectGarbage`).
 */
export function neutralizeDeadReferences(context: PDFContext, catalog: PDFDict, input: DeadReferencesInput): number {
  const deadPages = new Set(input.deadPages.map(refKey));
  if (deadPages.size === 0 && input.newObjectsFrom === undefined && !input.deadFields?.length) return 0;
  let removedLinks = 0;

  // Todo lo que hay que cortar: las paginas, sus anotaciones que no estan en otra pagina, y las cuentas quitadas.
  const dead = new Set(deadPages);
  for (const ref of input.deadFields ?? []) dead.add(refKey(ref));
  const deadWidgets: PDFRef[] = [];
  const liveAnnotations = new Set<string>();
  for (const leaf of input.liveLeaves) {
    const annots = asArray(context, leaf.get(ANNOTATIONS));
    if (!annots) continue;
    for (let index = 0; index < annots.size(); index += 1) {
      const item = annots.get(index);
      if (item instanceof PDFRef) liveAnnotations.add(refKey(item));
    }
  }
  for (const ref of input.deadPages) {
    const annots = asArray(context, asDict(context, ref)?.get(ANNOTATIONS));
    if (!annots) continue;
    for (let index = 0; index < annots.size(); index += 1) {
      const item = annots.get(index);
      if (!(item instanceof PDFRef) || liveAnnotations.has(refKey(item))) continue;
      dead.add(refKey(item));
      const widget = asDict(context, item);
      if (widget && isWidget(context, widget)) deadWidgets.push(item);
    }
  }

  if (input.newObjectsFrom !== undefined) {
    for (const [ref, object] of context.enumerateIndirectObjects()) {
      if (ref.objectNumber < input.newObjectsFrom || liveAnnotations.has(refKey(ref))) continue;
      if (object instanceof PDFDict && isStrayCandidate(context, object)) dead.add(refKey(ref));
    }
  }

  // Campos y grupos que se quedan sin ningun widget vivo (los de las paginas quitadas y los que arrastro el copiador).
  if (deadWidgets.length > 0) {
    const living = livingFieldNodes(context, collectPresentWidgets(context, input.liveLeaves));
    climbDeadFields(context, deadWidgets, dead, living);
  }

  removedLinks += pruneThreads(context, catalog, input.liveLeaves, deadPages, dead);

  /* ---------- acciones de salto ---------- */
  const cleanAction = createActionCleaner(context, (action) => {
    // Una marca sin resolver (ver `resolveMarkedActions`) es un salto a una pagina que no vino.
    if (action.has(LINK_PAGE)) return "dead";
    if (nameValue(context, action.get(KEY.S)) !== "GoTo") return "keep";
    // Solo los saltos que llevan, directo o por nombre, a una pagina muerta: un salto roto de antes no es cosa de esta operacion.
    const target = destTarget(context, action.get(KEY.D), input.named);
    return target.kind === "page" && deadPages.has(refKey(target.ref)) ? "dead" : "keep";
  });

  /* ---------- recorrido: acciones y referencias sueltas ---------- */
  const visited = new Set<object>();
  const stack: PDFObject[] = [];
  const queue = (object: PDFObject | undefined): void => {
    if (!object) return;
    const resolved = object instanceof PDFRef ? context.lookup(object) : object;
    if (!resolved || visited.has(resolved)) return;
    visited.add(resolved);
    stack.push(resolved);
  };
  const isDeadRef = (value: PDFObject | undefined): boolean => value instanceof PDFRef && dead.has(refKey(value));

  const sweepDict = (dict: PDFDict): void => {
    if (dict === catalog) removedLinks += cleanAction(dict, KEY.OpenAction);
    removedLinks += cleanAction(dict, KEY.A);
    removedLinks += cleanAction(dict, PAGE_ACTION);
    const triggers = asDict(context, dict.get(ACTIONS));
    if (triggers) for (const key of triggers.keys()) removedLinks += cleanAction(triggers, key);

    for (const [name, value] of dict.entries()) {
      // El arbol de estructura se poda aparte (quitar un `/Pg` suelto lo dejaria incoherente).
      if (dict === catalog && name === KEY.StructTreeRoot) continue;
      const target = value instanceof PDFRef ? context.lookup(value) : value;
      if (isDeadRef(value) || isDeadDestArray(target, deadPages)) {
        dict.delete(name);
        continue;
      }
      queue(value);
    }
  };

  const sweepArray = (array: PDFArray): void => {
    for (let index = array.size() - 1; index >= 0; index -= 1) {
      const item = array.get(index);
      if (isDeadRef(item)) {
        array.remove(index);
        continue;
      }
      const target = item instanceof PDFRef ? context.lookup(item) : item;
      if (isDeadDestArray(target, deadPages)) {
        array.set(index, PDFNull);
        continue;
      }
      queue(item);
    }
  };

  const { Root, Info } = context.trailerInfo;
  queue(catalog);
  queue(Root);
  queue(Info);
  while (stack.length > 0) {
    const current = stack.pop() as PDFObject;
    if (current instanceof PDFDict) sweepDict(current);
    else if (current instanceof PDFStream) sweepDict(current.dict);
    else if (current instanceof PDFArray) sweepArray(current);
  }
  return removedLinks;
}
