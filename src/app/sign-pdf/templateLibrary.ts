import { isDecryptedCopy } from "@/lib/pdf/inputGuard";
import { computeFingerprint } from "@/lib/docLibrary/fingerprint";
import {
  deleteDocument,
  getDocument,
  getDocumentBytes,
  libraryStatus,
  listDocuments,
  markTemplatesCurrent,
  putDocument,
  requestPersistence,
  type PersistenceState,
} from "@/lib/docLibrary/store";
import { createTemplate, getTemplateForDocument, saveTemplateVersion } from "@/lib/docLibrary/templatesStore";
import { buildContent } from "@/lib/docLibrary/templateSchema";
import { suggestDataKey } from "@/lib/docLibrary/dataKeys";
import { FingerprintError, LibraryError, type DocumentEntry, type Fingerprint } from "@/lib/docLibrary/types";
import type { DocTemplate, TemplateDraft, TemplateSignField, TemplateTextField, Variant } from "@/lib/docLibrary/templateTypes";
import { docStateOf, liveFields } from "@/app/sign-pdf/docSet";
import type { SignSession } from "@/app/sign-pdf/signSession";
import {
  contentToDraft,
  emptyContent,
  ensureIds,
  pagesWithFields,
  type EditorContent,
  type Minter,
} from "@/app/sign-pdf/templateEditorModel";
import { clampCount, type AppliedRecord } from "@/app/sign-pdf/templateSession";

/*
 * Lo que el editor de plantillas y la aplicacion automatica necesitan de la biblioteca de documentos (IndexedDB, U2.1/U2.2):
 * guardar «PDF base + plantilla» y abrir un documento guardado como si se acabara de subir.
 *
 * PRIVACIDAD: se guarda UNA copia del PDF base (el contrato en blanco) y las POSICIONES de los campos. Nunca trazos de
 * firma, nunca valores escritos, nunca el nombre de las personas (las etiquetas de los roles son las de la plantilla).
 */

export type SaveFailure =
  | "unavailable"
  | "quota"
  | "tooBig"
  | "full"
  | "conflict"
  | "invalid"
  | "encrypted"
  | "corrupt"
  | "empty"
  | "failed";

export type SaveSuccess = {
  ok: true;
  template: DocTemplate;
  document: DocumentEntry;
  createdDocument: boolean;
  /** Paginas con algun campo en la variante con mas paginas. */
  pages: number;
  /** Resultado de pedir almacenamiento persistente (solo si se guardo un documento nuevo). */
  persistence: PersistenceState | null;
  fingerprint: Fingerprint;
};

export type SaveResult = SaveSuccess | { ok: false; reason: SaveFailure };

export type SaveTemplateInput = {
  file: File;
  content: EditorContent;
  /** Documento de la biblioteca al que pertenece (si ya existe). */
  documentId: string | null;
  /** Plantilla existente que se edita (se guarda como version nueva). */
  template: Pick<DocTemplate, "id" | "rev"> | null;
  /**
   * El contenido sale de lo trabajado en Firmar para UN nº de firmantes (la otra variante viene vacia, no «borrada»): si el
   * documento ya tiene plantilla, la variante que NO se esta guardando se conserva tal cual (y su nombre, roles y diseno de
   * iniciales). Sin esto, guardar la variante de 1 firmante borraria la de 2 (y al reves). No se hace con una plantilla
   * desactualizada: su otra variante describe el PDF de antes.
   */
  keepOtherVariant?: boolean;
  /**
   * «Guardar como documento nuevo»: ignora el documento y la plantilla de los que se partio (se borraron o los cambio otra
   * pestana mientras se editaba) y guarda el trabajo como un documento y una plantilla NUEVOS, para no perder las ediciones.
   */
  asNewDocument?: boolean;
  signal?: AbortSignal;
};

