import { computeFingerprint } from "@/lib/docLibrary/fingerprint";
import { getDocument, libraryStatus } from "@/lib/docLibrary/store";
import { findTemplateForFingerprint, getTemplateForDocument } from "@/lib/docLibrary/templatesStore";
import type { DocTemplate, VariantKey } from "@/lib/docLibrary/templateTypes";
import type { Language } from "@/lib/i18n";
import { liveFields, docStateOf, type DocId } from "@/app/sign-pdf/docSet";
import type { SignSession } from "@/app/sign-pdf/signSession";
import { contentFromTemplate, emptyContent, fieldCount, type EditorContent, type Minter } from "@/app/sign-pdf/templateEditorModel";
import { seedContentFromSession } from "@/app/sign-pdf/templateLibrary";
import type { AppliedRecord } from "@/app/sign-pdf/templateSession";

/*
 * Lo que hace falta para ABRIR el editor de plantillas (Fase 2 · U2.3) desde tres sitios: un PDF elegido en el propio
 * boton «Configurar plantilla», el documento que ya esta cargado en Firmar (con lo que ya se hizo en el) y un documento de
 * «Mis documentos» (traspaso). En los tres casos, si el PDF ya tiene plantilla se edita ESA (version nueva), no se
 * duplica.
 */

export type EditorSeed = {
  file: File;
  initial: EditorContent;
  initialVariant: VariantKey;
  documentId: string | null;
  template: DocTemplate | null;
  /** El documento de la ronda de Firmar de donde sale, si sale de ahi (al guardar se le aplica la plantilla). */
  sourceDocId: DocId | null;
  /** Documento de la biblioteca del que se abrio (traspaso): el archivo vuelve a Firmar ligado a el. */
  libraryDocId: string | null;
};

export type PrepareArgs = {
  file: File;
  language: Language;
  mint: Minter;
  /** Documento de la ronda de Firmar y su sesion: lo hecho ahi (huecos y campos) es el punto de partida. */
  session?: SignSession;
  docId?: DocId;
  textMeta?: AppliedRecord["textMeta"];
  /** Documento de la biblioteca (traspaso `configure`). */
  libraryDocId?: string;
  signal?: AbortSignal;
};

export type PrepareResult = { ok: true; seed: EditorSeed } | { ok: false; reason: "unavailable" | "failed" };

export function defaultTemplateName(fileName: string): string {
  return fileName.replace(/\.pdf$/i, "").trim().slice(0, 120) || "Plantilla";
}

export async function prepareEditor(args: PrepareArgs): Promise<PrepareResult> {
  try {
    const status = await libraryStatus();
    if (!status.available) return { ok: false, reason: "unavailable" };
    let documentId: string | null = null;
    let template: DocTemplate | null = null;
    if (args.libraryDocId) {
      const entry = await getDocument(args.libraryDocId);
      if (entry) {
        documentId = entry.id;
        template = await getTemplateForDocument(entry.id);
      }
    } else {
      const fingerprint = await computeFingerprint(args.file, { signal: args.signal });
      const found = await findTemplateForFingerprint(fingerprint);
      if (found && (found.match.level === "exact" || found.match.level === "match")) {
        documentId = found.document.id;
        template = found.template;
      }
    }
    const name = defaultTemplateName(args.file.name);
    const base = template ? contentFromTemplate(template, args.language, args.mint) : emptyContent(name, args.language);
    let initial = base;
    let initialVariant: VariantKey = template ? (template.variants["2"].fields.length > 0 || template.variants["1"].fields.length === 0 ? "2" : "1") : "2";
    if (args.session && args.docId) {
      const doc = docStateOf(args.session.docs, args.docId);
      const hasWork = liveFields(doc, args.session.signers).length > 0 || doc.textFields.some((field) => field.source === "manual");
      if (hasWork) {
        initial = seedContentFromSession({ session: args.session, docId: args.docId, name: base.name, language: args.language, mint: args.mint, base, textMeta: args.textMeta });
        initialVariant = args.session.signers.length >= 2 ? "2" : "1";
        if (fieldCount(initial.variants[initialVariant]) === 0) initialVariant = template ? initialVariant : "2";
      }
    }
    return { ok: true, seed: { file: args.file, initial, initialVariant, documentId, template, sourceDocId: args.docId ?? null, libraryDocId: args.libraryDocId ?? null } };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
