import {
  nextBlockId,
  type DocId,
  type SignerBlock,
} from "@/app/sign-pdf/docSet";
import { MAX_OUTPUT_FILES, normalizeCopies } from "@/lib/pdf/signCopies";
import type { SignatureFieldType, Signer } from "@/lib/pdf/sign";
import type { NameLang } from "@/lib/pdf/signOutputNames";

/*
 * «¿Quien firma que?» (Firma agil · Fase 1 · U1.1): la CAPA DE PRESENTACION de los bloques. Sin tocar el nucleo
 * (`SignerBlock`, `ensureBlocks`, `setBlockScope` siguen igual), una tabla documentos x firmantes en la que cada celda
 * es un GRUPO de firma («A», «B»...) o `null` («no firma ahi»). Un grupo es un bloque con nombre visible: todos los
 * documentos de una misma columna con la misma letra comparten UN trazo (firma + iniciales).
 *
 * Las letras son LOCALES a cada firmante (la «A» de Ana no es la «A» de Luis) y canonicas: se reparten por orden de
 * aparicion de arriba abajo, asi que la tabla de unos bloques es siempre la misma y no depende de sus ids.
 *
 *   bloques --groupsMatrix--> tabla --blocksFromMatrix--> bloques
 *
 * Ida y vuelta SIN perdida (con los bloques anteriores en `previous` los devuelve identicos: ids, trazos, sellos y
 * `auto`). Funciones puras, sin React, sin textos de interfaz: lo que sale son datos y CLAVES (ver
 * `assignmentValidation.ts`); las frases las pone la interfaz (U1.2/U1.3/U1.4).
 */

/** «A», «B»... Cualquier cadena no vacia vale como etiqueta de entrada; las que salen son letras canonicas. */
export type GroupId = string;

/** Un documento o solo su id (las pantallas tienen listas de los dos tipos). */
export type DocLike = DocId | { id: DocId };

const idOf = (doc: DocLike): DocId => (typeof doc === "string" ? doc : doc.id);

export type AssignmentMatrix = {
  /** Filas: documentos en el orden de la cola, sin repetir. */
  docIds: DocId[];
  /** Columnas: firmantes en el orden de la lista, sin repetir. */
  signerIds: string[];
  /** `cells[fila][columna]`: grupo del firmante en ese documento, o `null` = no firma. */
  cells: (GroupId | null)[][];
};

/* ------------------------------------------------------------------ *
 * Letras de grupo
 * ------------------------------------------------------------------ */