function newDocumentId(): string {
  const bytes = new Uint8Array(9);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  let id = "doc-";
  for (const byte of bytes) id += byte.toString(36).padStart(2, "0");
  return id;
}

function reasonOf(error: unknown): SaveFailure {
  if (error instanceof LibraryError) {
    switch (error.code) {
      case "quota":
      case "tooBig":
      case "full":
      case "conflict":
      case "invalid":
      case "unavailable":
        return error.code;
      default:
        return "failed";
    }
  }
  if (error instanceof FingerprintError) {
    return error.code === "encrypted" ? "encrypted" : error.code === "corrupt" ? "corrupt" : error.code === "empty" ? "empty" : "unavailable";
  }
  return "failed";
}

/** Guarda el PDF base (si es nuevo) y la plantilla (nueva, o version nueva de la que se edita). Nunca lanza. */
export async function saveTemplateToLibrary(input: SaveTemplateInput): Promise<SaveResult> {
  try {
    if (isDecryptedCopy(input.file)) return { ok: false, reason: "encrypted" };
    // Se valida ANTES de guardar nada: un contenido no valido no deja un PDF huerfano en la biblioteca.
    if (!buildContent(contentToDraft(input.content, null))) return { ok: false, reason: "invalid" };
    const status = await libraryStatus();
    if (!status.available) return { ok: false, reason: "unavailable" };
    const bytes = new Uint8Array(await input.file.arrayBuffer());
    const fingerprint = await computeFingerprint(bytes, { signal: input.signal });

    let document: DocumentEntry | null = input.asNewDocument ? null : input.documentId ? await getDocument(input.documentId) : null;
    // El mismo PDF (mismos bytes) ya guardado: se usa ese documento en vez de duplicarlo (salvo «documento nuevo»).
    if (!document && !input.asNewDocument) {
      const { documents } = await listDocuments();
      document = documents.find((entry) => entry.fingerprint.exact === fingerprint.exact) ?? null;
    }
    let createdDocument = false;
    if (!document) {
      document = await putDocument(
        {
          id: newDocumentId(),
          name: input.content.name.trim(),
          docType: "",
          fileName: input.file.name,
          pageCount: fingerprint.pageCount,
          pageSizes: fingerprint.pageSizes,
          fingerprint,
          templateIds: [],
        },
        bytes,
      );
      createdDocument = true;
    }
    try {
      const stored = input.asNewDocument ? null : await getTemplateForDocument(document.id);
      const existing = input.asNewDocument ? null : (input.template ?? stored);
      let draft = contentToDraft(input.content, document.id);
      if (input.keepOtherVariant && stored && !document.templateStale) draft = keepEmptyVariantsFrom(draft, stored);
      const template = existing
        ? await saveTemplateVersion({ id: existing.id, rev: existing.rev, name: draft.name, roles: draft.roles, variants: draft.variants, layout: draft.layout })
        : await createTemplate(draft);
      // La plantilla se acaba de (re)guardar sobre el PDF que hay ahora: ya no esta «desactualizada».
      if (document.templateStale) await markTemplatesCurrent(document.id).catch(() => undefined);
      const persistence = createdDocument ? await requestPersistence() : null;
      const pages = Math.max(pagesWithFields(input.content.variants["1"]), pagesWithFields(input.content.variants["2"]));
      return { ok: true, template, document: (await getDocument(document.id)) ?? document, createdDocument, pages, persistence, fingerprint };
    } catch (error) {
      // Si el documento lo creo esta llamada y la plantilla no se pudo guardar, no queda un PDF sin plantilla.
      if (createdDocument) await deleteDocument(document.id).catch(() => false);
      throw error;
    }
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
}

function isEmptyVariant(variant: { fields?: readonly unknown[]; textFields?: readonly unknown[] } | undefined): boolean {
  return (variant?.fields?.length ?? 0) === 0 && (variant?.textFields?.length ?? 0) === 0;
}

/** De la plantilla ya guardada se conserva lo que el trabajo de Firmar no trae: la variante vacia, el nombre, los roles y el diseno de iniciales. */
function keepEmptyVariantsFrom(draft: TemplateDraft, stored: DocTemplate): TemplateDraft {
  const variants: NonNullable<TemplateDraft["variants"]> = { ...draft.variants };
  let kept = false;
  for (const key of ["1", "2"] as const) {
    if (isEmptyVariant(variants[key]) && !isEmptyVariant(stored.variants[key])) {
      variants[key] = stored.variants[key];
      kept = true;
    }
  }
  if (!kept) return draft;
  return { ...draft, name: stored.name, roles: stored.roles, variants, ...(stored.layout && !draft.layout ? { layout: stored.layout } : {}) };
}

export type LibraryOpen = {
  entry: DocumentEntry;
  file: File;
  template: DocTemplate | null;
};

/** Abre un documento guardado: su PDF base como `File` y su plantilla mas reciente. `null` si ya no existe. */
export async function openLibraryDocument(id: string): Promise<LibraryOpen | null> {
  const [entry, bytes] = await Promise.all([getDocument(id), getDocumentBytes(id)]);
  if (!entry || !bytes) return null;
  const file = new File([bytes as BlobPart], entry.fileName || `${entry.name}.pdf`, { type: "application/pdf" });
  const template = await getTemplateForDocument(id);
  return { entry, file, template };
}

/* ------------------------------------------------------------------ *
 * Del trabajo hecho en Firmar a un contenido de plantilla
 * ------------------------------------------------------------------ */

/**
 * Los huecos y campos del documento `docId` (posiciones, sin trazos ni valores) como contenido de plantilla. El nº de
 * firmantes de la sesion (1 o 2) decide la variante que se rellena; la otra se conserva de `base`. Los nombres de las
 * personas NO pasan: los roles son los de `base` (o los de fabrica).
 */
export function seedContentFromSession(args: {
  session: Pick<SignSession, "signers" | "docs">;
  docId: string;
  name: string;
  language: "es" | "en";
  mint: Minter;
  base?: EditorContent | null;
  /** `dataKey` y regla de los campos de texto ya aplicados desde una plantilla (por id). */
  textMeta?: AppliedRecord["textMeta"];
}): EditorContent {
  const { session, docId } = args;
  const base = args.base ?? emptyContent(args.name, args.language);
  const doc = docStateOf(session.docs, docId);
  const signers = session.signers.slice(0, 2);
  const count = clampCount(Math.max(1, signers.length));
  const key = count === 1 ? "1" : "2";
  const live = liveFields(doc, signers);
  const fields: TemplateSignField[] = live.flatMap((field) => {
    const roleIndex = signers.findIndex((signer) => signer.id === field.signerId);
    if (roleIndex < 0 || roleIndex >= count) return [];
    return [{ id: field.id, roleIndex, pageIndex: field.pageIndex, type: field.type, rect: { ...field.rect }, required: true, source: "manual" as const }];
  });
  const textFields: TemplateTextField[] = doc.textFields
    .filter((field) => field.source !== "heuristic-vector" && field.source !== "heuristic-raster")
    .map((field) => {
      const meta = args.textMeta?.[field.id];
      const type = field.type ?? "text";
      const label = field.label ?? "";
      const dataKey = meta?.dataKey ?? (type === "date" ? "today" : suggestDataKey(label));
      const text: TemplateTextField = { id: field.id, pageIndex: field.pageIndex, rect: { ...field.rect }, type, label, required: meta?.required ?? false, source: "manual" };
      if (dataKey) text.dataKey = dataKey;
      if (meta?.rule ?? (type === "date" ? "today" : undefined)) text.rule = "today";
      return text;
    });
  const variant: Variant = ensureIds({ fields, textFields }, args.mint);
  return { ...base, variants: { ...base.variants, [key]: variant } };
}
