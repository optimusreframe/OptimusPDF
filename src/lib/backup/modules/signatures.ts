import {
  BIDI_CONTROLS,
  MAX_VAULT_ENTRIES,
  MAX_VAULT_IMAGE_BYTES,
  MAX_VAULT_TEXT_LENGTH,
  MAX_VAULT_TOTAL_BYTES,
  VAULT_ORIGINS,
  commitVaultImport,
  isStoredEntry,
  isValidVaultImage,
  listVault,
  normalizeSignerKey,
  pngIhdrCrcValid,
  readPngSize,
  type VaultEntry,
  type VaultImage,
  type VaultOrigin,
} from "@/app/sign-pdf/signVault";
import { hasPngEnd } from "@/app/sign-pdf/signVaultFile";
import { sha256Hex } from "@/lib/crypto/sha256";
import {
  CURRENT_SIGNATURES_SCHEMA,
  migrateSignaturesIndex,
} from "@/lib/backup/migrations/signatures";
import { parseStrictJson } from "@/lib/backup/strictJson";
import {
  NEWER_VERSION_MESSAGE,
  PackageError,
  type PackageFileInput,
  type PackageFileRead,
  type PackageModuleInput,
  type PackageModuleSpec,
  type PackageReadResult,
} from "@/lib/backup/types";

/**
 * Modulo «Firmas» del respaldo (`docs/PLAN-FIRMA-AGIL.md` §9.3): exporta el
 * baul de firmas (`signVault.ts`) a un modulo del paquete y planifica/aplica
 * su importacion fusionando, sin pisar nada que el usuario no apruebe.
 *
 * ```
 * signatures/index.json                  [{ id, signerName, role?, origin?, createdAt,
 *                                          lastUsedAt, signature?, initials? }]
 * signatures/<id>-signature.png          bytes PNG de la firma
 * signatures/<id>-initials.png           bytes PNG de las iniciales
 * ```
 * Lo que NO viaja: `signerKey` (se recalcula al importar), `sourceDocument`
 * (nombre de un documento del cliente: privacidad) ni `schema`. `origin`
 * (`drawn|typed|uploaded|extracted`, opcional) viaja en el paquete si la entrada
 * lo trae y la importacion lo ESCRIBE en el baul solo si es de la lista (un
 * valor ajeno se ignora: la firma se importa sin origen).
 *
 * Seguridad de la importacion: nada se ejecuta; ni nombres ni tipos MIME del
 * zip se creen (la ruta de cada PNG se DERIVA del id y el contenido se valida
 * con los validadores del baul); los campos desconocidos se ignoran; un
 * elemento corrupto se aisla (`invalid`) sin tumbar el resto.
 */

export const SIGNATURES_MODULE = "signatures";
const INDEX_PATH = "signatures/index.json";
/** Elementos maximos que se aceptan leer de un `index.json` (el baul admite 30). */
const MAX_INDEX_ITEMS = 200;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** La lista es la del baul (`VAULT_ORIGINS`): una sola fuente de verdad para el validador de ambos lados. */
const ORIGINS = VAULT_ORIGINS;
export type SignatureOrigin = VaultOrigin;

