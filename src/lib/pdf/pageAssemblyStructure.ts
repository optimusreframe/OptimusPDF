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

function nameValue(context: PDFContext, object: PDFObject | undefined): string | undefined {
  const value = object instanceof PDFRef ? context.lookup(object) : object;
  return value instanceof PDFName ? value.decodeText() : undefined;
}

function textValue(context: PDFContext, object: PDFObject | undefined): string | undefined {
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

/** Si la accion de apertura lleva a una pagina que ya no esta, se retira. */
export function pruneOpenAction(
  context: PDFContext,
  catalog: PDFDict,
  named: NamedDests,
  isLive: (pageRef: PDFRef) => boolean,
): void {
  const action = catalog.get(KEY.OpenAction);
  if (!action) return;
  const value = action instanceof PDFRef ? context.lookup(action) : action;
  const target =
    value instanceof PDFDict ? itemTarget(context, value, named) : destTarget(context, value, named);
  if (target.kind === "broken" || (target.kind === "page" && !isLive(target.ref))) {
    catalog.delete(KEY.OpenAction);
  }
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

/**
 * Tras quitar paginas: quita del formulario los campos/widgets que ya no estan en ninguna pagina
 * final. Un campo sin widgets que nunca los tuvo se conserva (es un campo oculto valido).
 */
export function pruneAcroForm(
  context: PDFContext,
  catalog: PDFDict,
  presentWidgets: ReadonlySet<string>,
): number {
  const form = acroForm(context, catalog);
  const fields = form ? asArray(context, form.get(KEY.Fields)) : undefined;
  if (!form || !fields) return 0;
  let removed = 0;

  // Devuelve `true` si el nodo debe quedarse.
  const keep = (item: PDFObject, depth: number): boolean => {
    if (depth > 64) return true;
    const dict = asDict(context, item);
    if (!dict) return false;
    const isAnnot = isWidget(context, dict);
    if (isAnnot && item instanceof PDFRef && !presentWidgets.has(refKey(item))) {
      if (dict.has(KEY.T)) removed += 1;
      return false;
    }
    const kids = asArray(context, dict.get(KEY.Kids));
    if (kids && kids.size() > 0) {
      for (let index = kids.size() - 1; index >= 0; index -= 1) {
        if (!keep(kids.get(index), depth + 1)) kids.remove(index);
      }
      if (kids.size() === 0) {
        if (dict.has(KEY.T)) removed += 1;
        return false;
      }
    }
    return true;
  };

  for (let index = fields.size() - 1; index >= 0; index -= 1) {
    if (!keep(fields.get(index), 0)) fields.remove(index);
  }
  return removed;
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

/**
 * Prepara paginas de OTRO documento para copiarlas sin arrastrar el documento entero:
 *  - `/P` de cada anotacion se quita (apunta a la pagina original; `copyPages` la copiaria entera);
 *  - los enlaces internos se quitan (llevan a paginas que no vienen);
 *  - los campos de firma se quitan (su valor firmado no sobrevive a la copia);
 *  - del arbol de cada campo solo se dejan los widgets de estas paginas (y no se arrastran los demas).
 * Devuelve cuantos enlaces y cuantas firmas se quitaron.
 */
export function sanitizeLeavesForCopy(
  context: PDFContext,
  catalog: PDFDict,
  leaves: readonly PDFDict[],
): { linksRemoved: number; signaturesRemoved: number } {
  const named = collectNamedDests(context, catalog);
  let linksRemoved = 0;
  let signaturesRemoved = 0;
  const keepWidgets = new Set<string>();

  for (const leaf of leaves) {
    linksRemoved += stripInternalLinks(context, leaf, named);
    const annots = pageAnnots(context, leaf);
    if (!annots) continue;
    for (const { item, dict } of annots.entries) {
      dict.delete(KEY.P);
      if (isWidget(context, dict)) {
        if (isSignatureWidget(context, dict)) {
          removeFromArray(annots.array, item);
          signaturesRemoved += 1;
        } else if (item instanceof PDFRef) {
          keepWidgets.add(refKey(item));
        }
      }
    }
  }

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
  return { linksRemoved, signaturesRemoved };
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
