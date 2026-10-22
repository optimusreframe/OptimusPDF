import { buildUploadEntry, type PreparedInk } from "@/app/sign-pdf/inkImportModel";
import {
  commitVaultImport,
  normalizeSignerKey,
  saveVaultEntry,
  vaultImageToDataUrl,
  type VaultEntry,
  type VaultEntryInput,
  type VaultImage,
} from "@/app/sign-pdf/signVault";

/**
 * Logica de «Guardar en Firmas guardadas» desde el Extractor (F7 · U7.4), SIN React: decide QUE se escribe en el baul
 * segun el tipo (firma / iniciales), el firmante elegido (uno que ya esta en el baul o uno nuevo) y, si ese firmante ya
 * tiene ese tipo, que se hace con lo que habia (reemplazar o guardar como otro firmante). Una entrada = un firmante con su
 * firma y sus iniciales (igual que `SignatureImportSheet`).
 *
 * Reutiliza `buildUploadEntry` + `saveVaultEntry` (altas y «completar» una entrada, donde el baul ya amplia la existente
 * en vez de duplicarla) y `commitVaultImport` SOLO para reemplazar: borra la vieja y escribe la nueva en UNA transaccion
 * (todo o nada, y no escribe si otra pestana cambio la entrada mientras se decidia).
 */

export type VaultKind = "signature" | "initials";

export type SignerChoice = { kind: "new" } | { kind: "existing"; id: string };

/** Que hacer cuando el firmante elegido ya tiene ese tipo. `null` = aun sin elegir. */
export type ConflictChoice = "replace" | "other" | null;

export function entryHas(entry: Pick<VaultEntry, "signature" | "initials">, kind: VaultKind): boolean {
  return (kind === "signature" ? entry.signature : entry.initials) !== null;
}

/** `true` si guardar este tipo en esta entrada chocaria con una imagen que ya tiene. */
export function hasConflict(entry: VaultEntry | undefined, kind: VaultKind): boolean {
  return entry !== undefined && entryHas(entry, kind);
}

export type SavePlanInput = {
  entries: readonly VaultEntry[];
  choice: SignerChoice;
  kind: VaultKind;
  conflict: ConflictChoice;
  /** Nombre escrito (firmante nuevo, u «otro firmante»). */
  name: string;
  role: string;
  ink: PreparedInk;
  sourceDocument: string;
};

export type SaveErrorReason = "nameNeeded" | "nameTaken" | "conflictNeeded" | "notFound" | "invalid";

export type SavePlan =
  | { action: "error"; reason: SaveErrorReason }
  /** Alta o «completar»: `saveVaultEntry`. `completes` = entrada que se amplia (si la hay). */
  | { action: "save"; input: VaultEntryInput; completes: VaultEntry | null }
  /** Reemplazo: `commitVaultImport` (borrar + escribir, atomico). */
  | { action: "replace"; existing: VaultEntry; merged: VaultEntry };

const toPrepared = (image: VaultImage | null): PreparedInk | null =>
  image ? { png: image.png, width: image.width, height: image.height } : null;

function withOrigin(input: VaultEntryInput, sourceDocument: string): VaultEntryInput {
  // Lo extraido de un PDF: `origin: "extracted"` y el nombre del documento SOLO en su campo previsto.
  return { ...input, origin: "extracted", sourceDocument };
}

/** Decide la escritura. Pura: no toca el baul. */
export function planSave(input: SavePlanInput, now: () => string = () => new Date().toISOString()): SavePlan {
  const { entries, choice, kind, conflict, ink, sourceDocument } = input;
  const name = input.name.trim();
  const keys = new Set(entries.map((entry) => entry.signerKey));

  if (choice.kind === "existing") {
    const existing = entries.find((entry) => entry.id === choice.id);
    if (!existing) return { action: "error", reason: "notFound" };
    if (!hasConflict(existing, kind)) {
      // Completar: la misma entrada con la imagen nueva al lado de la que ya tenia.
      const built = buildUploadEntry({
        signerName: existing.signerName,
        role: existing.role,
        signature: kind === "signature" ? ink : toPrepared(existing.signature),
        initials: kind === "initials" ? ink : toPrepared(existing.initials),
      });
      if (!built) return { action: "error", reason: "invalid" };
      return { action: "save", input: withOrigin(built, sourceDocument), completes: existing };
    }
    if (conflict === null) return { action: "error", reason: "conflictNeeded" };
    if (conflict === "replace") {
      const built = buildUploadEntry({ signerName: existing.signerName, role: existing.role, signature: kind === "signature" ? ink : toPrepared(existing.signature), initials: kind === "initials" ? ink : toPrepared(existing.initials) });
      if (!built) return { action: "error", reason: "invalid" };
      const merged: VaultEntry = {
        ...existing,
        signature: built.signature,
        initials: built.initials,
        origin: "extracted",
        sourceDocument: sourceDocument.trim() ? sourceDocument.trim().slice(0, 200) : existing.sourceDocument,
        lastUsedAt: now(),
      };
      return { action: "replace", existing, merged };
    }
    // «Guardar como otro firmante»: hace falta un nombre DISTINTO (el mismo se fundiria con el existente).
    if (name === "") return { action: "error", reason: "nameNeeded" };
    if (keys.has(normalizeSignerKey(name))) return { action: "error", reason: "nameTaken" };
  } else {
    if (name === "") return { action: "error", reason: "nameNeeded" };
    // Un nombre que ya esta en el baul se elige en la lista: no se crea un segundo firmante con el mismo nombre.
    if (keys.has(normalizeSignerKey(name))) return { action: "error", reason: "nameTaken" };
  }

  const built = buildUploadEntry({
    signerName: name,
    role: input.role,
    signature: kind === "signature" ? ink : null,
    initials: kind === "initials" ? ink : null,
  });
  if (!built) return { action: "error", reason: "invalid" };
  return { action: "save", input: withOrigin(built, sourceDocument), completes: null };
}

export type ExecuteResult =
  | { ok: true; entryName: string; kind: "new" | "completed" | "replaced" | "duplicate" }
  | { ok: false; reason: "limit" | "tooLarge" | "invalid" | "unavailable" | "changed" };

/** Escribe lo planeado en el baul. */
export async function executeSave(plan: Exclude<SavePlan, { action: "error" }>): Promise<ExecuteResult> {
  if (plan.action === "replace") {
    const result = await commitVaultImport({ puts: [plan.merged], deleteIds: [plan.existing.id], expectUnchanged: [plan.existing] });
    if (result.ok) return { ok: true, entryName: plan.merged.signerName, kind: "replaced" };
    return { ok: false, reason: result.reason === "quota" ? "limit" : result.reason };
  }
  const result = await saveVaultEntry(plan.input);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, entryName: result.entry.signerName, kind: result.duplicate ? "duplicate" : plan.completes ? "completed" : "new" };
}

/** Miniatura (data URL) de la imagen que ya tiene una entrada de ese tipo (para decir «esto es lo que se reemplaza»). */
export function existingImageUrl(entry: VaultEntry, kind: VaultKind): string | null {
  const image = kind === "signature" ? entry.signature : entry.initials;
  return image ? vaultImageToDataUrl(image) : null;
}