export const SIGNATURES_MODULE_SPEC: PackageModuleSpec = {
  name: SIGNATURES_MODULE,
  schemaVersion: CURRENT_SIGNATURES_SCHEMA,
  folders: ["signatures"],
  maxFileBytes: MAX_VAULT_IMAGE_BYTES,
  maxJsonBytes: 1024 * 1024,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const encoder = new TextEncoder();

function signaturePath(id: string): string {
  return `signatures/${id}-signature.png`;
}

function initialsPath(id: string): string {
  return `signatures/${id}-initials.png`;
}

// ---------------------------------------------------------------------------
// Exportar
// ---------------------------------------------------------------------------

/** Modulo del paquete a partir de unas entradas del baul (puro, sin IndexedDB). */
export function signaturesModuleFromEntries(
  entries: readonly VaultEntry[],
): PackageModuleInput {
  const sorted = entries
    .filter((entry) => isStoredEntry(entry) && ID_PATTERN.test(entry.id))
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  const files: PackageFileInput[] = [];
  const index: Record<string, unknown>[] = [];
  for (const entry of sorted) {
    const origin = (entry as { origin?: unknown }).origin;
    const item: Record<string, unknown> = {
      id: entry.id,
      signerName: entry.signerName,
      ...(entry.role ? { role: entry.role } : {}),
      ...(typeof origin === "string" && (ORIGINS as readonly string[]).includes(origin)
        ? { origin }
        : {}),
      createdAt: entry.createdAt,
      lastUsedAt: entry.lastUsedAt,
    };
    if (entry.signature) {
      item.signature = signaturePath(entry.id);
      files.push({ path: signaturePath(entry.id), data: entry.signature.png, type: "image/png" });
    }
    if (entry.initials) {
      item.initials = initialsPath(entry.id);
      files.push({ path: initialsPath(entry.id), data: entry.initials.png, type: "image/png" });
    }
    index.push(item);
  }
  files.unshift({
    path: INDEX_PATH,
    // copia al Uint8Array del dominio actual (en jsdom el de TextEncoder es ajeno)
    data: new Uint8Array(encoder.encode(JSON.stringify(index))),
    type: "application/json",
  });
  return {
    name: SIGNATURES_MODULE,
    schemaVersion: CURRENT_SIGNATURES_SCHEMA,
    meta: { count: index.length },
    files,
  };
}

/** Modulo «Firmas» con TODO lo que hay ahora en el baul. */
export async function exportSignatures(): Promise<PackageModuleInput> {
  const list = await listVault();
  if (!list.ok) throw new PackageError("unavailable");
  return signaturesModuleFromEntries(list.entries);
}

// ---------------------------------------------------------------------------
// Planificar la importacion
// ---------------------------------------------------------------------------

export type SignatureItemStatus = "new" | "identical" | "different" | "invalid";
export type SignatureInvalidReason =
  | "integrity"
  | "tooLarge"
  | "invalidImage"
  | "invalidEntry"
  | "duplicateId";
export type SignatureDecision = "import" | "replace" | "keepBoth" | "omit";

export type SignatureImportItem = {
  /**
   * Id dentro del paquete. Un elemento sin id valido recibe `#invalid-N` y un id repetido `<id>#N`: el `#` no puede
   * aparecer en un id real (`ID_PATTERN`), asi que ningun id sintetico choca con otro (ni con uno de verdad) y la
   * interfaz puede usarlo como clave.
   */
  id: string;
  status: SignatureItemStatus;
  reason?: SignatureInvalidReason;
  signerName: string;
  role?: string;
  /** Informativo; si es valido tambien se escribe en la entrada del baul. */
  origin?: SignatureOrigin;
  createdAt: string;
  lastUsedAt: string;
  hasSignature: boolean;
  hasInitials: boolean;
  /** Suma de bytes de sus PNG. */
  bytes: number;
  /**
   * `different`: la entrada del baul con la que choca (a la que «Reemplazar» sustituiria). `snapshot` es la entrada TAL
   * COMO ESTABA en la vista previa: al reemplazar se comprueba, dentro de la transaccion, que sigue igual.
   */
  conflictWith?: { id: string; signerName: string; role?: string; bytes: number; snapshot: VaultEntry };
  /**
   * `different`: en que se distingue. `images` = otras imagenes; `data` = LOS MISMOS dibujos y solo cambian datos del
   * firmante (nombre/cargo), p. ej. un firmante renombrado en este baul despues de exportar.
   */
  difference?: "images" | "data";
  /** `difference === "data"`: que datos cambiarian. */
  differs?: ("name" | "role")[];
  /**
   * `different`: `false` si la entrada del baul es de OTRA persona (mismo id interno, otro firmante, otras imagenes):
   * «Reemplazar» no se ofrece (borraria la firma de alguien distinto); solo conservar ambos u omitir.
   */
  canReplace?: boolean;
  /** `different`: el elemento trae todo lo que tiene la entrada del baul (reemplazar no pierde imagenes). */
  supersedes?: boolean;
  /** Lo que se escribiria (solo si `status !== "invalid"`). */
  entry?: VaultEntry;
};

export type SignaturesPlanState = "ok" | "absent" | "newerVersion" | "damaged";

export type ImportPlan = {
  module: typeof SIGNATURES_MODULE;
  state: SignaturesPlanState;
  message?: string;
  items: SignatureImportItem[];
  counts: { new: number; identical: number; different: number; invalid: number };
  limits: {
    maxEntries: number;
    maxTotalBytes: number;
    currentEntries: number;
    currentBytes: number;
  };
};

function entryBytes(entry: Pick<VaultEntry, "signature" | "initials">): number {
  return (entry.signature?.png.byteLength ?? 0) + (entry.initials?.png.byteLength ?? 0);
}

/** Texto de nombre/cargo: sin marcas bidi, controles a espacio, tope de largo. */
function cleanField(value: unknown, required: boolean): string | null | undefined {
  if (value === undefined) return required ? null : undefined;
  if (typeof value !== "string" || value.length > MAX_VAULT_TEXT_LENGTH) return null;
  const clean = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(BIDI_CONTROLS, "")
    .trim();
  if (required && !clean) return null;
  return clean || undefined;
}

function cleanDate(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** PNG ajeno -> imagen del baul, o `null` (con el motivo) si no pasa los validadores. */
function parsePng(
  png: Uint8Array,
): { ok: true; image: VaultImage } | { ok: false; reason: SignatureInvalidReason } {
  if (png.byteLength > MAX_VAULT_IMAGE_BYTES) return { ok: false, reason: "tooLarge" };
  const size = readPngSize(png);
  if (!size || !hasPngEnd(png) || !pngIhdrCrcValid(png)) {
    return { ok: false, reason: "invalidImage" };
  }
  // Dimensiones (1..4096 px) y forma: las valida `isValidVaultImage`, el
  // validador del propio baul. El ratio se deriva de las dimensiones reales:
  // nunca puede contradecirlas.
  const image: VaultImage = {
    png,
    ratio: size.height / size.width,
    width: size.width,
    height: size.height,
  };
  return isValidVaultImage(image) ? { ok: true, image } : { ok: false, reason: "invalidImage" };
}

type ImageHashes = { signature: string | null; initials: string | null };

async function hashesOf(entry: Pick<VaultEntry, "signature" | "initials">): Promise<ImageHashes> {
  return {
    signature: entry.signature ? await sha256Hex(entry.signature.png) : null,
    initials: entry.initials ? await sha256Hex(entry.initials.png) : null,
  };
}

/** `a` trae todas las imagenes de `b` con el mismo hash (lo que `b` no trae no cuenta). */
function hashCovers(a: ImageHashes, b: ImageHashes): boolean {
  return (
    (b.signature === null || a.signature === b.signature) &&
    (b.initials === null || a.initials === b.initials)
  );
}

function sharesHash(a: ImageHashes, b: ImageHashes): boolean {
  return (
    (b.signature !== null && a.signature === b.signature) ||
    (b.initials !== null && a.initials === b.initials)
  );
}

function fileOk(read: PackageReadResult["modules"][number], path: string): PackageFileRead | null {
  const file = read.files.get(path);
  return file && file.status === "ok" && file.bytes ? file : null;
}

function blankItem(id: string, name: string): SignatureImportItem {
  return {
    id,
    status: "invalid",
    signerName: name,
    createdAt: "",
    lastUsedAt: "",
    hasSignature: false,
    hasInitials: false,
    bytes: 0,
  };
}

function emptyPlan(
  state: SignaturesPlanState,
  vault: readonly VaultEntry[],
  message?: string,
): ImportPlan {
  return {
    module: SIGNATURES_MODULE,
    state,
    ...(message ? { message } : {}),
    items: [],
    counts: { new: 0, identical: 0, different: 0, invalid: 0 },
    limits: {
      maxEntries: MAX_VAULT_ENTRIES,
      maxTotalBytes: MAX_VAULT_TOTAL_BYTES,
      currentEntries: vault.length,
      currentBytes: vault.reduce((sum, entry) => sum + entryBytes(entry), 0),
    },
  };
}

/**
 * Vista previa de importar el modulo «Firmas» de un paquete ya leido
 * (`readPackage`) sobre el baul actual. No escribe nada. Cada elemento queda
 * «Nuevo», «Ya lo tienes (idéntico)» (mismo firmante y mismas imagenes por
 * hash), «Distinto» (hay algo del mismo firmante / id con otras imagenes) o
 * `invalid` (aislado, con su motivo).
 */
export type PlanOptions = {
  /**
   * Comprobacion EXTRA de cada PNG (tras los validadores del baul): `false` = imagen no valida. Es la puerta del
   * endurecimiento de la importacion (`validatePngForImport`: decodifica de verdad, rechaza APNG, texto enorme y bombas
   * de pixeles). La interfaz (`backupFlow.readSignaturesBackup`) siempre la pasa; sin ella solo valen los validadores
   * del baul (los paquetes «dorados» y las pruebas con PNG sinteticos).
   */
  validateImage?: (png: Uint8Array) => Promise<boolean>;
};

export async function planSignaturesImport(
  read: PackageReadResult,
  currentVault: readonly VaultEntry[],
  options: PlanOptions = {},
): Promise<ImportPlan> {
  const vault = currentVault.filter((entry) => isStoredEntry(entry));
  const data = read.modules.find((m) => m.name === SIGNATURES_MODULE);
  if (!data) return emptyPlan("absent", vault);
  if (data.status === "newerVersion") {
    return emptyPlan("newerVersion", vault, data.message ?? NEWER_VERSION_MESSAGE);
  }

  // Sin un indice integro el modulo no se puede interpretar.
  const indexFile = fileOk(data, INDEX_PATH);
  let rawIndex: unknown;
  try {
    if (!indexFile?.bytes) throw new PackageError("invalidJson");
    rawIndex = migrateSignaturesIndex(
      parseStrictJson(indexFile.bytes, SIGNATURES_MODULE_SPEC.maxJsonBytes),
      data.declaredSchemaVersion,
    );
    if (!Array.isArray(rawIndex) || rawIndex.length > MAX_INDEX_ITEMS) {
      throw new PackageError("invalidJson");
    }
  } catch {
    return emptyPlan("damaged", vault);
  }

  const plan = emptyPlan("ok", vault);
  const vaultHashes = new Map<string, ImageHashes>();
  for (const entry of vault) vaultHashes.set(entry.id, await hashesOf(entry));
  const seenIds = new Set<string>();

  for (const [position, raw] of (rawIndex as unknown[]).entries()) {
    const placeholderId = `#invalid-${position + 1}`;
    if (!isRecord(raw)) {
      plan.items.push({ ...blankItem(placeholderId, ""), reason: "invalidEntry" });
      continue;
    }
    const name = cleanField(raw.signerName, true);
    const rawId = raw.id;
    const labelName = typeof name === "string" ? name : "";
    if (typeof rawId !== "string" || !ID_PATTERN.test(rawId)) {
      plan.items.push({ ...blankItem(placeholderId, labelName), reason: "invalidEntry" });
      continue;
    }
    const id = rawId;
    if (seenIds.has(id)) {
      plan.items.push({ ...blankItem(`${id}#${position + 1}`, labelName), reason: "duplicateId" });
      continue;
    }
    seenIds.add(id);

    const role = cleanField(raw.role, false);
    const createdAt = cleanDate(raw.createdAt);
    const lastUsedAt = cleanDate(raw.lastUsedAt);
    const origin = (ORIGINS as readonly string[]).includes(raw.origin as string)
      ? (raw.origin as SignatureOrigin)
      : undefined;
    const invalid = (reason: SignatureInvalidReason): SignatureImportItem => ({
      ...blankItem(id, labelName),
      reason,
    });
    if (
      typeof name !== "string" ||
      role === null ||
      createdAt === null ||
      lastUsedAt === null ||
      (raw.signature !== undefined && raw.signature !== signaturePath(id)) ||
      (raw.initials !== undefined && raw.initials !== initialsPath(id)) ||
      (raw.signature === undefined && raw.initials === undefined)
    ) {
      plan.items.push(invalid("invalidEntry"));
      continue;
    }

    // Imagenes: el archivo tiene que haber superado la integridad del contenedor
    // (SHA-256, tamaño) y luego los validadores PNG del baul.
    const images: { signature: VaultImage | null; initials: VaultImage | null } = {
      signature: null,
      initials: null,
    };
    const hashes: ImageHashes = { signature: null, initials: null };
    let failure: SignatureInvalidReason | null = null;
    for (const kind of ["signature", "initials"] as const) {
      if (raw[kind] === undefined) continue;
      const path = kind === "signature" ? signaturePath(id) : initialsPath(id);
      const file = data.files.get(path);
      if (!file) {
        failure = "integrity";
        break;
      }
      if (file.status === "tooLarge") {
        failure = "tooLarge";
        break;
      }
      if (file.status !== "ok" || !file.bytes) {
        failure = "integrity";
        break;
      }
      const parsed = parsePng(file.bytes);
      if (!parsed.ok) {
        failure = parsed.reason;
        break;
      }
      if (options.validateImage && !(await options.validateImage(file.bytes))) {
        failure = "invalidImage";
        break;
      }
      images[kind] = parsed.image;
      hashes[kind] = file.sha256;
    }
    if (failure) {
      plan.items.push(invalid(failure));
      continue;
    }

    const entry: VaultEntry = {
      id,
      schema: 1,
      signerName: name,
      signerKey: normalizeSignerKey(name),
      ...(role ? { role } : {}),
      ...(origin ? { origin } : {}),
      sourceDocument: "",
      createdAt,
      lastUsedAt,
      signature: images.signature,
      initials: images.initials,
    };
    const item: SignatureImportItem = {
      id,
      status: "new",
      signerName: name,
      ...(role ? { role } : {}),
      ...(origin ? { origin } : {}),
      createdAt,
      lastUsedAt,
      hasSignature: images.signature !== null,
      hasInitials: images.initials !== null,
      bytes: entryBytes(entry),
      entry,
    };

    const sameSigner = vault.filter((existing) => existing.signerKey === entry.signerKey);
    const identical = sameSigner.some((existing) =>
      hashCovers(vaultHashes.get(existing.id) as ImageHashes, hashes),
    );
    if (identical) {
      item.status = "identical";
    } else {
      // El destino de «Reemplazar»: la entrada con el MISMO id solo si es la misma persona o el mismo dibujo con otro
      // nombre (firmante renombrado). Un id que coincide con el de OTRA persona y otras imagenes es solo una
      // coincidencia del identificador interno: esa entrada no se ofrece para sustituir.
      const sameId = vault.find((existing) => existing.id === id);
      const sameIdHashes = sameId ? (vaultHashes.get(sameId.id) as ImageHashes) : null;
      const renamed =
        sameId !== undefined &&
        sameId.signerKey !== entry.signerKey &&
        sameIdHashes !== null &&
        hashCovers(sameIdHashes, hashes);
      const sameIdIsTarget = sameId !== undefined && (sameId.signerKey === entry.signerKey || renamed);
      const target =
        (sameIdIsTarget ? sameId : undefined) ??
        sameSigner.find((existing) =>
          sharesHash(vaultHashes.get(existing.id) as ImageHashes, hashes),
        ) ??
        sameSigner
          .slice()
          .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))[0] ??
        sameId;
      if (target) {
        const sameDrawings = renamed && target === sameId;
        item.status = "different";
        item.conflictWith = {
          id: target.id,
          signerName: target.signerName,
          ...(target.role ? { role: target.role } : {}),
          bytes: entryBytes(target),
          snapshot: target,
        };
        item.canReplace = target.signerKey === entry.signerKey || sameDrawings;
        item.difference = sameDrawings ? "data" : "images";
        if (sameDrawings) {
          item.differs = ["name", ...(role && role !== target.role ? (["role"] as const) : [])];
          item.supersedes = true;
        } else {
          item.supersedes = hashCovers(hashes, vaultHashes.get(target.id) as ImageHashes);
        }
      }
    }
    plan.items.push(item);
  }

  for (const item of plan.items) plan.counts[item.status] += 1;
  return plan;
}

