import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFContext,
  type PDFPageLeaf,
} from "@cantoo/pdf-lib";

/**
 * Cirugia de bajo nivel sobre un documento de pdf-lib para el motor de paginas
 * (`pageAssembly.ts`). Modulo puro (sin React).
 *
 * El motor edita EN SITIO el documento cargado: reordena el arbol de paginas, quita o clona
 * hojas y, DESPUES, repara lo que apuntaba a paginas que ya no estan (marcadores, enlaces, destinos
 * con nombre, campos de formulario, estructura etiquetada, etiquetas de pagina) y suelta los
 * objetos que quedaron sin referencia. `copyPages` a un documento nuevo pierde titulo, autor,
 * AcroForm y marcadores; aqui se conservan porque nunca se sale del documento original.
 */

const N = (name: string) => PDFName.of(name);

export const KEY = {
  Annots: N("Annots"),
  AcroForm: N("AcroForm"),
  A: N("A"),
  D: N("D"),
  Count: N("Count"),
  Dest: N("Dest"),
  Dests: N("Dests"),
  FT: N("FT"),
  Fields: N("Fields"),
  IDTree: N("IDTree"),
  K: N("K"),
  Obj: N("Obj"),
  ParentTree: N("ParentTree"),
  Pg: N("Pg"),
  StructParent: N("StructParent"),
  StructParents: N("StructParents"),
  Type: N("Type"),
  V: N("V"),
  First: N("First"),
  Kids: N("Kids"),
  Last: N("Last"),
  Names: N("Names"),
  Next: N("Next"),
  OpenAction: N("OpenAction"),
  Outlines: N("Outlines"),
  P: N("P"),
  PageLabels: N("PageLabels"),
  Pages: N("Pages"),
  Parent: N("Parent"),
  Popup: N("Popup"),
  Prev: N("Prev"),
  Rotate: N("Rotate"),
  S: N("S"),
  SE: N("SE"),
  StructTreeRoot: N("StructTreeRoot"),
  MarkInfo: N("MarkInfo"),
  Subtype: N("Subtype"),
  T: N("T"),
} as const;

/** Clave de comparacion de una referencia indirecta. */
export function refKey(ref: PDFRef): string {
  return `${ref.objectNumber} ${ref.generationNumber}`;
}

/* ------------------------------------------------------------------ *
 * Lectura segura de objetos
 * ------------------------------------------------------------------ */

export function asDict(context: PDFContext, object: PDFObject | undefined): PDFDict | undefined {
  if (!object) return undefined;
  const value = object instanceof PDFRef ? context.lookup(object) : object;
  if (value instanceof PDFDict) return value;
  if (value instanceof PDFStream) return value.dict;
  return undefined;
}

export function asArray(context: PDFContext, object: PDFObject | undefined): PDFArray | undefined {
  if (!object) return undefined;
  const value = object instanceof PDFRef ? context.lookup(object) : object;
  return value instanceof PDFArray ? value : undefined;
}

export function nameValue(context: PDFContext, object: PDFObject | undefined): string | undefined {
  const value = object instanceof PDFRef ? context.lookup(object) : object;
  return value instanceof PDFName ? value.decodeText() : undefined;
}

export function textValue(context: PDFContext, object: PDFObject | undefined): string | undefined {
  const value = object instanceof PDFRef ? context.lookup(object) : object;
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  return undefined;
}

export function numberValue(context: PDFContext, object: PDFObject | undefined): number | undefined {
  const value = object instanceof PDFRef ? context.lookup(object) : object;
  return value instanceof PDFNumber ? value.asNumber() : undefined;
}

/* ------------------------------------------------------------------ *
 * Destinos
 * ------------------------------------------------------------------ */

/** Destinos con nombre del catalogo: `/Dests` (PDF 1.1) y `/Names /Dests` (arbol de nombres). */
export type NamedDests = Map<string, PDFObject>;

function walkNameTree(
  context: PDFContext,
  node: PDFDict | undefined,
  visit: (key: string, value: PDFObject, names: PDFArray, index: number) => void,
  seen: Set<PDFDict> = new Set(),
): void {
  if (!node || seen.has(node)) return;
  seen.add(node);
  const names = asArray(context, node.get(KEY.Names));
  if (names) {
    for (let index = 0; index + 1 < names.size(); index += 2) {
      const key = textValue(context, names.get(index));
      if (key !== undefined) visit(key, names.get(index + 1), names, index);
    }
  }
  const kids = asArray(context, node.get(KEY.Kids));
  if (kids) {
    for (let index = 0; index < kids.size(); index += 1) {
      walkNameTree(context, asDict(context, kids.get(index)), visit, seen);
    }
  }
}

export function collectNamedDests(context: PDFContext, catalog: PDFDict): NamedDests {
  const map: NamedDests = new Map();
  const legacy = asDict(context, catalog.get(KEY.Dests));
  if (legacy) {
    for (const [name, value] of legacy.entries()) map.set(name.decodeText(), value);
  }
  const names = asDict(context, catalog.get(KEY.Names));
  const tree = names ? asDict(context, names.get(KEY.Dests)) : undefined;
  walkNameTree(context, tree, (key, value) => {
    map.set(key, value);
  });
  return map;
}

export type DestTarget =
  /** Apunta a una pagina de ESTE documento. */
  | { kind: "page"; ref: PDFRef }
  /** Nombre que no existe (o destino sin pagina local): inservible. */
  | { kind: "broken" }
  /** No es un salto interno (URI, otra accion, sin destino). */
  | { kind: "none" };

/** Pagina a la que lleva un destino (explicito, con nombre o envuelto en `<< /D [...] >>`). */
export function destTarget(
  context: PDFContext,
  dest: PDFObject | undefined,
  named: NamedDests,
  depth = 0,
): DestTarget {
  if (!dest || depth > 4) return { kind: "none" };
  const value = dest instanceof PDFRef ? context.lookup(dest) : dest;
  if (value instanceof PDFArray) {
    const first = value.get(0);
    if (first instanceof PDFRef) return { kind: "page", ref: first };
    // Un numero de pagina (destinos remotos) no es una pagina de este documento.
    return { kind: "none" };
  }
  if (value instanceof PDFDict) {
    return destTarget(context, value.get(KEY.D), named, depth + 1);
  }
  if (value instanceof PDFName || value instanceof PDFString || value instanceof PDFHexString) {
    const key = value.decodeText();
    const found = named.get(key);
    if (!found) return { kind: "broken" };
    const resolved = destTarget(context, found, named, depth + 1);
    return resolved.kind === "none" ? { kind: "broken" } : resolved;
  }
  return { kind: "none" };
}

/** Destino interno de un dict de marcador o de anotacion (`/Dest` o `/A << /S /GoTo /D ... >>`). */
export function itemTarget(context: PDFContext, item: PDFDict, named: NamedDests): DestTarget {
  const direct = item.get(KEY.Dest);
  if (direct) return destTarget(context, direct, named);
  const action = asDict(context, item.get(KEY.A));
  if (action && nameValue(context, action.get(KEY.S)) === "GoTo") {
    return destTarget(context, action.get(KEY.D), named);
  }
  return { kind: "none" };
}

/* ------------------------------------------------------------------ *
 * Marcadores (outlines)
 * ------------------------------------------------------------------ */

export type OutlineNode = { ref: PDFRef; dict: PDFDict; children: OutlineNode[] };

const MAX_OUTLINE_ITEMS = 200_000;

function readSiblings(
  context: PDFContext,
  firstRef: PDFObject | undefined,
  seen: Set<string>,
  budget: { left: number },
): OutlineNode[] {
  const nodes: OutlineNode[] = [];
  let current = firstRef;
  while (current instanceof PDFRef && budget.left > 0) {
    const key = refKey(current);
    if (seen.has(key)) break;
    seen.add(key);
    const dict = asDict(context, current);
    if (!dict) break;
    budget.left -= 1;
    const node: OutlineNode = { ref: current, dict, children: [] };
    node.children = readSiblings(context, dict.get(KEY.First), seen, budget);
    nodes.push(node);
    current = dict.get(KEY.Next);
  }
  return nodes;
}

export type OutlineTree = { root: PDFDict; items: OutlineNode[] };

