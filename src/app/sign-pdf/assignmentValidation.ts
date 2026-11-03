import { blockGroups, type GroupId } from "@/app/sign-pdf/assignment";
import {
  blockRequiredTypes,
  visibleDraft,
  type BlockContext,
} from "@/app/sign-pdf/blockModel";
import {
  copiesOf,
  coverageIssues,
  docStateOf,
  liveFields,
  normalizeBlocks,
  type DocId,
  type DocState,
} from "@/app/sign-pdf/docSet";
import type { SignSession } from "@/app/sign-pdf/signSession";
import { hasFilledField } from "@/app/sign-pdf/soloSignature";
import { hasTextEdits, stampKeyOf } from "@/app/sign-pdf/textEdits";
import { isFieldFilled, isSuggestionOnly } from "@/lib/pdf/detectFields";
import type { SignatureFieldType } from "@/lib/pdf/sign";
import { MAX_OUTPUT_FILES } from "@/lib/pdf/signCopies";

/*
 * Validaciones de la pantalla «Revisar antes de descargar» (Firma agil · U1.1). Puras: leen la sesion y devuelven una
 * lista de `Issue` con SEVERIDAD y una CLAVE de mensaje (`messageKey`) mas sus parametros; los textos ES/EN los pone la
 * interfaz (U1.4), nunca esta capa. Los parametros llevan ids (firmante, documento, bloque), no nombres: quien pinta los
 * resuelve con la lista de firmantes y de archivos que ya tiene.
 *
 * No sustituye a `deliveryBlockers` (lo que ya impide descargar hoy): es la misma pregunta desde la tabla de
 * asignacion y con mas detalle (grupo, trazo que falta, copias).
 */

export type IssueSeverity = "blocking" | "warning";

/** Cada tipo de problema y la clave de mensaje que le corresponde (`assignment.issue.<kind>`). */
export const ISSUE_KINDS = [
  /** Un hueco de firma cuyo firmante no tiene ningun grupo (bloque) en ese documento. */
  "slotWithoutSigner",
  /** Un firmante firma un documento (tiene grupo) pero ahi no tiene hueco. */
  "signerWithoutSlot",
  /** Un firmante que no firma ningun documento. */
  "signerWithoutDocuments",
  /** Un documento que ningun firmante firma. */
  "documentWithoutSigner",
  /** Campos de texto del documento sin rellenar. */
  "requiredFieldEmpty",
  /** Un grupo al que le falta su firma y/o sus iniciales. */
  "groupWithoutStroke",
  /** Mas archivos que el maximo de una ronda. */
  "tooManyFiles",
  /** Dos grupos del mismo firmante reclaman el mismo documento (dato corrupto). */
  "overlappingGroups",
] as const;

export type IssueKind = (typeof ISSUE_KINDS)[number];

export type IssueMessageKey = `assignment.issue.${IssueKind}`;

export type Issue = {
  kind: IssueKind;
  severity: IssueSeverity;
  /** Clave i18n del mensaje: `assignment.issue.<kind>`. */
  messageKey: IssueMessageKey;
  signerId?: string;
  docId?: DocId;
  blockId?: string;
  /** Letra del grupo (por firmante): «A», «B»... */
  group?: GroupId;
  /** Datos sueltos para la frase (cuantos campos, cuantos archivos, que trazos faltan...). */
  params: Record<string, string | number | readonly string[]>;
};

export type ValidateOptions = {
  /**
   * `false` (por defecto): la severidad que tiene hoy el producto. `true`: la de la pantalla de revision del plan
   * (Fase 1), donde un firmante sin hueco y los campos de texto sin rellenar tambien BLOQUEAN.
   */
  strict?: boolean;
};

export function messageKeyOf(kind: IssueKind): IssueMessageKey {
  return `assignment.issue.${kind}`;
}

/** Hay algo que impide descargar. */
export function hasBlockingIssue(issues: readonly Issue[]): boolean {
  return issues.some((issue) => issue.severity === "blocking");
}

function issue(
  kind: IssueKind,
  severity: IssueSeverity,
  fields: Omit<Issue, "kind" | "severity" | "messageKey" | "params"> & { params?: Issue["params"] },
): Issue {
  const { params, ...rest } = fields;
  return { kind, severity, messageKey: messageKeyOf(kind), ...rest, params: params ?? {} };
}

/** Campos de texto que aun no tienen valor (las sugerencias sin tocar no cuentan: no son del documento). */
function emptyTextFields(doc: DocState): number {
  return doc.textFields.filter(
    (field) =>
      !isSuggestionOnly(field, doc.textValues[field.id]) &&
      field.optional !== true &&
      !isFieldFilled(field, doc.textValues[field.id]),
  ).length;
}

/**
 * Problemas de la asignacion de una sesion, en este orden: huecos sin firmante, firmantes sin hueco, firmantes sin
 * documentos, documentos sin firmante, campos vacios, grupos sin trazo, grupos solapados y exceso de archivos; dentro de
 * cada tipo, por documento y por firmante. Sin problemas, `[]`. «Solo yo» solo comprueba el numero de archivos.
 */