/**
 * Decision sugerida (la UI puede mostrarla preseleccionada): lo nuevo se
 * importa; lo distinto se REEMPLAZA solo si el elemento trae todo lo que ya
 * hay (no se pierde ninguna imagen) y si no se CONSERVAN AMBOS; lo idéntico
 * y lo invalido se omiten. NUNCA se pierde un dato por defecto: si solo
 * cambian datos del firmante con los mismos dibujos («Mismos dibujos, datos
 * distintos») se conserva la que ya hay, y una entrada de OTRA persona jamas
 * se sustituye.
 */
export function defaultSignatureDecisions(plan: ImportPlan): Record<string, SignatureDecision> {
  const out: Record<string, SignatureDecision> = {};
  for (const item of plan.items) {
    if (item.status === "new") out[item.id] = "import";
    else if (item.status === "different") {
      out[item.id] =
        item.difference === "data"
          ? "omit"
          : item.canReplace !== false && item.supersedes
            ? "replace"
            : "keepBoth";
    }
    else out[item.id] = "omit";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Limites y aplicar
// ---------------------------------------------------------------------------

type Approved = { item: SignatureImportItem; decision: "import" | "replace" | "keepBoth" };

/** Solo cuenta lo APROBADO explicitamente y coherente con el estado del elemento. */
function approvedItems(
  plan: ImportPlan,
  decisions: Record<string, SignatureDecision | undefined>,
): Approved[] {
  const out: Approved[] = [];
  const claimedTargets = new Set<string>();
  for (const item of plan.items) {
    const decision = Object.prototype.hasOwnProperty.call(decisions, item.id)
      ? decisions[item.id]
      : undefined;
    if (!item.entry) continue;
    if (item.status === "new" && decision === "import") {
      out.push({ item, decision });
    } else if (item.status === "different" && decision === "keepBoth") {
      out.push({ item, decision });
    } else if (
      item.status === "different" &&
      decision === "replace" &&
      item.conflictWith &&
      item.canReplace !== false
    ) {
      // Un destino solo se sustituye una vez (el segundo se queda sin aprobar).
      if (claimedTargets.has(item.conflictWith.id)) continue;
      claimedTargets.add(item.conflictWith.id);
      out.push({ item, decision });
    }
  }
  return out;
}

export type SignaturesLimitCheck = {
  /** Elementos aprobados que anaden o reemplazan. */
  wanted: number;
  /** Cuantos de ellos caben (en orden) en los limites del baul. */
  fits: number;
  ok: boolean;
  entriesAfter: number;
  bytesAfter: number;
};

/**
 * Cuantos de los elementos aprobados caben en el baul (30 firmas, 20 MB)
 * ANTES de escribir nada. `ok` solo si caben todos.
 */
export function checkSignaturesLimits(
  plan: ImportPlan,
  decisions: Record<string, SignatureDecision | undefined>,
): SignaturesLimitCheck {
  let entries = plan.limits.currentEntries;
  let bytes = plan.limits.currentBytes;
  let fits = 0;
  const approved = approvedItems(plan, decisions);
  for (const { item, decision } of approved) {
    const addEntries = decision === "replace" ? 0 : 1;
    const addBytes = item.bytes - (decision === "replace" ? (item.conflictWith?.bytes ?? 0) : 0);
    if (
      entries + addEntries <= plan.limits.maxEntries &&
      bytes + addBytes <= plan.limits.maxTotalBytes
    ) {
      entries += addEntries;
      bytes += addBytes;
      fits += 1;
    }
  }
  return {
    wanted: approved.length,
    fits,
    ok: fits === approved.length,
    entriesAfter: entries,
    bytesAfter: bytes,
  };
}

export type ApplySignaturesResult =
  | { ok: true; written: number; replaced: number; skipped: number }
  | {
      ok: false;
      reason: "limit" | "unavailable" | "invalid" | "blocked" | "changed";
      /** `limit`: cuantos de los aprobados caben. */
      fits?: number;
      wanted?: number;
    };

/** Revalida una entrada del plan con los mismos validadores (el plan puede venir de la UI). */
function revalidate(entry: VaultEntry): boolean {
  if (!isStoredEntry(entry)) return false;
  if (entry.signerKey !== normalizeSignerKey(entry.signerName)) return false;
  if (entry.signature === null && entry.initials === null) return false;
  for (const image of [entry.signature, entry.initials]) {
    if (image === null) continue;
    const parsed = parsePng(image.png);
    if (!parsed.ok || parsed.image.width !== image.width || parsed.image.height !== image.height) {
      return false;
    }
  }
  return true;
}

function withRole(entry: VaultEntry, role: string | undefined): VaultEntry {
  const { role: _previous, ...rest } = entry;
  void _previous;
  return role ? { ...rest, role } : rest;
}

/**
 * Lo que se escribe al REEMPLAZAR. Nunca se pierde un dato que el paquete no trae: sin cargo en el paquete se conserva
 * el de la entrada que se sustituye. Con «mismos dibujos, datos distintos» se actualizan solo nombre (y cargo si el
 * paquete lo trae) y la entrada conserva sus imagenes, sus fechas y su origen.
 */
function replacementFor(item: SignatureImportItem): VaultEntry {
  const entry = item.entry as VaultEntry;
  const target = (item.conflictWith as NonNullable<SignatureImportItem["conflictWith"]>).snapshot;
  const role = entry.role ?? target.role;
  if (item.difference === "data") {
    return withRole(
      { ...target, signerName: entry.signerName, signerKey: entry.signerKey },
      role,
    );
  }
  return withRole(entry, role);
}

/**
 * Escribe en el baul SOLO lo que `decisions` aprueba (`import` para lo
 * nuevo; `replace` / `keepBoth` para lo distinto; cualquier otra cosa u
 * omision = no se toca) y de forma atomica: todo o nada. Si no caben todos los
 * aprobados no se escribe NINGUNO y se informa de cuantos caben (`fits`); un
 * fallo de cuota o de IndexedDB deja el baul como estaba.
 */
export async function applySignaturesImport(
  plan: ImportPlan,
  decisions: Record<string, SignatureDecision | undefined>,
): Promise<ApplySignaturesResult> {
  if (plan.state !== "ok") return { ok: false, reason: "blocked" };
  const approved = approvedItems(plan, decisions);
  if (approved.length === 0) {
    return { ok: true, written: 0, replaced: 0, skipped: plan.items.length };
  }
  for (const { item } of approved) {
    if (!item.entry || !revalidate(item.entry)) return { ok: false, reason: "invalid" };
  }
  const check = checkSignaturesLimits(plan, decisions);
  if (!check.ok) {
    return { ok: false, reason: "limit", fits: check.fits, wanted: check.wanted };
  }
  const replacing = approved.filter(
    (a): a is Approved & { item: SignatureImportItem & { conflictWith: NonNullable<SignatureImportItem["conflictWith"]> } } =>
      a.decision === "replace" && a.item.conflictWith !== undefined,
  );
  const result = await commitVaultImport({
    puts: approved.map(({ item, decision }) =>
      decision === "replace" ? replacementFor(item) : (item.entry as VaultEntry),
    ),
    deleteIds: replacing.map(({ item }) => item.conflictWith.id),
    expectUnchanged: replacing.map(({ item }) => item.conflictWith.snapshot),
  });
  if (!result.ok) {
    if (result.reason === "limit") {
      return { ok: false, reason: "limit", fits: 0, wanted: check.wanted };
    }
    if (result.reason === "changed") return { ok: false, reason: "changed" };
    return {
      ok: false,
      reason: result.reason === "unavailable" ? "unavailable" : "invalid",
    };
  }
  return {
    ok: true,
    written: result.written,
    replaced: result.deleted,
    skipped: plan.items.length - result.written,
  };
}