export function readOutline(context: PDFContext, catalog: PDFDict): OutlineTree | undefined {
  const root = asDict(context, catalog.get(KEY.Outlines));
  if (!root) return undefined;
  const items = readSiblings(context, root.get(KEY.First), new Set(), { left: MAX_OUTLINE_ITEMS });
  return { root, items };
}

/** Titulo de un marcador (texto PDF decodificado). */
export function outlineTitle(context: PDFContext, node: OutlineNode): string {
  return textValue(context, node.dict.get(N("Title"))) ?? "";
}

/**
 * Quita los marcadores cuya pagina ya no existe. Los hijos que siguen vivos suben al nivel del
 * padre eliminado (no se pierde un capitulo entero por haber quitado su portada).
 * Devuelve cuantos marcadores se quitaron.
 */
export function pruneOutline(
  context: PDFContext,
  catalog: PDFDict,
  named: NamedDests,
  isLive: (pageRef: PDFRef) => boolean,
  options: { dropStructure: boolean },
): number {
  const tree = readOutline(context, catalog);
  if (!tree) return 0;
  let removed = 0;

  const prune = (nodes: OutlineNode[]): OutlineNode[] => {
    const out: OutlineNode[] = [];
    for (const node of nodes) {
      const kids = prune(node.children);
      const target = itemTarget(context, node.dict, named);
      const dead = target.kind === "broken" || (target.kind === "page" && !isLive(target.ref));
      if (dead) {
        removed += 1;
        out.push(...kids);
      } else {
        node.children = kids;
        out.push(node);
      }
    }
    return out;
  };

  const kept = prune(tree.items);
  if (removed === 0 && !options.dropStructure) return 0;

  // Cuenta de descendientes visibles (`/Count` negativo = cerrado), recalculada de abajo arriba.
  const rewire = (parent: PDFDict, parentRef: PDFRef | undefined, nodes: OutlineNode[]): number => {
    let visible = 0;
    nodes.forEach((node, index) => {
      const previous = nodes[index - 1];
      const next = nodes[index + 1];
      if (parentRef) node.dict.set(KEY.Parent, parentRef);
      if (previous) node.dict.set(KEY.Prev, previous.ref);
      else node.dict.delete(KEY.Prev);
      if (next) node.dict.set(KEY.Next, next.ref);
      else node.dict.delete(KEY.Next);
      if (options.dropStructure) node.dict.delete(KEY.SE);
      const below = rewire(node.dict, node.ref, node.children);
      if (node.children.length > 0) {
        const wasClosed = (numberValue(context, node.dict.get(KEY.Count)) ?? 0) < 0;
        node.dict.set(KEY.Count, PDFNumber.of(wasClosed ? -below : below));
        visible += 1 + (wasClosed ? 0 : below);
      } else {
        node.dict.delete(KEY.Count);
        visible += 1;
      }
    });
    if (nodes.length > 0) {
      parent.set(KEY.First, nodes[0].ref);
      parent.set(KEY.Last, nodes[nodes.length - 1].ref);
    } else {
      parent.delete(KEY.First);
      parent.delete(KEY.Last);
    }
    return visible;
  };

  const rootRef = catalog.get(KEY.Outlines);
  const visibleTotal = rewire(tree.root, rootRef instanceof PDFRef ? rootRef : undefined, kept);
  if (kept.length === 0) {
    catalog.delete(KEY.Outlines);
  } else {
    tree.root.set(KEY.Count, PDFNumber.of(visibleTotal));
  }
  return removed;
}

/* ------------------------------------------------------------------ *
 * Marcadores: importar de otro documento y agrupar (Wave 8 · Unir)
 * ------------------------------------------------------------------ */

/** Marcador leido de otro documento, ya resuelto a una hoja del documento DESTINO. */
export type ImportedOutlineItem = {
  title: string;
  /** Hoja del documento destino a la que apunta. */
  pageRef: PDFRef;
  /** Cola del destino explicito (`/XYZ 0 792 0`, `/Fit`...), solo objetos directos sin referencias. */
  destTail: PDFObject[];
  closed: boolean;
  children: ImportedOutlineItem[];
};

const DEST_TAIL_LIMIT = 8;

/** Cola de un destino explicito del documento origen, si solo trae nombres, numeros o nulos. */
function explicitDestTail(sourceContext: PDFContext, dest: PDFObject | undefined): PDFObject[] | undefined {
  const value = dest instanceof PDFRef ? sourceContext.lookup(dest) : dest;
  if (!(value instanceof PDFArray) || value.size() > DEST_TAIL_LIMIT) return undefined;
  const tail: PDFObject[] = [];
  for (let index = 1; index < value.size(); index += 1) {
    const item = value.get(index);
    if (item instanceof PDFName) tail.push(PDFName.of(item.decodeText()));
    else if (item instanceof PDFNumber) tail.push(PDFNumber.of(item.asNumber()));
    else if (item === PDFNull) tail.push(PDFNull);
    else return undefined;
  }
  return tail;
}

/**
 * Marcadores de OTRO documento que apuntan a paginas copiadas (`pageMap`: indice de pagina en el
 * origen -> hoja ya copiada en el destino). Los que apuntan a paginas que no vienen desaparecen y
 * sus hijos vivos suben de nivel (como al podar). Devuelve cuantos se descartaron en `dropped`.
 */
export function readImportableOutline(
  sourceContext: PDFContext,
  sourceCatalog: PDFDict,
  sourcePageRefs: readonly PDFRef[],
  pageMap: ReadonlyMap<number, PDFRef>,
): { items: ImportedOutlineItem[]; dropped: number } {
  const tree = readOutline(sourceContext, sourceCatalog);
  if (!tree) return { items: [], dropped: 0 };
  const indexOf = new Map<string, number>();
  sourcePageRefs.forEach((ref, index) => indexOf.set(refKey(ref), index));
  const named = collectNamedDests(sourceContext, sourceCatalog);
  let dropped = 0;

  const convert = (nodes: OutlineNode[]): ImportedOutlineItem[] => {
    const out: ImportedOutlineItem[] = [];
    for (const node of nodes) {
      const children = convert(node.children);
      const target = itemTarget(sourceContext, node.dict, named);
      const sourceIndex = target.kind === "page" ? indexOf.get(refKey(target.ref)) : undefined;
      const pageRef = sourceIndex === undefined ? undefined : pageMap.get(sourceIndex);
      if (!pageRef) {
        dropped += 1;
        out.push(...children);
        continue;
      }
      const direct = node.dict.get(KEY.Dest);
      out.push({
        title: outlineTitle(sourceContext, node),
        pageRef,
        destTail: (direct ? explicitDestTail(sourceContext, direct) : undefined) ?? [PDFName.of("Fit")],
        closed: (numberValue(sourceContext, node.dict.get(KEY.Count)) ?? 0) < 0,
        children,
      });
    }
    return out;
  };
  return { items: convert(tree.items), dropped };
}

type BuiltItem = { ref: PDFRef; dict: PDFDict; children: BuiltItem[]; closed: boolean };

/** Crea los diccionarios de los marcadores en el contexto DESTINO (sin enlazarlos aun). */
function buildItems(context: PDFContext, items: readonly ImportedOutlineItem[]): BuiltItem[] {
  return items.map((item) => {
    const dict = context.obj({
      Title: PDFHexString.fromText(item.title),
      Dest: context.obj([item.pageRef, ...item.destTail]),
    });
    return { ref: context.register(dict), dict, children: buildItems(context, item.children), closed: item.closed };
  });
}

/**
 * Enlaza hermanos e hijos (`/Parent`, `/Prev`, `/Next`, `/First`, `/Last`, `/Count`) y devuelve
 * cuantos marcadores quedan VISIBLES bajo `parent` (lo que pide `/Count` de un nodo abierto).
 */
function linkItems(parent: PDFDict, parentRef: PDFRef, items: readonly BuiltItem[]): number {
  let visible = 0;
  items.forEach((item, index) => {
    item.dict.set(KEY.Parent, parentRef);
    if (index > 0) item.dict.set(KEY.Prev, items[index - 1].ref);
    if (index + 1 < items.length) item.dict.set(KEY.Next, items[index + 1].ref);
    const below = linkItems(item.dict, item.ref, item.children);
    if (item.children.length > 0) item.dict.set(KEY.Count, PDFNumber.of(item.closed ? -below : below));
    visible += 1 + (item.closed ? 0 : below);
  });
  if (items.length > 0) {
    parent.set(KEY.First, items[0].ref);
    parent.set(KEY.Last, items[items.length - 1].ref);
  }
  return visible;
}