/** Letra del grupo `index` (0 = «A», 25 = «Z», 26 = «AA»...). */
export function groupIdAt(index: number): GroupId {
  let n = Math.max(0, Math.floor(index));
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Posicion de una letra de grupo (`groupIdAt` al reves); `-1` si no es una letra canonica. */
export function groupIndexOf(group: GroupId): number {
  if (!/^[A-Z]+$/.test(group)) return -1;
  let n = 0;
  for (const char of group) n = n * 26 + (char.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Nombre visible de un grupo: el que el usuario le puso (`groupNames[group]`, sin espacios de mas) o el de siempre,
 * «Firma A» / «Signature A». Los textos viven aqui solo como DATOS: la interfaz los pinta, no los define.
 */
const GROUP_PREFIX: Record<NameLang, string> = { es: "Firma", en: "Signature" };

export function groupDisplayName(
  group: GroupId,
  lang: NameLang,
  groupNames?: Readonly<Record<GroupId, string>>,
): string {
  const custom = groupNames?.[group]?.trim();
  return custom ? custom : `${GROUP_PREFIX[lang]} ${group}`;
}

/* ------------------------------------------------------------------ *
 * Bloques -> tabla
 * ------------------------------------------------------------------ */

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Para cada (firmante, documento): el primer bloque del firmante que lo cubre (como `resolveBlock`: gana el primero). */
function ownerBlock(
  blocks: readonly SignerBlock[],
  signerId: string,
  docId: DocId,
): SignerBlock | null {
  for (const block of blocks) {
    if (block.signerId === signerId && block.appliesTo.includes(docId)) return block;
  }
  return null;
}

/** La tabla de unos bloques y, de paso, la letra de cada bloque (por objeto, no por id). */
function buildMatrix(
  blocks: readonly SignerBlock[],
  docs: readonly DocLike[],
  signers?: readonly Pick<Signer, "id">[],
): { matrix: AssignmentMatrix; letters: Map<SignerBlock, GroupId> } {
  const docIds = unique(docs.map(idOf));
  const signerIds = signers
    ? unique(signers.map((signer) => signer.id))
    : unique(blocks.map((block) => block.signerId));
  const letters = new Map<SignerBlock, GroupId>();
  const cells: (GroupId | null)[][] = docIds.map(() => signerIds.map(() => null));

  signerIds.forEach((signerId, col) => {
    const own = new Map<SignerBlock, GroupId>();
    docIds.forEach((docId, row) => {
      const block = ownerBlock(blocks, signerId, docId);
      if (!block) return;
      let letter = own.get(block);
      if (letter === undefined) {
        letter = groupIdAt(own.size);
        own.set(block, letter);
        letters.set(block, letter);
      }
      cells[row][col] = letter;
    });
  });
  return { matrix: { docIds, signerIds, cells }, letters };
}

/**
 * La tabla de unos bloques. `docs` es la cola (los documentos que no estan en ella no cuentan) y `signers` las
 * columnas; sin `signers`, los de los bloques por orden de aparicion. Un documento reclamado por DOS bloques del mismo
 * firmante (dato corrupto) es del primero, igual que en `resolveBlock`.
 */
export function groupsMatrix(
  blocks: readonly SignerBlock[],
  docs: readonly DocLike[],
  signers?: readonly Pick<Signer, "id">[],
): AssignmentMatrix {
  return buildMatrix(blocks, docs, signers).matrix;
}

/** Letra de cada bloque que firma algun documento de la cola (`{ [blockId]: "A" }`). Para rotular turnos y avisos. */
export function blockGroups(
  blocks: readonly SignerBlock[],
  docs: readonly DocLike[],
  signers?: readonly Pick<Signer, "id">[],
): Record<string, GroupId> {
  const { letters } = buildMatrix(blocks, docs, signers);
  const out: Record<string, GroupId> = {};
  for (const [block, letter] of letters) if (!(block.id in out)) out[block.id] = letter;
  return out;
}

/**
 * La misma tabla con las letras en su forma canonica: por columna, por orden de aparicion de arriba abajo. Las celdas
 * que comparten etiqueta siguen compartiendola; `null` y la forma no cambian. Idempotente.
 */
export function canonicalMatrix(matrix: AssignmentMatrix): AssignmentMatrix {
  const cells = matrix.docIds.map((_, row) => matrix.signerIds.map((__, col) => cellOf(matrix, row, col)));
  matrix.signerIds.forEach((_, col) => {
    const letters = new Map<GroupId, GroupId>();
    matrix.docIds.forEach((__, row) => {
      const label = cells[row][col];
      if (label === null) return;
      let letter = letters.get(label);
      if (letter === undefined) {
        letter = groupIdAt(letters.size);
        letters.set(label, letter);
      }
      cells[row][col] = letter;
    });
  });
  return { docIds: [...matrix.docIds], signerIds: [...matrix.signerIds], cells };
}

/** Celda defensiva: lo que falte o venga vacio es «no firma». */
function cellOf(matrix: AssignmentMatrix, row: number, col: number): GroupId | null {
  const value = matrix.cells[row]?.[col];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Dos tablas son la misma: mismas filas, mismas columnas y mismas celdas. */
export function matrixEqual(a: AssignmentMatrix, b: AssignmentMatrix): boolean {
  if (a.docIds.length !== b.docIds.length || a.signerIds.length !== b.signerIds.length) return false;
  if (a.docIds.some((id, index) => id !== b.docIds[index])) return false;
  if (a.signerIds.some((id, index) => id !== b.signerIds[index])) return false;
  return a.docIds.every((_, row) =>
    a.signerIds.every((__, col) => cellOf(a, row, col) === cellOf(b, row, col)),
  );
}

/** Los grupos de un firmante y sus documentos, en el orden de la tabla. */
export function groupsOf(
  matrix: AssignmentMatrix,
  signerId: string,
): { group: GroupId; docIds: DocId[] }[] {
  const col = matrix.signerIds.indexOf(signerId);
  if (col === -1) return [];
  const groups = new Map<GroupId, DocId[]>();
  matrix.docIds.forEach((docId, row) => {
    const label = cellOf(matrix, row, col);
    if (label === null) return;
    const list = groups.get(label);
    if (list) list.push(docId);
    else groups.set(label, [docId]);
  });
  return [...groups].map(([group, docIds]) => ({ group, docIds }));
}

/** La letra que abriria un grupo NUEVO en la columna del firmante (la primera que ninguna celda usa). */
export function nextGroup(matrix: AssignmentMatrix, signerId: string): GroupId {
  const used = new Set(groupsOf(matrix, signerId).map((entry) => entry.group));
  for (let index = 0; ; index += 1) {
    const letter = groupIdAt(index);
    if (!used.has(letter)) return letter;
  }
}

/**
 * Cambia UNA celda y devuelve la tabla canonica (la misma si no hay nada que cambiar). `group` puede ser un grupo que
 * ya existe en la columna, `nextGroup(...)` para abrir uno, o `null` para «no firma». Un documento o firmante que no
 * estan en la tabla no cambian nada.
 */
export function setCell(
  matrix: AssignmentMatrix,
  docId: DocId,
  signerId: string,
  group: GroupId | null,
): AssignmentMatrix {
  const row = matrix.docIds.indexOf(docId);
  const col = matrix.signerIds.indexOf(signerId);
  if (row === -1 || col === -1) return matrix;
  const next = group === null || group === "" ? null : group;
  if (cellOf(matrix, row, col) === next) return matrix;
  const cells = matrix.docIds.map((_, r) => matrix.signerIds.map((__, c) => cellOf(matrix, r, c)));
  cells[row][col] = next;
  return canonicalMatrix({ ...matrix, cells });
}

/* ------------------------------------------------------------------ *
 * Atajos
 * ------------------------------------------------------------------ */

export type ShortcutOptions = {
  /** Las celdas «no firma» se quedan asi (por defecto se rellenan: «una firma para todos» es para todos). */
  keepEmpty?: boolean;
};

function rebuild(
  matrix: AssignmentMatrix,
  pick: (row: number, col: number, current: GroupId | null) => GroupId | null,
): AssignmentMatrix {
  return canonicalMatrix({
    ...matrix,
    cells: matrix.docIds.map((_, row) =>
      matrix.signerIds.map((__, col) => pick(row, col, cellOf(matrix, row, col))),
    ),
  });
}

/** «Una firma para todos»: cada firmante firma todos los documentos con UN solo trazo (todo «A»). */
export function allSameGroup(
  matrix: AssignmentMatrix,
  options: ShortcutOptions = {},
): AssignmentMatrix {
  return rebuild(matrix, (_row, _col, current) =>
    current === null && options.keepEmpty ? null : "A",
  );
}

/** «Una firma por documento»: cada documento lleva su propio trazo (A, B, C... de arriba abajo). */
export function oneGroupPerDocument(
  matrix: AssignmentMatrix,
  options: ShortcutOptions = {},
): AssignmentMatrix {
  return rebuild(matrix, (row, _col, current) =>
    current === null && options.keepEmpty ? null : `doc-${row}`,
  );
}

/**
 * «Por grupos»: cada lista de `groups` es un grupo de documentos que comparten trazo (`[[d1, d2], [d3, d4]]` = A para
 * d1 y d2, B para d3 y d4). Un documento en dos listas se queda con la primera. Los documentos que no estan en ninguna
 * lista NO cambian y no se mezclan con los grupos nuevos. `signerIds` limita a que firmantes se aplica (por defecto, a
 * todos); el resto de columnas no cambia.
 */
export function byGroups(
  matrix: AssignmentMatrix,
  groups: readonly (readonly DocId[])[],
  options: ShortcutOptions & { signerIds?: readonly string[] } = {},
): AssignmentMatrix {
  const groupOfDoc = new Map<DocId, number>();
  groups.forEach((list, index) => {
    for (const docId of list) if (!groupOfDoc.has(docId)) groupOfDoc.set(docId, index);
  });
  const only = options.signerIds ? new Set(options.signerIds) : null;
  return rebuild(matrix, (row, col, current) => {
    if (only && !only.has(matrix.signerIds[col])) return current;
    const index = groupOfDoc.get(matrix.docIds[row]);
    // Lo no listado no cambia. Las etiquetas de los grupos nuevos (`set-N`) nunca coinciden con las canonicas («A», «B»...),
    // asi que no se mezclan con lo que ya habia.
    if (index === undefined) return current;
    return current === null && options.keepEmpty ? null : `set-${index}`;
  });
}

/* ------------------------------------------------------------------ *
 * Tabla -> bloques
 * ------------------------------------------------------------------ */

/** Lo que le pasa a un trazo ya recogido cuando cambia el alcance de su bloque: la interfaz lo confirma con la persona. */
export type StrokeImpact = {
  signerId: string;
  /** El bloque ANTERIOR al que pertenecia el trazo. */
  blockId: string;
  /** Que trazos tenia: firma y/o iniciales (solo los que de verdad se ven afectados). */
  types: SignatureFieldType[];
  /**
   *  - `lost`: el trazo se descarta (su bloque desaparece o se queda sin documentos y nadie lo hereda). La interfaz
   *    puede ofrecer «Deshacer» volviendo a los bloques de antes.
   *  - `needsConfirm`: el trazo se conserva pero el grupo ahora cubre documentos que su dueno no vio con el: sin sello
   *    para ellos, `blockStampsValid` es falso y hay que confirmarlo (el trazo «caduca», como en `setBlockScope`).
   */
  outcome: "lost" | "needsConfirm";
  before: DocId[];
  /** Documentos del grupo que lo hereda (vacio si se pierde). */
  after: DocId[];
  /** `needsConfirm`: los documentos nuevos del grupo, sin sello. Vacio si `lost`. */
  docsToConfirm: DocId[];
};

export type MatrixApplication = {
  blocks: SignerBlock[];
  impacts: StrokeImpact[];
};

const STROKE_TYPES: readonly SignatureFieldType[] = ["signature", "initials"];

function strokesOf(block: SignerBlock): SignatureFieldType[] {
  return STROKE_TYPES.filter((type) => block[type] !== null);
}

function pickStamps(
  stamps: Readonly<Record<DocId, string>>,
  scope: readonly DocId[],
): Record<DocId, string> {
  const out: Record<DocId, string> = {};
  for (const id of scope) if (stamps[id]) out[id] = stamps[id];
  return out;
}

function sameSet(a: readonly DocId[], b: readonly DocId[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((id) => set.has(id));
}

/**
 * Aplica la tabla sobre los bloques de antes y dice que trazos se ven afectados. Reglas (las de `docSet.ts`):
 *  - Un grupo con EXACTAMENTE los documentos de un bloque anterior es ese bloque: id, trazos, sellos y `auto` intactos.
 *  - Si no, el grupo hereda el bloque anterior del mismo firmante con el que mas documentos comparte (empate: el que
 *    tenga trazos y, despues, el primero): conserva su id y sus trazos; los sellos solo se quedan para los documentos
 *    que sigue cubriendo y los nuevos no traen (hay que confirmarlos). Como `setBlockScope`.
 *  - Si un bloque heredero no tiene firma o iniciales, los toma del primer bloque descartado que los tenga
 *    (`switchMode` «Distintas -> Mismas»).
 *  - Un grupo sin ningun bloque con el que comparta documentos es NUEVO y sin trazos: nunca se «copia» un trazo ajeno a
 *    otro grupo (dos firmas distintas no pueden parecer la misma por un atajo).
 *  - Los bloques anteriores que nadie hereda se descartan, y sus trazos se devuelven en `impacts` (`lost`).
 * `auto` queda encendido solo cuando el firmante tiene UN grupo que cubre todos los documentos (los documentos nuevos
 * se suman solos, como en «Mismas»). Los bloques de un firmante que esta en `signers` pero no en la tabla se dejan como
 * estaban; los de quien no esta en `signers` se retiran, como hace `ensureBlocks`.
 */
export function applyMatrix(
  previous: readonly SignerBlock[],
  matrix: AssignmentMatrix,
  signers: readonly Pick<Signer, "id">[],
  mint: () => string = nextBlockId,
): MatrixApplication {
  const blocks: SignerBlock[] = [];
  const impacts: StrokeImpact[] = [];
  const docCount = unique(matrix.docIds).length;

  for (const signer of signers) {
    const own = previous.filter((block) => block.signerId === signer.id);
    const col = matrix.signerIds.indexOf(signer.id);
    if (col === -1) {
      blocks.push(...own);
      continue;
    }

    const groups = groupsOf(matrix, signer.id).map((entry) => entry.docIds);
    const single = groups.length === 1 && groups[0].length === docCount;

    // 1) Bloque anterior de cada grupo: primero los que coinciden exactamente, luego por documentos en comun.
    const owner: (number | null)[] = groups.map(() => null);
    const exact: boolean[] = groups.map(() => false);
    const taken = new Set<number>();
    groups.forEach((group, gi) => {
      const pi = own.findIndex((block, index) => !taken.has(index) && sameSet(block.appliesTo, group));
      if (pi !== -1) {
        owner[gi] = pi;
        exact[gi] = true;
        taken.add(pi);
      }
    });
    for (;;) {
      let best: { gi: number; pi: number; overlap: number; strokes: boolean } | null = null;
      for (let gi = 0; gi < groups.length; gi += 1) {
        if (owner[gi] !== null) continue;
        for (let pi = 0; pi < own.length; pi += 1) {
          if (taken.has(pi)) continue;
          const overlap = groups[gi].filter((id) => own[pi].appliesTo.includes(id)).length;
          if (overlap === 0) continue;
          const strokes = strokesOf(own[pi]).length > 0;
          if (
            best === null ||
            overlap > best.overlap ||
            (overlap === best.overlap && strokes && !best.strokes)
          ) {
            best = { gi, pi, overlap, strokes };
          }
        }
      }
      if (best === null) break;
      owner[best.gi] = best.pi;
      taken.add(best.pi);
    }

    // 2) Los bloques que nadie hereda: sus trazos se pueden ceder a un heredero que no los tenga.
    const orphans = own
      .map((block, index) => ({ block, index }))
      .filter(({ index }) => !taken.has(index));
    const donated = new Map<number, Set<SignatureFieldType>>();
    const donate = (type: SignatureFieldType): SignerBlock["signature"] => {
      for (const { block, index } of orphans) {
        const already = donated.get(index);
        if (block[type] && !already?.has(type)) {
          donated.set(index, new Set([...(already ?? []), type]));
          return block[type];
        }
      }
      return null;
    };

    // 3) Los bloques nuevos.
    groups.forEach((group, gi) => {
      const pi = owner[gi];
      if (pi === null) {
        blocks.push({
          id: mint(),
          signerId: signer.id,
          appliesTo: [...group],
          signature: null,
          initials: null,
          stamps: {},
          auto: single,
        });
        return;
      }
      const base = own[pi];
      if (exact[gi]) {
        blocks.push(base);
        return;
      }
      const inherited: SignerBlock = {
        ...base,
        appliesTo: [...group],
        stamps: pickStamps(base.stamps, group),
        auto: single,
      };
      for (const type of STROKE_TYPES) {
        if (!inherited[type]) inherited[type] = donate(type);
      }
      blocks.push(inherited);

      const added = group.filter((id) => !base.appliesTo.includes(id));
      const types = strokesOf(base);
      if (added.length > 0 && types.length > 0) {
        impacts.push({
          signerId: signer.id,
          blockId: base.id,
          types,
          outcome: "needsConfirm",
          before: [...base.appliesTo],
          after: [...group],
          docsToConfirm: added,
        });
      }
    });

    // 4) Lo que se descarta y no se cedio a nadie.
    for (const { block, index } of orphans) {
      const given = donated.get(index);
      const types = strokesOf(block).filter((type) => !given?.has(type));
      if (types.length > 0) {
        impacts.push({
          signerId: signer.id,
          blockId: block.id,
          types,
          outcome: "lost",
          before: [...block.appliesTo],
          after: [],
          docsToConfirm: [],
        });
      }
    }
  }
  return { blocks, impacts };
}

/**
 * Los bloques de una tabla. Con `previous` (los bloques de antes) conserva los trazos de cada grupo (ver
 * `applyMatrix`, que ademas devuelve los trazos afectados); sin ellos, bloques nuevos y sin trazos. Respeta el
 * invariante de `ensureBlocks`: un documento, como mucho un bloque por firmante, y ningun bloque vacio.
 */
export function blocksFromMatrix(
  matrix: AssignmentMatrix,
  signers: readonly Pick<Signer, "id">[],
  options: { previous?: readonly SignerBlock[]; mint?: () => string } = {},
): SignerBlock[] {
  return applyMatrix(options.previous ?? [], matrix, signers, options.mint).blocks;
}

/* ------------------------------------------------------------------ *
 * Resumen en lenguaje natural (solo DATOS)
 * ------------------------------------------------------------------ */

export type GroupSummary = {
  group: GroupId;
  /** «Firma A» / «Signature A» o el nombre propio del grupo. */
  label: string;
  docIds: DocId[];
  docNames: string[];
};

export type SignerSummary = {
  signerId: string;
  name: string;
  /** Documentos que firma (celdas no vacias). */
  documentCount: number;
  /** Trazos distintos que tiene que hacer. */
  groupCount: number;
  groups: GroupSummary[];
};

export type AssignmentSummary = {
  signers: SignerSummary[];
  documentCount: number;
  /** Archivos que se descargan: la suma de las copias de cada documento. */
  fileCount: number;
  /** Se entrega un ZIP (mas de un archivo) o un PDF suelto. */
  deliversZip: boolean;
  /** `fileCount` pasa de `MAX_OUTPUT_FILES`: no se puede descargar. */
  exceedsFileLimit: boolean;
  /** Documentos que ningun firmante firma. */
  unassignedDocIds: DocId[];
  /** Documentos con mas de una copia, con su numero. */
  copies: { docId: DocId; name: string; copies: number }[];
};

/**
 * Los datos para frases como «Ana firma 4 documentos con 2 firmas: A (Contrato, Anexo) y B (Carta, Autorizacion).
 * Luis firma 2 con 1 firma. Se descargaran 8 archivos.» Sin textos: la interfaz decide como decirlo. `copies` es la
 * tabla `{ [docId]: copias }` (ausente = 1); `groupNames` pone nombre propio a un grupo (por letra, para todos los
 * firmantes); `lang` elige «Firma» o «Signature» para los que no lo tienen.
 */
export function summarize(
  matrix: AssignmentMatrix,
  signers: readonly { id: string; name: string }[],
  docs: readonly { id: DocId; name: string }[],
  copies: Readonly<Record<DocId, number | undefined>> = {},
  options: { lang?: NameLang; groupNames?: Readonly<Record<GroupId, string>> } = {},
): AssignmentSummary {
  const lang = options.lang ?? "es";
  const nameOfDoc = (id: DocId) => docs.find((doc) => doc.id === id)?.name ?? id;
  const canonical = canonicalMatrix(matrix);

  const signerSummaries: SignerSummary[] = signers
    .filter((signer) => canonical.signerIds.includes(signer.id))
    .map((signer) => {
      const groups = groupsOf(canonical, signer.id).map(
        (entry): GroupSummary => ({
          group: entry.group,
          label: groupDisplayName(entry.group, lang, options.groupNames),
          docIds: entry.docIds,
          docNames: entry.docIds.map(nameOfDoc),
        }),
      );
      return {
        signerId: signer.id,
        name: signer.name.trim(),
        documentCount: groups.reduce((sum, group) => sum + group.docIds.length, 0),
        groupCount: groups.length,
        groups,
      };
    });

  const copiesFor = (id: DocId) => normalizeCopies(copies[id]);
  const fileCount = canonical.docIds.reduce((sum, id) => sum + copiesFor(id), 0);
  const unassignedDocIds = canonical.docIds.filter((_, row) =>
    canonical.signerIds.every((__, col) => cellOf(canonical, row, col) === null),
  );

  return {
    signers: signerSummaries,
    documentCount: canonical.docIds.length,
    fileCount,
    deliversZip: fileCount > 1,
    exceedsFileLimit: fileCount > MAX_OUTPUT_FILES,
    unassignedDocIds,
    copies: canonical.docIds
      .filter((id) => copiesFor(id) > 1)
      .map((id) => ({ docId: id, name: nameOfDoc(id), copies: copiesFor(id) })),
  };
}