export function validateAssignment(
  session: Pick<SignSession, "mode" | "signers" | "docs" | "docOrder" | "blocks">,
  options: ValidateOptions = {},
): Issue[] {
  const strict = options.strict === true;
  const issues: Issue[] = [];
  const docOrder = session.docOrder;
  const fileCount = docOrder.reduce((sum, id) => sum + copiesOf(docStateOf(session.docs, id)), 0);
  const tooMany =
    fileCount > MAX_OUTPUT_FILES
      ? issue("tooManyFiles", "blocking", { params: { count: fileCount, max: MAX_OUTPUT_FILES } })
      : null;

  if (session.mode !== "multi") return tooMany ? [tooMany] : [];

  const fieldsOf = (docId: DocId) => liveFields(docStateOf(session.docs, docId), session.signers);
  const groups = blockGroups(session.blocks, docOrder, session.signers);

  // 1) Hueco sin firmante: es la cobertura de siempre.
  for (const found of coverageIssues(
    session.signers,
    docOrder,
    Object.fromEntries(docOrder.map((docId) => [docId, { fields: fieldsOf(docId) }])),
    session.blocks,
  )) {
    issues.push(issue("slotWithoutSigner", "blocking", { signerId: found.signerId, docId: found.docId }));
  }

  // Quien firma que: el primer bloque del firmante que cubre el documento (igual que `resolveBlock`).
  const blockOf = (signerId: string, docId: DocId) =>
    session.blocks.find((block) => block.signerId === signerId && block.appliesTo.includes(docId)) ?? null;

  // 2) Firmante con grupo en un documento donde no tiene hueco.
  for (const docId of docOrder) {
    const fields = fieldsOf(docId);
    for (const signer of session.signers) {
      const block = blockOf(signer.id, docId);
      if (!block || fields.some((field) => field.signerId === signer.id)) continue;
      issues.push(
        issue("signerWithoutSlot", strict ? "blocking" : "warning", {
          signerId: signer.id,
          docId,
          blockId: block.id,
          group: groups[block.id],
        }),
      );
    }
  }

  // 3) Firmante sin ningun documento.
  for (const signer of session.signers) {
    if (!docOrder.some((docId) => blockOf(signer.id, docId))) {
      issues.push(issue("signerWithoutDocuments", "warning", { signerId: signer.id }));
    }
  }

  // 4) Documento sin firmante. Si ademas esta vacio (ni huecos, ni campos rellenos, ni ediciones) no hay nada que entregar.
  for (const docId of docOrder) {
    if (session.signers.some((signer) => blockOf(signer.id, docId))) continue;
    const doc = docStateOf(session.docs, docId);
    const hasContent =
      fieldsOf(docId).length > 0 ||
      hasFilledField(doc.textFields, doc.textValues) ||
      hasTextEdits(doc.textEdits);
    issues.push(issue("documentWithoutSigner", hasContent ? "warning" : "blocking", { docId }));
  }

  // 5) Campos de texto sin rellenar.
  for (const docId of docOrder) {
    const count = emptyTextFields(docStateOf(session.docs, docId));
    if (count > 0) {
      issues.push(issue("requiredFieldEmpty", strict ? "blocking" : "warning", { docId, params: { count } }));
    }
  }

  // 6) Grupo sin trazo vigente. Sin huella de algun documento aun no se puede saber (no es culpa de la persona).
  const keys: Record<DocId, string | null> = {};
  for (const docId of docOrder) {
    const doc = docStateOf(session.docs, docId);
    keys[docId] = stampKeyOf(doc.sealedKey || null, doc.textEdits) || null;
  }
  const ctx: BlockContext = { signers: session.signers, docs: session.docs, keys };
  for (const signer of session.signers) {
    for (const block of session.blocks) {
      if (block.signerId !== signer.id) continue;
      const scope = block.appliesTo.filter((id) => docOrder.includes(id));
      if (scope.length === 0 || scope.some((id) => !keys[id])) continue;
      const required = blockRequiredTypes({ ...block, appliesTo: scope }, ctx);
      const missing: SignatureFieldType[] = required.filter(
        (type) => visibleDraft({ ...block, appliesTo: scope }, type, ctx) === null,
      );
      if (missing.length > 0) {
        issues.push(
          issue("groupWithoutStroke", "blocking", {
            signerId: signer.id,
            blockId: block.id,
            group: groups[block.id],
            params: { types: missing, docIds: scope },
          }),
        );
      }
    }
  }

  // 7) Grupos solapados (dato corrupto).
  for (const warning of normalizeBlocks(session.blocks, docOrder).warnings) {
    issues.push(
      issue("overlappingGroups", "blocking", {
        signerId: warning.signerId,
        docId: warning.docId,
        blockId: warning.droppedBlockId,
        params: { keptBlockId: warning.keptBlockId },
      }),
    );
  }

  if (tooMany) issues.push(tooMany);
  return issues;
}