/** Raiz `/Outlines` del catalogo (se crea si no existe). */
function ensureOutlineRoot(context: PDFContext, catalog: PDFDict): { root: PDFDict; rootRef: PDFRef } {
  const existing = catalog.get(KEY.Outlines);
  const root = asDict(context, existing);
  if (root && existing instanceof PDFRef) return { root, rootRef: existing };
  const fresh = context.obj({ Type: "Outlines", Count: 0 });
  const rootRef = context.register(fresh);
  catalog.set(KEY.Outlines, rootRef);
  return { root: fresh, rootRef };
}

/** Marcadores de primer nivel que ya cuelgan de la raiz. */
function topLevel(context: PDFContext, root: PDFDict): OutlineNode[] {
  return readSiblings(context, root.get(KEY.First), new Set(), { left: MAX_OUTLINE_ITEMS });
}

/**
 * Anade al FINAL de los marcadores un grupo con `title` (que lleva a `firstPageRef`) y, colgando
 * de el, los `items` dados. Sin `items`, no hace nada. Devuelve cuantos marcadores se anadieron
 * (sin contar el grupo).
 */
export function appendOutlineGroup(
  context: PDFContext,
  catalog: PDFDict,
  title: string,
  firstPageRef: PDFRef,
  items: readonly ImportedOutlineItem[],
): number {
  if (items.length === 0) return 0;
  const { root, rootRef } = ensureOutlineRoot(context, catalog);
  const group: BuiltItem = {
    dict: context.obj({
      Title: PDFHexString.fromText(title),
      Dest: context.obj([firstPageRef, PDFName.of("Fit")]),
    }),
    ref: context.nextRef(),
    children: buildItems(context, items),
    closed: false,
  };
  context.assign(group.ref, group.dict);
  const siblings = topLevel(context, root);
  const last = siblings[siblings.length - 1];
  group.dict.set(KEY.Parent, rootRef);
  if (last) {
    last.dict.set(KEY.Next, group.ref);
    group.dict.set(KEY.Prev, last.ref);
  } else {
    root.set(KEY.First, group.ref);
  }
  root.set(KEY.Last, group.ref);
  const below = linkItems(group.dict, group.ref, group.children);
  group.dict.set(KEY.Count, PDFNumber.of(below));
  root.set(KEY.Count, PDFNumber.of((numberValue(context, root.get(KEY.Count)) ?? 0) + 1 + below));
  let added = 0;
  const count = (list: readonly ImportedOutlineItem[]) => {
    for (const item of list) {
      added += 1;
      count(item.children);
    }
  };
  count(items);
  return added;
}

/**
 * Cuelga `items` de la raiz de marcadores de un documento (se crea si no existe), a continuacion de los
 * que ya hubiera. Devuelve cuantos marcadores se anadieron (contando los anidados).
 */
export function addOutlineItems(
  context: PDFContext,
  catalog: PDFDict,
  items: readonly ImportedOutlineItem[],
): number {
  if (items.length === 0) return 0;
  const { root, rootRef } = ensureOutlineRoot(context, catalog);
  const built = buildItems(context, items);
  const existing = topLevel(context, root);
  const last = existing[existing.length - 1];
  const visible = linkItems(root, rootRef, built);
  if (last) {
    last.dict.set(KEY.Next, built[0].ref);
    built[0].dict.set(KEY.Prev, last.ref);
    root.set(KEY.First, existing[0].ref);
  }
  root.set(KEY.Last, built[built.length - 1].ref);
  root.set(KEY.Count, PDFNumber.of((numberValue(context, root.get(KEY.Count)) ?? 0) + visible));
  let added = 0;
  const count = (list: readonly ImportedOutlineItem[]) => {
    for (const item of list) {
      added += 1;
      count(item.children);
    }
  };
  count(items);
  return added;
}

/** Cuantos marcadores (anidados incluidos) tiene el documento. */
export function countOutlineItems(context: PDFContext, catalog: PDFDict): number {
  const tree = readOutline(context, catalog);
  if (!tree) return 0;
  let total = 0;
  const count = (nodes: readonly OutlineNode[]) => {
    for (const node of nodes) {
      total += 1;
      count(node.children);
    }
  };
  count(tree.items);
  return total;
}

/**
 * Agrupa los marcadores que YA tiene el documento bajo un unico marcador con `title` (que lleva a
 * `firstPageRef`). Sin marcadores, no hace nada. Devuelve `true` si agrupo algo.
 */
export function wrapExistingOutline(
  context: PDFContext,
  catalog: PDFDict,
  title: string,
  firstPageRef: PDFRef,
): boolean {
  const rootObject = catalog.get(KEY.Outlines);
  const root = asDict(context, rootObject);
  if (!root || !(rootObject instanceof PDFRef)) return false;
  const siblings = topLevel(context, root);
  if (siblings.length === 0) return false;
  const visible = numberValue(context, root.get(KEY.Count)) ?? siblings.length;
  const group = context.obj({
    Title: PDFHexString.fromText(title),
    Dest: context.obj([firstPageRef, PDFName.of("Fit")]),
    Parent: rootObject,
    First: siblings[0].ref,
    Last: siblings[siblings.length - 1].ref,
    Count: Math.max(visible, siblings.length),
  });
  const groupRef = context.register(group);
  for (const node of siblings) node.dict.set(KEY.Parent, groupRef);
  root.set(KEY.First, groupRef);
  root.set(KEY.Last, groupRef);
  root.set(KEY.Count, PDFNumber.of(1 + Math.max(visible, siblings.length)));
  return true;
}

/* ------------------------------------------------------------------ *
 * Destinos con nombre, enlaces y accion de apertura
 * ------------------------------------------------------------------ */

/** Quita de los destinos con nombre los que apuntan a paginas que ya no estan. */
export function pruneNamedDests(
  context: PDFContext,
  catalog: PDFDict,
  named: NamedDests,
  isLive: (pageRef: PDFRef) => boolean,
): number {
  let removed = 0;
  const isDead = (value: PDFObject): boolean => {
    const target = destTarget(context, value, named);
    return target.kind === "page" && !isLive(target.ref);
  };

  const legacy = asDict(context, catalog.get(KEY.Dests));
  if (legacy) {
    for (const [name, value] of legacy.entries()) {
      if (isDead(value)) {
        legacy.delete(name);
        removed += 1;
      }
    }
  }
  const names = asDict(context, catalog.get(KEY.Names));
  const tree = names ? asDict(context, names.get(KEY.Dests)) : undefined;
  if (tree) {
    const doomed: { names: PDFArray; index: number }[] = [];
    walkNameTree(context, tree, (_key, value, array, index) => {
      if (isDead(value)) doomed.push({ names: array, index });
    });
    // De atras hacia delante dentro de cada arreglo: cada borrado desplaza los indices siguientes.
    doomed.sort((a, b) => b.index - a.index);
    for (const entry of doomed) {
      entry.names.remove(entry.index + 1);
      entry.names.remove(entry.index);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Si la accion de apertura es un destino que lleva a una pagina que ya no esta, se retira. Devuelve cuantas se retiraron
 * (0 o 1). La accion de apertura en forma de ACCION (`<< /S /GoTo ... >>`, con su cadena `/Next`) la depura
 * `neutralizeDeadReferences`.
 */
export function pruneOpenAction(
  context: PDFContext,
  catalog: PDFDict,
  named: NamedDests,
  isLive: (pageRef: PDFRef) => boolean,
): number {
  const action = catalog.get(KEY.OpenAction);
  if (!action) return 0;
  const value = action instanceof PDFRef ? context.lookup(action) : action;
  const target =
    value instanceof PDFDict ? itemTarget(context, value, named) : destTarget(context, value, named);
  if (target.kind === "broken" || (target.kind === "page" && !isLive(target.ref))) {
    catalog.delete(KEY.OpenAction);
    return 1;
  }
  return 0;
}

function subtypeOf(context: PDFContext, annot: PDFDict): string | undefined {
  return nameValue(context, annot.get(KEY.Subtype));
}

/** Anotaciones de una pagina como pares `[ref|objeto, dict]` (solo las que son diccionarios). */
export function pageAnnots(
  context: PDFContext,
  leaf: PDFDict,
): { array: PDFArray; entries: { item: PDFObject; dict: PDFDict }[] } | undefined {
  const array = asArray(context, leaf.get(KEY.Annots));
  if (!array) return undefined;
  const entries: { item: PDFObject; dict: PDFDict }[] = [];
  for (let index = 0; index < array.size(); index += 1) {
    const item = array.get(index);
    const dict = asDict(context, item);
    if (dict) entries.push({ item, dict });
  }
  return { array, entries };
}

function removeFromArray(array: PDFArray, item: PDFObject): void {
  for (let index = 0; index < array.size(); index += 1) {
    if (array.get(index) === item) {
      array.remove(index);
      return;
    }
  }
}

/** Quita los enlaces internos cuya pagina ya no esta (o cuyo nombre ya no existe). */
export function pruneLinks(
  context: PDFContext,
  leaves: readonly PDFDict[],
  named: NamedDests,
  isLive: (pageRef: PDFRef) => boolean,
): number {
  let removed = 0;
  for (const leaf of leaves) {
    const annots = pageAnnots(context, leaf);
    if (!annots) continue;
    for (const { item, dict } of annots.entries) {
      if (subtypeOf(context, dict) !== "Link") continue;
      const target = itemTarget(context, dict, named);
      if (target.kind === "broken" || (target.kind === "page" && !isLive(target.ref))) {
        removeFromArray(annots.array, item);
        removed += 1;
      }
    }
  }
  return removed;
}

/** Quita de paginas ajenas los enlaces internos (apuntan a paginas que no vienen con ellas). */
export function stripInternalLinks(
  context: PDFContext,
  leaf: PDFDict,
  named: NamedDests,
): number {
  const annots = pageAnnots(context, leaf);
  if (!annots) return 0;
  let removed = 0;
  for (const { item, dict } of annots.entries) {
    if (subtypeOf(context, dict) !== "Link") continue;
    if (itemTarget(context, dict, named).kind !== "none") {
      removeFromArray(annots.array, item);
      removed += 1;
    }
  }
  return removed;
}

/* ------------------------------------------------------------------ *
 * Formularios (AcroForm)
 * ------------------------------------------------------------------ */

/** Valor heredado de un campo (`/FT`, `/Ff`, `/T`...): se busca subiendo por `/Parent`. */
function inherited(context: PDFContext, dict: PDFDict, key: PDFName): PDFObject | undefined {
  let current: PDFDict | undefined = dict;
  const seen = new Set<PDFDict>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const value = current.get(key);
    if (value) return value;
    current = asDict(context, current.get(KEY.Parent));
  }
  return undefined;
}

export function isSignatureWidget(context: PDFContext, widget: PDFDict): boolean {
  return nameValue(context, inherited(context, widget, KEY.FT)) === "Sig";
}

export function isWidget(context: PDFContext, annot: PDFDict): boolean {
  return subtypeOf(context, annot) === "Widget";
}

function acroForm(context: PDFContext, catalog: PDFDict): PDFDict | undefined {
  return asDict(context, catalog.get(KEY.AcroForm));
}

/** Nombres completos (`a.b.c`) de todos los campos del formulario y refs alcanzables desde `/Fields`. */
function collectFieldIndex(
  context: PDFContext,
  catalog: PDFDict,
): { names: Set<string>; refs: Set<string> } {
  const names = new Set<string>();
  const refs = new Set<string>();
  const form = acroForm(context, catalog);
  const fields = form ? asArray(context, form.get(KEY.Fields)) : undefined;
  const visit = (item: PDFObject, prefix: string, depth: number) => {
    if (depth > 64) return;
    if (item instanceof PDFRef) {
      const key = refKey(item);
      if (refs.has(key)) return;
      refs.add(key);
    }
    const dict = asDict(context, item);
    if (!dict) return;
    const partial = textValue(context, dict.get(KEY.T));
    const full = partial !== undefined ? (prefix ? `${prefix}.${partial}` : partial) : prefix;
    if (partial !== undefined) names.add(full);
    const kids = asArray(context, dict.get(KEY.Kids));
    if (kids) for (let index = 0; index < kids.size(); index += 1) visit(kids.get(index), full, depth + 1);
  };
  if (fields) for (let index = 0; index < fields.size(); index += 1) visit(fields.get(index), "", 0);
  return { names, refs };
}

/** Sube por `/Parent` hasta el campo raiz (el que no tiene padre). */
function fieldRoot(
  context: PDFContext,
  widgetRef: PDFObject,
): { ref: PDFObject; dict: PDFDict } | undefined {
  let ref: PDFObject = widgetRef;
  let dict = asDict(context, ref);
  const seen = new Set<PDFDict>();
  while (dict && !seen.has(dict)) {
    seen.add(dict);
    const parent = dict.get(KEY.Parent);
    const parentDict = asDict(context, parent);
    if (!parent || !parentDict) return { ref, dict };
    ref = parent;
    dict = parentDict;
  }
  return undefined;
}

/**
 * Registra en `/AcroForm /Fields` los campos de las paginas NUEVAS (clonadas o copiadas de otro
 * PDF) que aun no cuelgan del formulario, renombrando los que repiten un nombre ya usado.
 * Devuelve cuantos campos se renombraron.
 */
export function registerNewFields(
  context: PDFContext,
  catalog: PDFDict,
  newLeaves: readonly PDFDict[],
): { registered: number; renamed: number } {
  const roots: { ref: PDFObject; dict: PDFDict }[] = [];
  const index = collectFieldIndex(context, catalog);
  const seenRoots = new Set<string>();
  for (const leaf of newLeaves) {
    const annots = pageAnnots(context, leaf);
    if (!annots) continue;
    for (const { item, dict } of annots.entries) {
      if (!isWidget(context, dict)) continue;
      const root = fieldRoot(context, item);
      if (!root || !(root.ref instanceof PDFRef)) continue;
      const key = refKey(root.ref);
      if (index.refs.has(key) || seenRoots.has(key)) continue;
      seenRoots.add(key);
      roots.push(root);
    }
  }
  if (roots.length === 0) return { registered: 0, renamed: 0 };

  let form = acroForm(context, catalog);
  if (!form) {
    form = context.obj({ Fields: [] });
    catalog.set(KEY.AcroForm, context.register(form));
  }
  let fields = asArray(context, form.get(KEY.Fields));
  if (!fields) {
    fields = context.obj([]);
    form.set(KEY.Fields, fields);
  }

  let renamed = 0;
  for (const root of roots) {
    const partial = textValue(context, root.dict.get(KEY.T));
    const base = partial ?? "Field";
    let candidate = base;
    let counter = 2;
    while (index.names.has(candidate)) {
      candidate = `${base}_${counter}`;
      counter += 1;
    }
    if (partial === undefined || candidate !== base) {
      root.dict.set(KEY.T, PDFString.of(candidate));
      if (partial !== undefined) renamed += 1;
    }
    index.names.add(candidate);
    fields.push(root.ref);
  }
  return { registered: roots.length, renamed };
}

/** Referencia a partir de su clave (`refKey`). */
function refFromKey(key: string): PDFRef {
  const [objectNumber, generationNumber] = key.split(" ").map(Number);
  return PDFRef.of(objectNumber, generationNumber);
}

/**
 * Lo que SIGUE vivo del formulario: los widgets que estan en las paginas que se quedan y todo lo que dice ser su campo
 * (`/Parent`, hacia arriba), aunque la lista `/Kids` de ese campo no los nombre — hay generadores que no la llevan al dia —.
 * Un campo asi no se quita nunca: le quedaria un widget suelto apuntando a algo que ya no esta.
 */
export function livingFieldNodes(context: PDFContext, presentWidgets: ReadonlySet<string>): Set<PDFDict> {
  const living = new Set<PDFDict>();
  for (const key of presentWidgets) {
    let dict = asDict(context, refFromKey(key));
    while (dict && !living.has(dict)) {
      living.add(dict);
      dict = asDict(context, dict.get(KEY.Parent));
    }
  }
  return living;
}

const MAX_FIELD_DEPTH = 64;

/**
 * Sube desde widgets que ya no estan por la cadena `/Parent`: un campo (o un grupo) cuyos hijos estan TODOS muertos esta
 * muerto tambien, y asi hacia arriba. Es lo que atrapa un campo APARTE de su widget (el campo lleva `/T` y `/V`, el widget solo
 * `/Parent`) que algo que se conserva sigue nombrando — el orden de calculo `/CO`, la lista `/Fields` de una accion de
 * reinicio...—: sin ello el widget se iba y el campo se quedaba con `/Kids []` y su valor.
 *
 * `dead` son las claves de lo muerto (se AMPLIA con los widgets dados y con cada campo que muere). Lo vivo no se toca: ni lo que
 * esta en `living` ni un campo con algun hijo vivo. Devuelve los campos y grupos que murieron y cuantos CAMPOS (el de mas abajo
 * con nombre de cada rama, `/T`) fueron: lo que debe contar el aviso de «campos quitados».
 */
export function climbDeadFields(
  context: PDFContext,
  widgets: readonly PDFRef[],
  dead: Set<string>,
  living: ReadonlySet<PDFDict>,
): { refs: PDFRef[]; fields: number } {
  const refs: PDFRef[] = [];
  let fields = 0;
  /** Un hijo esta muerto si es un objeto muerto o ya no existe; un diccionario escrito en el sitio no se puede dar por muerto. */
  const isGone = (kid: PDFObject): boolean => {
    if (kid instanceof PDFRef) return dead.has(refKey(kid)) || context.lookup(kid) === undefined;
    return !(kid instanceof PDFDict);
  };
  for (const widget of widgets) dead.add(refKey(widget));
  for (const widget of widgets) {
    const dict = asDict(context, widget);
    if (!dict) continue;
    // Campo y widget fusionados: el propio widget es el campo.
    let counted = dict.has(KEY.T);
    if (counted) fields += 1;
    let parentRef = dict.get(KEY.Parent);
    for (let depth = 0; parentRef instanceof PDFRef && depth < MAX_FIELD_DEPTH; depth += 1) {
      if (dead.has(refKey(parentRef))) break;
      const parent = asDict(context, parentRef);
      if (!parent || living.has(parent)) break;
      const kids = asArray(context, parent.get(KEY.Kids));
      if (!kids) break;
      let everyKidGone = true;
      for (let index = 0; index < kids.size() && everyKidGone; index += 1) everyKidGone = isGone(kids.get(index));
      if (!everyKidGone) break;
      dead.add(refKey(parentRef));
      refs.push(parentRef);
      if (!counted && parent.has(KEY.T)) {
        fields += 1;
        counted = true;
      }
      parentRef = parent.get(KEY.Parent);
    }
  }
  return { refs, fields };
}

export type AcroFormPrune = {
  /** Campos (los de mas abajo con nombre, no los grupos que los contenian) que se quitaron: lo que se avisa. */
  removed: number;
  /**
   * TODO lo que se quito del formulario (campos, grupos y widgets): hay que cortarlo de cualquier otro sitio que lo nombre
   * (`/CO`, la accion de un boton...) o el campo, su `/V` y su `/DV` seguirian dentro del archivo (ver `neutralizeDeadReferences`).
   */
  deadNodes: PDFRef[];
};

/**
 * Tras quitar paginas: quita del formulario los campos/widgets que ya no estan en ninguna pagina final, y los campos y grupos
 * que se quedan sin ningun hijo (en cascada: `grupo.subgrupo.campo` se va entero si su unico widget se fue). Un campo sin widgets
 * que nunca los tuvo se conserva (es un campo oculto valido). `deadLeaves` son las hojas quitadas: sus widgets sirven para dar con
 * los campos que NO cuelgan de `/Fields` (solo los nombra, por ejemplo, el orden de calculo).
 */
export function pruneAcroForm(
  context: PDFContext,
  catalog: PDFDict,
  presentWidgets: ReadonlySet<string>,
  deadLeaves: readonly PDFDict[] = [],
): AcroFormPrune {
  const form = acroForm(context, catalog);
  const fields = form ? asArray(context, form.get(KEY.Fields)) : undefined;
  const living = livingFieldNodes(context, presentWidgets);
  /** Lo ya juzgado: un campo al que se llega por dos caminos (o listado dos veces) se juzga y se cuenta UNA vez. */
  const verdicts = new Map<PDFDict, boolean>();
  const gone = new Map<string, PDFRef>();
  let removed = 0;

  // `fields`: cuantos campos (de abajo con nombre) se fueron bajo el nodo. Un nodo muerto que no tiene debajo ninguno con nombre
  // cuenta como uno si lleva `/T`.
  const visit = (item: PDFObject, depth: number): { alive: boolean; fields: number } => {
    if (depth > MAX_FIELD_DEPTH) return { alive: true, fields: 0 };
    const dict = asDict(context, item);
    if (!dict) return { alive: false, fields: 0 };
    const judged = verdicts.get(dict);
    if (judged !== undefined) return { alive: judged, fields: 0 };
    verdicts.set(dict, true);
    let alive = true;
    let below = 0;
    if (isWidget(context, dict) && item instanceof PDFRef && !presentWidgets.has(refKey(item))) {
      alive = false;
    } else {
      const kids = asArray(context, dict.get(KEY.Kids));
      if (kids && kids.size() > 0) {
        for (let index = kids.size() - 1; index >= 0; index -= 1) {
          const kid = visit(kids.get(index), depth + 1);
          below += kid.fields;
          if (!kid.alive) kids.remove(index);
        }
        if (kids.size() === 0) alive = false;
      }
    }
    if (!alive && living.has(dict)) alive = true;
    verdicts.set(dict, alive);
    if (alive) return { alive, fields: below };
    if (item instanceof PDFRef) gone.set(refKey(item), item);
    return { alive, fields: below > 0 || !dict.has(KEY.T) ? below : 1 };
  };

  if (fields) {
    for (let index = fields.size() - 1; index >= 0; index -= 1) {
      const root = visit(fields.get(index), 0);
      removed += root.fields;
      if (!root.alive) fields.remove(index);
    }
  }

  // Campos que no cuelgan de `/Fields`: se llega a ellos desde los widgets de las hojas quitadas.
  const strayWidgets: PDFRef[] = [];
  for (const leaf of deadLeaves) {
    const annots = pageAnnots(context, leaf);
    if (!annots) continue;
    for (const { item, dict } of annots.entries) {
      if (item instanceof PDFRef && isWidget(context, dict) && !presentWidgets.has(refKey(item)) && !verdicts.has(dict)) {
        strayWidgets.push(item);
      }
    }
  }
  const dead = new Set(gone.keys());
  const climbed = climbDeadFields(context, strayWidgets, dead, living);
  removed += climbed.fields;
  return { removed, deadNodes: [...gone.values(), ...strayWidgets, ...climbed.refs] };
}

/** Referencias de todos los widgets presentes en las paginas dadas. */
export function collectPresentWidgets(
  context: PDFContext,
  leaves: readonly PDFDict[],
): Set<string> {
  const present = new Set<string>();
  for (const leaf of leaves) {
    const annots = pageAnnots(context, leaf);
    if (!annots) continue;
    for (const { item, dict } of annots.entries) {
      if (item instanceof PDFRef && isWidget(context, dict)) present.add(refKey(item));
    }
  }
  return present;
}

/** Marcas privadas de un enlace interno ya resuelto a una pagina del documento ORIGEN (ver `sanitizeLeavesForCopy`). */
export const LINK_PAGE = N("OptimusLinkPage");
export const LINK_TAIL = N("OptimusLinkTail");

/** Matriz de un destino (explicito, con nombre o `<< /D [...] >>`), o `undefined` si no hay. */
function destArrayOf(
  context: PDFContext,
  dest: PDFObject | undefined,
  named: NamedDests,
  depth = 0,
): PDFArray | undefined {
  if (!dest || depth > 4) return undefined;
  const value = dest instanceof PDFRef ? context.lookup(dest) : dest;
  if (value instanceof PDFArray) return value;
  if (value instanceof PDFDict) return destArrayOf(context, value.get(KEY.D), named, depth + 1);
  if (value instanceof PDFName || value instanceof PDFString || value instanceof PDFHexString) {
    return destArrayOf(context, named.get(value.decodeText()), named, depth + 1);
  }
  return undefined;
}

/** `/Dest` o `/A << /S /GoTo /D ... >>` de un enlace: el objeto que dice a donde va. */
function linkDestObject(context: PDFContext, item: PDFDict): PDFObject | undefined {
  const direct = item.get(KEY.Dest);
  if (direct) return direct;
  const action = asDict(context, item.get(KEY.A));
  return action && nameValue(context, action.get(KEY.S)) === "GoTo" ? action.get(KEY.D) : undefined;
}

const MAX_ACTION_CHAIN = 64;
const BEADS = N("B");

/**
 * Recorre una cadena de acciones (una accion, o un arreglo de ellas, con sus `/Next` en cadena) y llama a `visit` con el
 * diccionario de cada una. Solo cuentan los diccionarios que tienen `/S` (tipo de accion).
 */
export function walkActionChain(
  context: PDFContext,
  value: PDFObject | undefined,
  visit: (action: PDFDict) => void,
  depth = 0,
  seen: Set<PDFDict> = new Set(),
): void {
  if (!value || depth > MAX_ACTION_CHAIN) return;
  const resolved = value instanceof PDFRef ? context.lookup(value) : value;
  if (resolved instanceof PDFArray) {
    for (let index = 0; index < resolved.size(); index += 1) {
      walkActionChain(context, resolved.get(index), visit, depth + 1, seen);
    }
    return;
  }
  if (!(resolved instanceof PDFDict) || seen.has(resolved)) return;
  if (nameValue(context, resolved.get(KEY.S)) === undefined) return;
  seen.add(resolved);
  visit(resolved);
  walkActionChain(context, resolved.get(KEY.Next), visit, depth + 1, seen);
}

const PAGE_ACTION = N("PA");
const ADDITIONAL_ACTIONS = N("AA");

/**
 * Sitios de una hoja donde cuelgan acciones, como pares `(diccionario, clave)`: el `/AA` de la hoja y, de cada anotacion
 * (de cualquier tipo), su `/A`, su `/PA` y su `/AA`.
 */
export function forEachActionHolder(
  context: PDFContext,
  leaf: PDFDict,
  visit: (holder: PDFDict, key: PDFName) => void,
): void {
  const triggers = (holder: PDFDict) => {
    const aa = asDict(context, holder.get(ADDITIONAL_ACTIONS));
    if (aa) for (const key of aa.keys()) visit(aa, key);
  };
  triggers(leaf);
  const annots = pageAnnots(context, leaf);
  if (!annots) return;
  for (const { dict } of annots.entries) {
    visit(dict, KEY.A);
    visit(dict, PAGE_ACTION);
    triggers(dict);
  }
}

/** Marca con la pagina de ORIGEN a la que llevan las acciones de salto (`GoTo`) de una hoja (ver `sanitizeLeavesForCopy`). */
function markGoToActions(
  context: PDFContext,
  leaf: PDFDict,
  named: NamedDests,
  pageIndexByRef: ReadonlyMap<string, number>,
): void {
  forEachActionHolder(context, leaf, (holder, key) => {
    walkActionChain(context, holder.get(key), (action) => {
      if (nameValue(context, action.get(KEY.S)) !== "GoTo" || action.has(LINK_PAGE)) return;
      const target = destTarget(context, action.get(KEY.D), named);
      const index = target.kind === "page" ? pageIndexByRef.get(refKey(target.ref)) : undefined;
      if (index === undefined) return;
      const array = destArrayOf(context, action.get(KEY.D), named);
      const tail = (array ? explicitDestTail(context, array) : undefined) ?? [PDFName.of("Fit")];
      action.set(LINK_PAGE, PDFNumber.of(index));
      action.set(LINK_TAIL, context.obj(tail));
      action.delete(KEY.D);
    });
  });
}

/**
 * Prepara paginas de OTRO documento para copiarlas sin arrastrar el documento entero:
 *  - `/P` de cada anotacion se quita (apunta a la pagina original; `copyPages` la copiaria entera);
 *  - `/StructParents` de la hoja y `/StructParent` de sus anotaciones se quitan: son claves del arbol
 *    de estructura del documento ORIGEN y, en el destino, apuntarian a otra cosa;
 *  - los campos de firma se quitan (su valor firmado no sobrevive a la copia);
 *  - del arbol de cada campo solo se dejan los widgets de estas paginas (y no se arrastran los demas);
 *  - los enlaces internos: con `pageIndexByRef` (hoja del origen -> indice) se MARCAN con el indice de la
 *    pagina a la que llevan y se les quita `/Dest`/`/A` (si no, `copyPages` copiaria la pagina de
 *    destino entera); tras copiar, `resolveMarkedLinks` los reapunta a la pagina copiada, o los quita
 *    si esa pagina no vino. Sin `pageIndexByRef` se quitan todos (comportamiento anterior);
 *  - lo mismo para las acciones de salto (`GoTo`) que no son un enlace: botones y otras anotaciones (`/A`, `/PA`, `/AA`) y
 *    el `/AA` de la hoja, con sus cadenas `/Next`: se marcan aqui y las reapunta `resolveMarkedActions` tras copiar;
 *  - las cuentas de articulo (`/B`) se quitan: los articulos (`/Threads`) cuelgan del catalogo del origen y no viajan, y cada
 *    cuenta arrastraria al copiador las paginas de todo su articulo.
 * Devuelve cuantos enlaces (y cuentas de articulo) y cuantas firmas se quitaron, aparte los campos de firma VACIOS y las
 * firmas YA APLICADAS (los enlaces marcados no cuentan aun).
 */
export function sanitizeLeavesForCopy(
  context: PDFContext,
  catalog: PDFDict,
  leaves: readonly PDFDict[],
  pageIndexByRef?: ReadonlyMap<string, number>,
): { linksRemoved: number; emptySignaturesRemoved: number; signedSignaturesRemoved: number } {
  const named = collectNamedDests(context, catalog);
  let linksRemoved = 0;
  let emptySignaturesRemoved = 0;
  let signedSignaturesRemoved = 0;
  const keepWidgets = new Set<string>();

  for (const leaf of leaves) {
    leaf.delete(KEY.StructParents);
    const beads = asArray(context, leaf.get(BEADS));
    if (beads) {
      linksRemoved += beads.size();
      leaf.delete(BEADS);
    }
    const annots = pageAnnots(context, leaf);
    if (!annots) continue;
    for (const { item, dict } of annots.entries) {
      if (subtypeOf(context, dict) === "Link") {
        const target = itemTarget(context, dict, named);
        if (target.kind !== "none") {
          const index = target.kind === "page" ? pageIndexByRef?.get(refKey(target.ref)) : undefined;
          if (index === undefined) {
            removeFromArray(annots.array, item);
            linksRemoved += 1;
            continue;
          }
          const array = destArrayOf(context, linkDestObject(context, dict), named);
          const tail = (array ? explicitDestTail(context, array) : undefined) ?? [PDFName.of("Fit")];
          dict.set(LINK_PAGE, PDFNumber.of(index));
          dict.set(LINK_TAIL, context.obj(tail));
          dict.delete(KEY.Dest);
          dict.delete(KEY.A);
        }
      }
      dict.delete(KEY.P);
      dict.delete(KEY.StructParent);
      if (isWidget(context, dict)) {
        if (isSignatureWidget(context, dict)) {
          removeFromArray(annots.array, item);
          // Un campo de firma VACIO (sin firmar) no es lo mismo que una firma YA APLICADA (`/V`, diccionario de firma).
          if (asDict(context, inherited(context, dict, KEY.V))) signedSignaturesRemoved += 1;
          else emptySignaturesRemoved += 1;
        } else if (item instanceof PDFRef) {
          keepWidgets.add(refKey(item));
        }
      }
    }
  }

  // Las acciones de salto que no son un enlace (botones, `/AA`): despues de los enlaces, que ya quitaron su `/A`.
  if (pageIndexByRef) for (const leaf of leaves) markGoToActions(context, leaf, named, pageIndexByRef);

  // Recortar el arbol de campos de cada widget que se queda a los widgets de estas paginas.
  const pruned = new Set<string>();
  const prune = (item: PDFObject, depth: number): boolean => {
    if (depth > 64) return true;
    const dict = asDict(context, item);
    if (!dict) return false;
    if (item instanceof PDFRef && keepWidgets.has(refKey(item))) return true;
    const kids = asArray(context, dict.get(KEY.Kids));
    if (!kids) return false;
    for (let index = kids.size() - 1; index >= 0; index -= 1) {
      if (!prune(kids.get(index), depth + 1)) kids.remove(index);
    }
    return kids.size() > 0;
  };
  for (const leaf of leaves) {
    const annots = pageAnnots(context, leaf);
    if (!annots) continue;
    for (const { item, dict } of annots.entries) {
      if (!isWidget(context, dict)) continue;
      const root = fieldRoot(context, item);
      if (!root || !(root.ref instanceof PDFRef)) continue;
      const key = refKey(root.ref);
      if (pruned.has(key)) continue;
      pruned.add(key);
      if (root.ref !== item) prune(root.ref, 0);
    }
  }
  return { linksRemoved, emptySignaturesRemoved, signedSignaturesRemoved };
}

/**
 * Tras `copyPages`: reapunta los enlaces marcados por `sanitizeLeavesForCopy` a las hojas COPIADAS
 * (`targetOf(indiceEnElOrigen)` -> hoja del documento destino) y quita los que llevan a una pagina que
 * no vino. Devuelve cuantos enlaces se quitaron.
 */
export function resolveMarkedLinks(
  context: PDFContext,
  leaves: readonly PDFDict[],
  targetOf: (sourceIndex: number) => PDFRef | undefined,
): number {
  let removed = 0;
  for (const leaf of leaves) {
    const annots = pageAnnots(context, leaf);
    if (!annots) continue;
    for (const { item, dict } of annots.entries) {
      const index = numberValue(context, dict.get(LINK_PAGE));
      if (index === undefined) continue;
      const target = targetOf(index);
      if (target) {
        const tail = asArray(context, dict.get(LINK_TAIL));
        const rest: PDFObject[] = [];
        if (tail) for (let at = 0; at < tail.size(); at += 1) rest.push(tail.get(at));
        dict.set(KEY.Dest, context.obj([target, ...rest]));
      } else {
        removeFromArray(annots.array, item);
        removed += 1;
      }
      dict.delete(LINK_PAGE);
      dict.delete(LINK_TAIL);
    }
  }
  return removed;
}

/* ------------------------------------------------------------------ *
 * Hojas: materializar atributos heredados, clonar, rotar
 * ------------------------------------------------------------------ */

const INHERITABLE = ["Resources", "MediaBox", "CropBox", "Rotate"] as const;

/** Copia a la hoja los atributos que heredaba del arbol (al aplanar el arbol no se pueden perder). */
export function materializeInherited(leaf: PDFPageLeaf): void {
  for (const name of INHERITABLE) {
    const key = N(name);
    if (leaf.get(key)) continue;
    const value = leaf.getInheritableAttribute(key);
    if (value) leaf.set(key, value);
  }
}

/** Rotacion actual de una hoja (ya materializada o heredada), normalizada a 0..359. */
export function leafRotation(leaf: PDFPageLeaf): number {
  const raw = leaf.Rotate()?.asNumber() ?? 0;
  return ((raw % 360) + 360) % 360;
}

export function setLeafRotation(leaf: PDFPageLeaf, degrees: number): void {
  const value = ((degrees % 360) + 360) % 360;
  if (value === 0 && !leaf.get(KEY.Rotate)) return;
  leaf.set(KEY.Rotate, PDFNumber.of(value));
}

/**
 * Clona una hoja del MISMO documento: comparte contenido y recursos (son inmutables, y varias
 * hojas pueden apuntar al mismo flujo) y crea anotaciones propias que apuntan a la hoja nueva.
 * Los widgets con campo padre se anaden a ese campo (mismo valor en las dos hojas); los widgets
 * sueltos pasan a ser campos nuevos (los registra `registerNewFields`); las firmas no se clonan.
 */
export function cloneLeafInPlace(
  context: PDFContext,
  source: PDFPageLeaf,
): { leaf: PDFPageLeaf; ref: PDFRef } {
  const clone = source.clone() as PDFPageLeaf;
  clone.delete(N("StructParents"));
  const cloneRef = context.register(clone);
  const annots = asArray(context, source.get(KEY.Annots));
  if (annots) {
    const next = context.obj([]);
    for (let index = 0; index < annots.size(); index += 1) {
      const dict = asDict(context, annots.get(index));
      if (!dict) continue;
      const subtype = subtypeOf(context, dict);
      if (subtype === "Popup") continue;
      if (subtype === "Widget" && isSignatureWidget(context, dict)) continue;
      const copy = dict.clone(context);
      copy.set(KEY.P, cloneRef);
      copy.delete(KEY.Popup);
      const copyRef = context.register(copy);
      if (subtype === "Widget") {
        const parent = asDict(context, copy.get(KEY.Parent));
        const kids = parent ? asArray(context, parent.get(KEY.Kids)) : undefined;
        if (kids) kids.push(copyRef);
        else copy.delete(KEY.Parent);
      }
      next.push(copyRef);
    }
    clone.set(KEY.Annots, next);
  }
  return { leaf: clone, ref: cloneRef };
}

/** Tras `copyPages`: cada anotacion de la hoja nueva apunta a ELLA (no a la copia huerfana). */
export function fixCopiedLeaf(context: PDFContext, leaf: PDFDict, leafRef: PDFRef): void {
  const annots = pageAnnots(context, leaf);
  if (!annots) return;
  for (const { dict } of annots.entries) dict.set(KEY.P, leafRef);
}

/* ------------------------------------------------------------------ *
 * Estructura etiquetada, etiquetas de pagina
 * ------------------------------------------------------------------ */

/** Quita el arbol de estructura (PDF etiquetado): sus `/Pg` mantendrian vivas las paginas quitadas. */
export function dropStructureTree(catalog: PDFDict): boolean {
  const had = catalog.has(KEY.StructTreeRoot);
  catalog.delete(KEY.StructTreeRoot);
  catalog.delete(KEY.MarkInfo);
  return had;
}

export function hasStructureTree(catalog: PDFDict): boolean {
  return catalog.has(KEY.StructTreeRoot);
}

export function dropPageLabels(catalog: PDFDict): boolean {
  const had = catalog.has(KEY.PageLabels);
  catalog.delete(KEY.PageLabels);
  return had;
}

/**
 * Cuantas firmas digitales YA APLICADAS tiene el documento: campos `/FT /Sig` del formulario cuyo `/V`
 * es un diccionario de firma. Reescribir el archivo las deja invalidas (cubren los bytes exactos).
 */
export function countSignedSignatures(context: PDFContext, catalog: PDFDict): number {
  const form = acroForm(context, catalog);
  const fields = form ? asArray(context, form.get(KEY.Fields)) : undefined;
  if (!fields) return 0;
  let count = 0;
  let budget = 200_000;
  const seen = new Set<PDFDict>();
  const visit = (item: PDFObject, depth: number) => {
    if (depth > 64 || budget <= 0) return;
    budget -= 1;
    const dict = asDict(context, item);
    if (!dict || seen.has(dict)) return;
    seen.add(dict);
    // `/V` propio: los widgets hijos heredan el campo y no se cuentan otra vez.
    if (dict.has(KEY.V) && asDict(context, dict.get(KEY.V)) && nameValue(context, inherited(context, dict, KEY.FT)) === "Sig") {
      count += 1;
    }
    const kids = asArray(context, dict.get(KEY.Kids));
    if (kids) for (let index = 0; index < kids.size(); index += 1) visit(kids.get(index), depth + 1);
  };
  for (let index = 0; index < fields.size(); index += 1) visit(fields.get(index), 0);
  return count;
}

/* ------------------------------------------------------------------ *
 * Poda del arbol de estructura (PDF etiquetado)
 * ------------------------------------------------------------------ */

const STRUCT_MAX_ELEMENTS = 400_000;
const STRUCT_MAX_DEPTH = 400;

type NumberEntry = { key: number; value: PDFObject };

/** Recorre un arbol de numeros (`/Nums`, `/Kids`). `false` si no se pudo leer con seguridad. */
function readNumberTree(context: PDFContext, node: PDFDict | undefined, out: NumberEntry[]): boolean {
  const seen = new Set<PDFDict>();
  let budget = 20_000;
  const visit = (current: PDFDict | undefined, depth: number): boolean => {
    if (!current) return true;
    if (seen.has(current) || depth > 64 || budget <= 0) return false;
    seen.add(current);
    budget -= 1;
    const nums = asArray(context, current.get(N("Nums")));
    if (nums) {
      for (let index = 0; index + 1 < nums.size(); index += 2) {
        const key = numberValue(context, nums.get(index));
        if (key === undefined || !Number.isInteger(key)) return false;
        out.push({ key, value: nums.get(index + 1) });
        if (out.length > 2_000_000) return false;
      }
    }
    const kids = asArray(context, current.get(KEY.Kids));
    if (kids) {
      for (let index = 0; index < kids.size(); index += 1) {
        if (!visit(asDict(context, kids.get(index)), depth + 1)) return false;
      }
    }
    return true;
  };
  return visit(node, 0);
}

/**
 * Poda el arbol de estructura de un PDF etiquetado a las paginas que se quedan: los contenidos
 * marcados, referencias a objetos y elementos de estructura cuya pagina se quito desaparecen (y con
 * ellos los elementos que se quedan sin contenido), y se limpian el arbol de padres (`/ParentTree`) y
 * el de identificadores (`/IDTree`). Las paginas que se quedan conservan sus etiquetas.
 *
 * `deadPages`: claves (`refKey`) de las hojas quitadas; `deadLeaves`: esas hojas (sus claves de
 * estructura salen del arbol de padres). Devuelve `false` si el arbol no se pudo podar con seguridad
 * (forma inesperada, demasiado grande o demasiado profundo): quien llama lo quita entero y avisa.
 * En ese caso puede haber quedado a medias: no debe usarse.
 */
export function pruneStructureTree(
  context: PDFContext,
  catalog: PDFDict,
  deadPages: ReadonlySet<string>,
  deadLeaves: readonly PDFDict[],
): boolean {
  const root = asDict(context, catalog.get(KEY.StructTreeRoot));
  if (!root) return false;
  const isDead = (page: PDFObject | undefined): boolean => page instanceof PDFRef && deadPages.has(refKey(page));
  const removedElements = new Set<string>();
  const seen = new Set<PDFDict>();
  let budget = STRUCT_MAX_ELEMENTS;
  let failed = false;

  /** Hijos de un elemento (o de la raiz): lista de objetos y, si `/K` es un arreglo, ese arreglo. */
  const readKids = (holder: PDFDict): { items: PDFObject[]; array: PDFArray | undefined } => {
    const k = holder.get(KEY.K);
    if (k === undefined) return { items: [], array: undefined };
    const resolved = k instanceof PDFRef ? context.lookup(k) : k;
    if (resolved instanceof PDFArray) {
      const items: PDFObject[] = [];
      for (let index = 0; index < resolved.size(); index += 1) items.push(resolved.get(index));
      return { items, array: resolved };
    }
    return { items: [k], array: undefined };
  };

  const itemAlive = (item: PDFObject, holder: PDFDict, depth: number): boolean => {
    if (item instanceof PDFNumber) return !isDead(holder.get(KEY.Pg));
    const dict = asDict(context, item);
    if (!dict) return true;
    const type = nameValue(context, dict.get(KEY.Type));
    if (type === "MCR") return !isDead(dict.get(KEY.Pg) ?? holder.get(KEY.Pg));
    if (type === "OBJR") {
      const page = dict.get(KEY.Pg) ?? holder.get(KEY.Pg);
      if (page) return !isDead(page);
      return !isDead(asDict(context, dict.get(KEY.Obj))?.get(KEY.P));
    }
    const alive = pruneElement(dict, depth + 1);
    if (!alive && item instanceof PDFRef) removedElements.add(refKey(item));
    return alive;
  };

  /** Quita los hijos muertos de `holder`; devuelve cuantos se quedan. */
  const pruneKids = (holder: PDFDict, depth: number): number => {
    const { items, array } = readKids(holder);
    const dead: number[] = [];
    items.forEach((item, index) => {
      if (!itemAlive(item, holder, depth)) dead.push(index);
    });
    if (dead.length > 0) {
      if (array) for (let at = dead.length - 1; at >= 0; at -= 1) array.remove(dead[at]);
      else holder.delete(KEY.K);
    }
    return items.length - dead.length;
  };

  const pruneElement = (dict: PDFDict, depth: number): boolean => {
    if (depth > STRUCT_MAX_DEPTH || budget <= 0) {
      failed = true;
      return true;
    }
    budget -= 1;
    if (seen.has(dict)) return true;
    seen.add(dict);
    const hadKids = dict.has(KEY.K);
    const kept = pruneKids(dict, depth);
    // Sin contenido propio (p. ej. una figura con texto alternativo): vive mientras viva su pagina.
    if (!hadKids) return !isDead(dict.get(KEY.Pg));
    if (kept === 0) return false;
    // Lo que queda lleva su propia pagina: la del elemento ya no existe y no debe quedar referenciada.
    if (isDead(dict.get(KEY.Pg))) dict.delete(KEY.Pg);
    return true;
  };

  if (pruneKids(root, 0) === 0 || failed) return false;

  // Arbol de padres: fuera las claves de las paginas quitadas (y de sus anotaciones).
  const deadKeys = new Set<number>();
  for (const leaf of deadLeaves) {
    const own = numberValue(context, leaf.get(KEY.StructParents));
    if (own !== undefined) deadKeys.add(own);
    const annots = pageAnnots(context, leaf);
    if (!annots) continue;
    for (const { dict } of annots.entries) {
      const key = numberValue(context, dict.get(KEY.StructParent));
      if (key !== undefined) deadKeys.add(key);
    }
  }
  const parentTree = asDict(context, root.get(KEY.ParentTree));
  if (parentTree) {
    const entries: NumberEntry[] = [];
    if (!readNumberTree(context, parentTree, entries)) return false;
    let changed = false;
    const rebuilt: PDFObject[] = [];
    for (const { key, value } of entries) {
      if (deadKeys.has(key)) {
        changed = true;
        continue;
      }
      const resolved = value instanceof PDFRef ? context.lookup(value) : value;
      if (resolved instanceof PDFArray) {
        let live = false;
        for (let index = 0; index < resolved.size(); index += 1) {
          const element = resolved.get(index);
          if (element instanceof PDFRef && removedElements.has(refKey(element))) {
            resolved.set(index, PDFNull);
            changed = true;
          } else if (element !== PDFNull) {
            live = true;
          }
        }
        if (!live) {
          changed = true;
          continue;
        }
      } else if (value instanceof PDFRef && removedElements.has(refKey(value))) {
        changed = true;
        continue;
      }
      rebuilt.push(PDFNumber.of(key), value);
    }
    if (changed) root.set(KEY.ParentTree, context.obj({ Nums: rebuilt }));
  }

  // Arbol de identificadores: fuera los elementos que ya no existen.
  const idTree = asDict(context, root.get(KEY.IDTree));
  if (idTree && removedElements.size > 0) {
    const kept: PDFObject[] = [];
    let changed = false;
    walkNameTree(context, idTree, (_key, value, names, index) => {
      if (value instanceof PDFRef && removedElements.has(refKey(value))) {
        changed = true;
        return;
      }
      kept.push(names.get(index), value);
    });
    if (changed) root.set(KEY.IDTree, context.obj({ Names: kept }));
  }
  return !failed;
}

/* ------------------------------------------------------------------ *
 * Recolector de basura
 * ------------------------------------------------------------------ */

/**
 * Suelta los objetos que ya no cuelgan del catalogo ni del trailer (paginas quitadas, su
 * contenido, anotaciones, destinos...). Sin esto el archivo no adelgaza al eliminar paginas y
 * el contenido de las quitadas seguiria dentro del archivo. Devuelve cuantos objetos soltó.
 */
export function collectGarbage(context: PDFContext): number {
  const reached = new Set<string>();
  const stack: PDFObject[] = [];
  const { Root, Info, Encrypt, ID } = context.trailerInfo;
  for (const seed of [Root, Info, Encrypt, ID]) if (seed) stack.push(seed);

  const push = (value: PDFObject | undefined) => {
    if (value) stack.push(value);
  };

  while (stack.length > 0) {
    const current = stack.pop() as PDFObject;
    let value: PDFObject | undefined = current;
    if (current instanceof PDFRef) {
      const key = refKey(current);
      if (reached.has(key)) continue;
      reached.add(key);
      value = context.lookup(current);
    }
    if (value instanceof PDFDict) {
      for (const child of value.values()) push(child);
    } else if (value instanceof PDFArray) {
      for (let index = 0; index < value.size(); index += 1) push(value.get(index));
    } else if (value instanceof PDFStream) {
      for (const child of value.dict.values()) push(child);
    }
  }

  let released = 0;
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!reached.has(refKey(ref))) {
      context.delete(ref);
      released += 1;
    }
  }
  return released;
}
