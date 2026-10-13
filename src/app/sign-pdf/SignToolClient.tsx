"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Bookmark, PenLine } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Sheet } from "@/components/ui/Sheet";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import {
  FileAdmissionContext,
  type FileAdmission,
} from "@/components/tool/fileAdmission";
import {
  SignatureComposer,
  type SignatureDraft,
} from "@/app/sign-pdf/SignatureComposer";
import {
  SignerManager,
  nextSignerId,
  recolor,
  reserveSignerIds,
} from "@/app/sign-pdf/SignerManager";
import {
  DocumentCanvas,
  nextFieldId,
  nextTextFieldId,
  reserveFieldIds,
  reserveTextFieldIds,
  type PlacementTool,
} from "@/app/sign-pdf/DocumentCanvas";
import { useCanvasSequence } from "@/app/sign-pdf/DocumentSequence";
import { PrivacyNotice } from "@/app/sign-pdf/PrivacyNotice";
import { SignatureVaultSheet } from "@/app/sign-pdf/SignatureVaultSheet";
import { VaultNoticeLine } from "@/app/sign-pdf/VaultNoticeLine";
import { useSignatureVault } from "@/app/sign-pdf/useSignatureVault";
import {
  touchVaultEntry,
  vaultImageToDataUrl,
} from "@/app/sign-pdf/signVault";
import { rememberDrafts, type VaultNotice } from "@/app/sign-pdf/vaultMessages";
import { DraftsSheet } from "@/app/sign-pdf/DraftsSheet";
import { draftStatusLine } from "@/app/sign-pdf/draftStatus";
import { flushOnPageHide } from "@/app/sign-pdf/flushOnPageHide";
import { SessionDraftAutosave } from "@/app/sign-pdf/SessionDraftAutosave";
import { restoreSession, type SessionIdentity } from "@/app/sign-pdf/sessionDraft";
import { sessionFromConfigSet } from "@/app/sign-pdf/configSession";
import { TemplatesSheet } from "@/app/sign-pdf/TemplatesSheet";
import {
  instantiateTemplate,
  instantiateTemplateForAll,
  saveTemplate,
  TEMPLATE_NAME_MAX,
  type SignTemplate,
} from "@/app/sign-pdf/signTemplates";
import {
  SigningCeremony,
  pendingSigners,
  validCapture,
  type CaptureMap,
} from "@/app/sign-pdf/SigningCeremony";
import { documentContentKey } from "@/app/sign-pdf/documentKey";
import {
  applyEditsToFile,
  hasTextEdits,
  sanitizeTextEdits,
  stampKeyOf,
} from "@/app/sign-pdf/textEdits";
import {
  DetectionStatus,
  ExportEditsNotice,
  PendingFieldsNotice,
  ReuseValuesPrompt,
} from "@/app/sign-pdf/DocumentSessionParts";
import {
  useDocumentSession,
  type SeenStore,
} from "@/app/sign-pdf/useDocumentSession";
import {
  DocumentSessionHost,
} from "@/app/sign-pdf/DocumentSessionHost";
import { useSessionBridge } from "@/app/sign-pdf/useSessionBridge";
import {
  DEFAULT_SESSION,
  activeDocOf,
  sessionFromView,
  viewOf,
  type SignSession,
} from "@/app/sign-pdf/signSession";
import {
  coverageIssues,
  docIdOf,
  docIdsOf,
  docStateOf,
  ensureBlocks,
  liveFields,
  switchMode,
  type DocId,
  type SignMode as BlockSignMode,
  type SignerBlock,
} from "@/app/sign-pdf/docSet";
import { BlockCeremony } from "@/app/sign-pdf/BlockCeremony";
import {
  CoverageNotices,
  SignModeControl,
  type SignerBlocksApi,
} from "@/app/sign-pdf/SignerBlocks";
import {
  addBlock,
  blockNumber,
  changeBlockScope,
  removeBlock,
  scopeMoveAnnouncement,
  signerBlocks,
  signerLabel,
  type DocRef,
} from "@/app/sign-pdf/blockModel";
import {
  blockerMessages,
  deliveryBlockers,
  signersForDoc,
  type DeliveryBlocker,
} from "@/app/sign-pdf/multiDelivery";
import type { SessionBridge } from "@/app/sign-pdf/useSessionBridge";
import {
  MAX_SIGNERS,
  fitDocumentPrefix,
  MAX_DOCUMENTS,
  MAX_DOCUMENT_BYTES,
  MAX_TOTAL_BYTES,
  admitDocuments,
  type RejectReason,
} from "@/app/sign-pdf/signLimits";
import {
  UNPLACED_RECT,
  buildSoloPlacements,
  buildTextPlacements,
  hasFilledField,
  soloPlacementFromSlots,
  soloReady,
  soloSlotsFrom,
} from "@/app/sign-pdf/soloSignature";
import {
  exportSignConfigSet,
  importSignConfigSet,
  signConfigFilename,
  signConfigSetFilename,
} from "@/app/sign-pdf/signConfig";
import { migrateStep } from "@/app/sign-pdf/signSteps";
import {
  deleteDraft,
  loadDraft,
  loadSessionDraft,
  saveDraft,
  type DraftEntry,
  type SaveDraftParams,
} from "@/app/sign-pdf/signDrafts";
import { SIGN_STRINGS, type SignStrings } from "@/app/sign-pdf/strings";
import { useSignPdfFeatureFlag } from "@/app/sign-pdf/signFeatureFlags";
import { EDIT_STRINGS, type EditInlineStrings } from "@/app/edit-pdf/strings";
import { useEditPdfFeatureFlag } from "@/app/edit-pdf/editFeatureFlags";
import type { SignTextEditConfig } from "@/app/sign-pdf/useSignTextEditing";
import { useI18n, type Language } from "@/lib/i18n";
import {
  MAX_SAFE_FILE_SIZE,
  PdfError,
  downloadBlob,
  loadPdf,
  matchesAccept,
  scaleProgress,
  toPdfError,
  withSuffix,
  type PdfErrorCode,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { isDecryptedCopy } from "@/lib/pdf/inputGuard";
import { type DetectedField } from "@/lib/pdf/detectFields";
import type { TextEdit } from "@/lib/pdf/editTypes";
import {
  SIGNER_COLORS,
  buildSignerFilenamePrefix,
  dataUrlToBytes,
  normalizeFieldLabel,
  signPdfMulti,
  type SignMultiOptions,
  type SignPlacement,
  type SignatureField,
  type Signer,
} from "@/lib/pdf/sign";
import type { NormalizedRect } from "@/lib/pdf/watermark";
import { signBatch } from "@/lib/pdf/signBatch";
import { getTool } from "@/lib/tools-registry";
import { recordValue } from "@/lib/valueHistory";

const TOOL = getTool("sign-pdf");

/** "Solo yo" es el camino rapido de siempre; "varios" abre la ronda por turnos. */
export type SignMode = "single" | "multi";

/**
 * Pasos del flujo con varios firmantes: Firmantes -> Documento -> Firmar.
 * "document" (W2-A) es el lienzo unico donde conviven los huecos de
 * firma/iniciales y los campos de texto; sustituye a los antiguos
 * "fields" (huecos) y "text" (campos + formulario inferior).
 */
export type MultiStep = "signers" | "document" | "sign";

/**
 * Lo que puede venir PERSISTIDO (borradores en IndexedDB guardados antes
 * de W2-A): ademas de los pasos vigentes, los dos que se fusionaron. Se
 * lee tal cual y se normaliza con `migrateStep` al restaurar; nunca se
 * vuelve a escribir.
 */
export type LegacyMultiStep = MultiStep | "fields" | "text";

export { migrateStep };

const MULTI_STEPS: readonly MultiStep[] = ["signers", "document", "sign"] as const;

export type SignToolOptions = {
  mode: SignMode;

  /* --- Solo yo --- */
  signaturePng: string;
  /** alto / ancho del PNG; 0 mientras no hay firma. */
  ratio: number;
  pageIndex: number;
  /** `width: 0` significa "aún sin colocar". */
  rect: NormalizedRect;

  /* --- Varios firmantes --- */
  /**
   * Huella del documento al que pertenecen los huecos y los trazos
   * guardados. `""` = aun sin sellar: documento recien cargado (o recien
   * cambiado) cuya huella todavia no ha llegado; lo que se haga mientras
   * tanto se conserva y la huella solo lo sella al llegar.
   */
  signature: string;
  step: MultiStep;
  signers: Signer[];
  fields: SignatureField[];
  captures: CaptureMap;
  activeSignerId: string | null;
  /** Pagina visible del lienzo del paso "Documento" (huecos y campos de texto comparten lienzo). */
  fieldPageIndex: number;
  /**
   * Hueco seleccionado. Mutuamente exclusivo con `selectedTextFieldId`:
   * el lienzo tiene UNA seleccion (`CanvasSelection`), que `MultiFlow`
   * traduce a estos dos campos para no cambiar el modelo persistido.
   */
  selectedFieldId: string | null;
  /** Herramienta de la paleta (Seleccionar por defecto): decide que crea el proximo gesto. No se persiste. */
  placementTool: PlacementTool;

  /* --- Campos de texto: detectados o anadidos a mano --- */
  textFields: DetectedField[];
  /** Valor de cada campo de texto, indexado por `id`. Vacio = no se empotra. */
  textValues: Record<string, string>;
  /** Campo de texto seleccionado (ver `selectedFieldId`). */
  selectedTextFieldId: string | null;
  /** Campo con el input en linea abierto (distinto de "seleccionado"). */
  editingTextFieldId: string | null;
  /**
   * Huella del documento para el que `textFields` ya viene resuelto (por
   * deteccion real o por restaurar un borrador/una configuracion
   * importada) -- `null` si todavia no hay nada resuelto. Sin esto, el
   * efecto de deteccion de `MultiFlow` (que no mira `textFields`, solo la
   * huella) volveria a detectar y pisaria en silencio los campos ya
   * restaurados de un borrador (incluidos los anadidos a mano, que la
   * deteccion real nunca podria reconstruir).
   */
  textFieldsDetectedFor: string | null;

  /* --- Texto original editado (herramienta «Editar texto», W6-A) --- */
  /**
   * Ediciones del texto del PDF original. Ausente = ninguna. Se aplican ANTES de
   * estampar las firmas y entran en la huella de las capturas (`stampKeyOf`),
   * pero NO en la huella del archivo (`signature`): esa sigue siendo la del
   * contenido original.
   */
  textEdits?: TextEdit[];
};

/**
 * Lo que describe UN documento concreto: huecos, trazos y campos de texto.
 * Se vuelve a este estado cuando el documento cambia; los firmantes, el
 * modo y el tipo de hueco activo no dependen del documento y sobreviven.
 */
const CLEARED_DOCUMENT_STATE: Partial<SignToolOptions> = {
  // "Solo yo": la firma colocada tambien describe un documento concreto
  // (la firma creada no: sobrevive y se vuelve a colocar en el nuevo).
  rect: UNPLACED_RECT,
  pageIndex: 0,
  step: "signers",
  fields: [],
  captures: {},
  fieldPageIndex: 0,
  selectedFieldId: null,
  textFields: [],
  textValues: {},
  selectedTextFieldId: null,
  editingTextFieldId: null,
  textFieldsDetectedFor: null,
  textEdits: [],
};

/**
 * Configuracion de la herramienta «Editar texto» del lienzo (W6-A): solo existe con el ajuste
 * `editExistingText` activo -- o si el documento YA trae ediciones (para poder verlas, deshacerlas
 * y quitarlas aunque el ajuste se apague despues). Las ediciones viven en las opciones del documento.
 */
function useTextEditConfig(
  textEdits: TextEdit[] | undefined,
  setOptions: (patch: Partial<SignToolOptions>) => void,
  editStrings: EditInlineStrings | undefined,
): SignTextEditConfig | undefined {
  const allowed = useEditPdfFeatureFlag("editExistingText");
  const edits = textEdits ?? NO_TEXT_EDITS;
  const setRef = useRef(setOptions);
  useEffect(() => {
    setRef.current = setOptions;
  });
  const enabled = editStrings !== undefined && (allowed || edits.length > 0);
  return useMemo(
    () =>
      enabled && editStrings
        ? {
            edits,
            onEditsChange: (next: TextEdit[]) => setRef.current({ textEdits: next }),
            strings: editStrings,
          }
        : undefined,
    [enabled, edits, editStrings],
  );
}

const NO_TEXT_EDITS: TextEdit[] = [];

/* ------------------------------------------------------------------ *
 * Reutilizacion de valores entre documentos (src/lib/valueHistory.ts)
 * ------------------------------------------------------------------ */

/** Se llama tras un fill+sign+download con exito; nunca bloquea el flujo si falla. */
function recordFilledValues(
  fields: readonly DetectedField[],
  values: Record<string, string>,
): void {
  for (const field of fields) {
    const label = field.label;
    const value = values[field.id]?.trim();
    if (!label || !value) continue;
    recordValue(normalizeFieldLabel(label), value);
  }
}

/** Al menos un campo de texto tiene algo que empotrar. */
function hasFilledTextValue(
  fields: readonly DetectedField[],
  values: Record<string, string>,
): boolean {
  return hasFilledField(fields, values);
}

/**
 * Cada hueco se rellena con el trazo que creo su dueño. Un mismo PNG
 * puede repetirse en varios huecos, asi que se decodifica una sola vez.
 * Solo entran trazos cuya huella sigue describiendo estos huecos: una
 * captura anterior a un cambio de campos o de archivo no se reaplica.
 */
function buildPlacements(
  options: SignToolOptions,
  documentKey: string,
  language: Language,
): SignPlacement[] {
  const decoded = new Map<string, Uint8Array>();
  const placements: SignPlacement[] = [];

  for (const field of options.fields) {
    const draft = validCapture(
      options.captures,
      options.fields,
      field.signerId,
      documentKey,
    )[field.type];
    if (!draft) throw new PdfError("nothingSelected", "sign:notAllSigned");
    let png = decoded.get(draft.dataUrl);
    if (!png) {
      png = dataUrlToBytes(draft.dataUrl);
      decoded.set(draft.dataUrl, png);
    }
    placements.push({
      kind: "image",
      png,
      pageIndex: field.pageIndex,
      rect: field.rect,
    });
  }

  // Los campos de texto son opcionales y van aparte de la ronda de
  // firmantes: uno vacio simplemente no se empotra (nunca "firma en
  // blanco" ni estropea el documento), asi que aqui se descartan sin
  // avisar en vez de exigir que esten todos rellenos.
  placements.push(
    ...buildTextPlacements(options.textFields, options.textValues, language),
  );

  return placements;
}

/**
 * Si el documento tiene huecos de firma/inicial, TODOS deben tener trazo
 * -- los campos de texto son opcionales en ese caso y no bastan por si
 * solos (evita habilitar "Firmar" cuando en realidad falta un firmante,
 * que hoy solo fallaria despues con "sign:notAllSigned"). Solo cuando NO
 * hay huecos de imagen se acepta rellenar-y-descargar con al menos un
 * campo de texto lleno.
 */
export function multiReady(
  options: SignToolOptions,
  documentKey: string | null,
): boolean {
  if (options.fields.length > 0) {
    return (
      pendingSigners(
        options.signers,
        options.fields,
        options.captures,
        stampKeyOf(documentKey, options.textEdits),
      ).length === 0
    );
  }

  return (
    hasFilledTextValue(options.textFields, options.textValues) ||
    hasTextEdits(options.textEdits)
  );
}

/**
 * La entrega de VARIOS documentos (ZIP, un PDF por documento) y la ceremonia
 * por bloques estan conectadas. Apagarlo desactiva la descarga conjunta
 * (`canRun`) y `process()` lanza una excepcion controlada.
 */
export const BATCH_DELIVERY_READY = true;

export type DocumentJobContext = {
  language: Language;
  strings: SignStrings;
  certificateEnabled: boolean;
  /**
   * Firmantes del certificado de ESTE documento. Con varios documentos son
   * solo los que firman ese documento (`signersForDoc`), no todos los de la
   * sesion; ausente = todos (un documento, como siempre).
   */
  signerNames?: readonly string[];
};

/** Lo necesario para empotrar UN documento. */
export type DocumentJob = {
  docId: DocId;
  /** El archivo original del documento. */
  file: File;
  /** Lo que recibe `signPdfMulti`: colocaciones y, en la ronda por turnos, el certificado. */
  params: SignMultiOptions;
  /**
   * Ediciones del texto original (herramienta «Editar texto»): se aplican al PDF
   * ANTES de estampar nada (`runDocumentJob`), asi que las firmas caen sobre el
   * documento ya editado.
   */
  textEdits: readonly TextEdit[];
  /** A llamar tras un empotrado con exito (historial de valores reutilizables). */
  commit: () => void;
};

/** El trabajo solo edita texto: no estampa ninguna firma (imagen). Sus archivos acaban en `-editado`. */
export function isEditOnlyJob(job: Pick<DocumentJob, "params" | "textEdits">): boolean {
  return hasTextEdits(job.textEdits) && !job.params.placements.some((placement) => placement.kind === "image");
}

/**
 * Produce el PDF final de UN documento: primero aplica las ediciones de texto
 * (si hay) y despues estampa firmas y campos sobre el resultado. Con ediciones
 * y nada que estampar, el PDF editado ES el resultado. Sin ediciones es
 * exactamente `signPdfMulti(file, params, onProgress)` de siempre.
 */
export async function runDocumentJob(
  job: DocumentJob,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  if (!hasTextEdits(job.textEdits)) {
    return signPdfMulti(job.file, job.params, onProgress);
  }
  const editedOnly = job.params.placements.length === 0;
  const applied = await applyEditsToFile(job.file, job.textEdits, {
    onProgress: onProgress
      ? (value) => onProgress(scaleProgress(value, 0, editedOnly ? 1 : 0.4))
      : undefined,
  });
  if (editedOnly) {
    return new Blob([await applied.file.arrayBuffer()], { type: "application/pdf" });
  }
  return signPdfMulti(
    applied.file,
    job.params,
    onProgress ? (value) => onProgress(scaleProgress(value, 0.4, 1)) : undefined,
  );
}

/**
 * Prepara el trabajo de UN documento a partir de la sesion: su vista plana
 * (`viewOf`), las colocaciones y el certificado. Es la pieza reutilizable por
 * la entrega de varios documentos (U2): se llama una vez por `docId`, cada uno
 * con SUS huecos, SUS campos y los trazos que le corresponden.
 *
 * Misma comprobacion definitiva de siempre en la ronda por turnos: se vuelve a
 * calcular la huella justo antes de escribir, para que el archivo que se firma
 * sea el que vieron los firmantes aunque lo hayan cambiado por otro de igual
 * nombre, tamano y fecha.
 */
export async function prepareDocumentJob(
  docId: DocId,
  file: File,
  session: SignSession,
  { language, strings, certificateEnabled, signerNames }: DocumentJobContext,
): Promise<DocumentJob> {
  const options = viewOf(session, docId);

  if (options.mode === "single") {
    // La firma colocada (si hay) y los campos con valor: sola la firma es
    // exactamente la colocacion de siempre. Sin certificado ni prefijo de
    // firmantes: son de la ronda por turnos.
    const placements = buildSoloPlacements(options, language);
    if (placements.length === 0 && !hasTextEdits(options.textEdits)) {
      throw new PdfError("empty");
    }
    return {
      docId,
      file,
      params: { placements },
      textEdits: options.textEdits ?? [],
      commit: () => recordFilledValues(options.textFields, options.textValues),
    };
  }

  const hasText = hasFilledTextValue(options.textFields, options.textValues);
  if (options.fields.length === 0 && !hasText && !hasTextEdits(options.textEdits)) {
    throw new PdfError("nothingSelected", "sign:noFields");
  }
  const fileKey = await documentContentKey(file).catch(() => null);
  if (!fileKey) {
    throw new PdfError("inspectionIncomplete", "sign:documentKey");
  }
  // Las capturas se sellaron con la huella del archivo MAS la de sus ediciones de texto.
  const documentKey = stampKeyOf(fileKey, options.textEdits) as string;
  return {
    docId,
    file,
    textEdits: options.textEdits ?? [],
    params: {
      placements: buildPlacements(options, documentKey, language),
      certificate: certificateEnabled
        ? {
            signerNames: signerNames ?? options.signers.map((signer) => signer.name),
            labels: {
              title: strings.certificateTitle,
              hashLabel: strings.certificateHashLabel,
              timestampLabel: strings.certificateTimestampLabel,
              signersLabel: strings.certificateSignersLabel,
              noSignerName: strings.certificateNoSignerName,
              disclaimer: strings.certificateDisclaimer,
            },
          }
        : undefined,
    },
    // Solo se guarda tras un empotrado con exito.
    commit: () => recordFilledValues(options.textFields, options.textValues),
  };
}

/**
 * VARIOS documentos -> un ZIP con un PDF firmado por documento (`signBatch`:
 * secuencial, progreso, cancelacion entre documentos y fallo parcial). Cada
 * documento se prepara con SU vista derivada (`prepareDocumentJob`: sus
 * huecos, sus campos, los trazos de sus bloques y la huella recalculada justo
 * antes de firmar). En «Varios firmantes» los firmantes del certificado y del
 * nombre son SOLO los que firman ESE documento (`signersForDoc`) y es la
 * misma lista para ambos; en «Solo yo» no hay firmantes y el nombre es
 * `<documento>-firmado.pdf`. Sin pregunta de prefijo: en varios documentos el
 * nombre siempre es automatico.
 */
export async function signDocumentsBatch({
  files,
  session,
  onProgress,
  signal,
  context,
}: {
  files: File[];
  session: SignSession;
  onProgress: ProgressCallback;
  signal?: AbortSignal;
  context: DocumentJobContext;
}): Promise<ProcessResult> {
  const result = await signBatch({
    documents: files.map((file) => ({
      id: docIdOf(file),
      file,
      name: file.name,
    })),
    lang: context.language,
    signal,
    onProgress,
    limits: { maxDocuments: MAX_DOCUMENTS, maxTotalBytes: MAX_TOTAL_BYTES },
    sign: async (document, progress) => {
      const signerNames =
        session.mode === "multi"
          ? signersForDoc(session, document.id).map((signer) => signer.name)
          : [];
      const job = await prepareDocumentJob(document.id, document.file, session, {
        ...context,
        signerNames,
      });
      const blob = await runDocumentJob(job, progress.onProgress);
      job.commit();
      const edited = isEditOnlyJob(job);
      return {
        bytes: new Uint8Array(await blob.arrayBuffer()),
        // Sin firma estampada no hay firmantes que nombrar en el archivo.
        signerNames: edited ? [] : signerNames,
        ...(edited ? { edited: true } : {}),
      };
    },
  });
  return { blob: result.blob, filename: result.filename, report: result.report };
}

/** Documento activo REAL de la sesion, con su archivo y su vista plana. */
function activeViewOf(
  session: SignSession,
  files: readonly File[],
): { docId: DocId; file: File | null; view: SignToolOptions } {
  const docId = activeDocOf(session, docIdsOf(files)) ?? "";
  const file = files.find((candidate) => docIdOf(candidate) === docId) ?? null;
  return { docId, file, view: viewOf(session, docId) };
}

/** Avisos amables de lo que no cupo en la ronda, agrupados por motivo. */
function describeRejections(
  rejected: readonly { file: File; reason: RejectReason }[],
  strings: SignStrings,
): string | null {
  if (rejected.length === 0) return null;
  const names = (reason: RejectReason) =>
    rejected.filter((item) => item.reason === reason).map((item) => item.file.name);
  const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
  const messages: string[] = [];
  const size = names("size");
  const count = names("count");
  const total = names("total");
  if (size.length > 0) messages.push(strings.docLimitSize(mb(MAX_DOCUMENT_BYTES), size));
  if (count.length > 0) messages.push(strings.docLimitCount(MAX_DOCUMENTS, count));
  if (total.length > 0) messages.push(strings.docLimitTotal(mb(MAX_TOTAL_BYTES), total));
  return messages.join(" ");
}

export function SignToolClient() {
  const { language, t } = useI18n();
  const strings = SIGN_STRINGS[language];
  const completionCertificateEnabled = useSignPdfFeatureFlag(
    "completionCertificate",
  );
  /**
   * Varios documentos a la vez. Apagado, la herramienta es la de siempre: un
   * solo archivo (`multiple: false`). El registro no cambia; solo la copia
   * que se le da al shell.
   */
  const multiDocumentEnabled = useSignPdfFeatureFlag("multiDocument");
  const tool = useMemo(
    () => ({ ...TOOL, multiple: multiDocumentEnabled }),
    [multiDocumentEnabled],
  );
  const [composerOpen, setComposerOpen] = useState(false);
  /**
   * Baul de firmas (W3), "Solo yo": estado PROPIO, fuera de `SignToolOptions`
   * (`CLEARED_DOCUMENT_STATE` lo limpiaria al cambiar de archivo y una firma
   * guardada no describe un documento). Con el flag apagado no se abre la base.
   */
  const vaultEnabled = useSignPdfFeatureFlag("signatureVault");
  const vault = useSignatureVault(vaultEnabled);
  const [vaultOpen, setVaultOpen] = useState(false);
  const [vaultNotice, setVaultNotice] = useState<VaultNotice | null>(null);
  /**
   * Puente con la sesion canonica que guarda `ToolShell`: escribe contra el
   * estado mas reciente y descarta lo que llega de un documento ya retirado
   * (ver `useSessionBridge`). Sustituye a la memoria del "ultimo archivo
   * visto": ahora el estado de cada documento cuelga de su `DocId`, asi que
   * cargar otro archivo nunca hereda lo del anterior.
   */
  const bridge = useSessionBridge();
  /** Lo rellena `ToolShell`: remata la ronda con el mismo procesado de siempre. */
  const runRef = useRef<(() => void) | null>(null);
  /** Lo rellena `ToolShell`: reinicia el flujo con un patch parcial de opciones. */
  const resetRef = useRef<((patch?: Partial<SignSession>) => void) | null>(
    null,
  );
  /** Lo rellena `ToolShell`: carga un archivo (borrador/importacion) sin pasar por el dropzone. */
  const loadRef = useRef<
    ((files: File[], patch?: Partial<SignSession>) => void) | null
  >(null);

  /** Reinicia el flujo conservando solo lo que el patch nombra (y el puente lo sigue). */
  const resetSession = useCallback(
    (patch?: Partial<SignSession>) => {
      bridge.replace([], patch);
      resetRef.current?.(patch);
    },
    [bridge],
  );

  /** Carga UN documento ya preparado (borrador, configuracion importada) sin pasar por el dropzone. */
  const loadDocument = useCallback(
    (file: File, view: Partial<SignToolOptions>) => {
      const patch = sessionFromView(docIdOf(file), view);
      bridge.replace([file], patch);
      loadRef.current?.([file], patch);
    },
    [bridge],
  );

  /** Carga VARIOS documentos ya preparados (sesion retomada, configuracion con varios) sin pasar por el dropzone. */
  const loadSession = useCallback(
    (files: File[], patch: Partial<SignSession>) => {
      bridge.replace(files, patch);
      loadRef.current?.(files, patch);
    },
    [bridge],
  );

  /**
   * Topes de la ronda (documentos, peso por documento y total): los consulta
   * `FileDropzone` antes de aceptar archivos. El aviso se pinta junto a los
   * demas de la barra superior.
   */
  const [admissionNotice, setAdmissionNotice] = useState<string | null>(null);
  const admission = useMemo<FileAdmission>(
    () => ({
      admit: (current, incoming) => {
        const { accepted, rejected } = admitDocuments(current, incoming);
        return { accepted, notice: describeRejections(rejected, strings) };
      },
      onNotice: setAdmissionNotice,
    }),
    [strings],
  );
  const [draftsOpen, setDraftsOpen] = useState(false);
  /**
   * Identidad del borrador de SESION (varios documentos) que se esta
   * guardando: la fija `SessionDraftAutosave` al guardar y quien retoma una
   * sesion. Vive aqui porque `ToolShell` desmonta el espacio de trabajo
   * mientras procesa y debe sobrevivir a eso.
   */
  const sessionIdentityRef = useRef<SessionIdentity | null>(null);
  /** Aviso de los borradores de sesion (tope de tamano, ajustes al retomar). */
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const [sessionTooBig, setSessionTooBig] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const reusableTemplatesEnabled = useSignPdfFeatureFlag("reusableTemplates");
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  /** Mensaje de la ultima accion de plantilla (exito, error o "N campos descartados"). Compartido entre guardar/aplicar: solo una accion de plantilla esta en marcha a la vez. */
  const [templateFeedback, setTemplateFeedback] = useState<string | null>(
    null,
  );
  /** Plantilla elegida en el sheet, esperando confirmacion porque ya hay disposicion cargada que se perderia. */
  const [pendingApplyTemplate, setPendingApplyTemplate] =
    useState<SignTemplate | null>(null);
  /** «Aplicar a todos los documentos»: plantilla elegida, esperando confirmacion (reemplaza TODA la ronda). */
  const [pendingApplyAll, setPendingApplyAll] = useState<SignTemplate | null>(null);

  /**
   * Respuesta del prompt de prefijo de firmantes (ver `requestFinish`),
   * leida por `process()` en el momento de escribir el archivo. Va en un
   * ref (no en `SignToolOptions`) para no depender de que un `setOptions`
   * asincronico ya se haya reflejado en el render antes de disparar
   * `runRef.current?.()` -- evita una condicion de carrera real entre
   * "guardar la eleccion" y "arrancar el procesado".
   */
  const signerPrefixRef = useRef(false);
  const [prefixPromptOpen, setPrefixPromptOpen] = useState(false);

  /**
   * Se llama al pulsar "Firmar y descargar"/"Aplicar y descargar" en modo
   * multi. Si hay al menos un firmante con nombre, pregunta si prefijar
   * el archivo con esos nombres antes de arrancar el procesado real; si
   * ninguno tiene nombre, no tiene sentido preguntar y se salta directo.
   */
  const requestFinish = useCallback((signers: Signer[]) => {
    const hasNamedSigner = signers.some((signer) => signer.name.trim().length > 0);
    if (!hasNamedSigner) {
      signerPrefixRef.current = false;
      runRef.current?.();
      return;
    }
    setPrefixPromptOpen(true);
  }, []);

  const choosePrefix = useCallback((useSignerPrefix: boolean) => {
    signerPrefixRef.current = useSignerPrefix;
    setPrefixPromptOpen(false);
    runRef.current?.();
  }, []);

  /**
   * Errores de "cargar sin pasar por el dropzone" (reanudar un borrador,
   * importar una configuracion): `ToolShell` no expone su propio
   * `setError` fuera de `renderMain`/`renderOptions` (solo se pintan
   * mientras hay archivo), y estas acciones tienen sentido tambien sin
   * ninguno cargado todavia -- de ahi este estado propio.
   */
  const [loadError, setLoadError] = useState<PdfErrorCode | null>(null);

  /** Valida como lo haria `FileDropzone`: un borrador/importacion no se salta esa puerta. */
  const validateLoadedFile = useCallback((file: File): boolean => {
    if (
      !matchesAccept(file, TOOL.accept, TOOL.extensions) ||
      file.size > MAX_SAFE_FILE_SIZE
    ) {
      setLoadError(file.size > MAX_SAFE_FILE_SIZE ? "tooLarge" : "invalidType");
      return false;
    }
    return true;
  }, []);

  const handleResumeDraft = useCallback(
    async (id: string) => {
      const loaded = await loadDraft(id);
      if (!loaded) {
        setLoadError("unknown");
        return;
      }
      const file = new File([loaded.bytes as BlobPart], loaded.meta.fileName, {
        type: "application/pdf",
      });
      if (!validateLoadedFile(file)) return;

      reserveSignerIds(loaded.meta.signers.map((signer) => signer.id));
      reserveFieldIds(loaded.meta.fields.map((field) => field.id));
      reserveTextFieldIds(loaded.meta.textFields.map((field) => field.id));

      // Un documento suelto: el borrador de siempre (formato v1), sin sesion.
      sessionIdentityRef.current = null;
      loadDocument(file, {
        mode: loaded.meta.mode,
        signature: loaded.meta.id,
        // Un borrador anterior a W2-A puede traer "fields" o "text": ambos
        // viven ahora en "document", con sus huecos y campos intactos.
        step: migrateStep(loaded.meta.step),
        signers: loaded.meta.signers,
        fields: loaded.meta.fields,
        captures: loaded.meta.captures,
        textFields: loaded.meta.textFields,
        textValues: loaded.meta.textValues,
        textFieldsDetectedFor: loaded.meta.textFieldsDetectedFor,
        textEdits: sanitizeTextEdits(loaded.meta.textEdits),
      });
      setLoadError(null);
      setDraftNotice(null);
      setDraftsOpen(false);
    },
    [loadDocument, validateLoadedFile],
  );

  /** Retoma un borrador de SESION: todos sus documentos, firmantes, bloques y firmas, sellados de nuevo con la huella recalculada. */
  const handleResumeSession = useCallback(
    async (id: string) => {
      try {
        const loaded = await loadSessionDraft(id);
        if (!loaded) {
          setLoadError("unknown");
          return;
        }
        const files = loaded.files.map(
          (item) =>
            new File([item.bytes as BlobPart], item.fileName, {
              type: "application/pdf",
            }),
        );
        if (files.length === 0 || !files.every(validateLoadedFile)) return;
        // Con «varios documentos» apagado la herramienta es de UN archivo: no se
        // carga una ronda de varios (y no se toca el borrador, que sigue ahi).
        if (!multiDocumentEnabled && files.length > 1) {
          setDraftNotice(strings.multiDocOffNotice);
          setDraftsOpen(false);
          return;
        }
        // Topes de la ronda: se restauran los primeros documentos que quepan.
        const fits = fitDocumentPrefix(files);
        if (fits === 0) {
          setLoadError("tooLarge");
          return;
        }
        const trimmed = fits < files.length;
        if (trimmed) files.length = fits;
        const keys = await Promise.all(files.map((file) => documentContentKey(file)));

        const meta = trimmed
          ? { ...loaded.meta, documents: loaded.meta.documents.slice(0, fits) }
          : loaded.meta;
        reserveSignerIds(meta.signers.map((signer) => signer.id));
        for (const state of Object.values(meta.docStates)) {
          reserveFieldIds((state.fields ?? []).map((field) => field.id));
          reserveTextFieldIds((state.textFields ?? []).map((field) => field.id));
        }

        const restored = restoreSession(meta, files, keys);
        sessionIdentityRef.current = restored.identity;
        loadSession(files, restored.patch);
        setLoadError(null);
        setDraftsOpen(false);
        const notices = [
          trimmed ? strings.draftsResumeTrimmed(fits, loaded.meta.documents.length) : null,
          restored.staleDocs > 0 ? strings.draftsResumeStale(restored.staleDocs) : null,
          restored.normalized > 0 ? strings.draftsResumeNormalized(restored.normalized) : null,
        ].filter((notice): notice is string => notice !== null);
        setDraftNotice(notices.length > 0 ? notices.join(" ") : null);
      } catch (caught) {
        setLoadError(toPdfError(caught).code);
      }
    },
    [loadSession, multiDocumentEnabled, strings, validateLoadedFile],
  );

  const handleResumeEntry = useCallback(
    (entry: DraftEntry) => {
      if (entry.kind === "session") void handleResumeSession(entry.meta.id);
      else void handleResumeDraft(entry.meta.id);
    },
    [handleResumeDraft, handleResumeSession],
  );

  const handleImportConfig = useCallback(
    async (zipFile: File) => {
      try {
        // v1 (un documento) o v2 (varios): la misma validacion estricta.
        const set = await importSignConfigSet(zipFile);
        const files = set.documents.map((doc) => doc.file);
        if (!files.every(validateLoadedFile)) return;
        // Misma regla que al retomar una sesion: sin «varios documentos» no se carga una ronda de varios.
        if (!multiDocumentEnabled && files.length > 1) {
          setDraftNotice(strings.multiDocOffNotice);
          return;
        }
        const keys = await Promise.all(files.map((file) => documentContentKey(file)));

        reserveSignerIds(set.signers.map((signer) => signer.id));
        for (const doc of set.documents) {
          reserveFieldIds(doc.fields.map((field) => field.id));
          reserveTextFieldIds(doc.textFields.map((field) => field.id));
        }

        sessionIdentityRef.current = null;
        loadSession(files, sessionFromConfigSet(set, files, keys));
        setLoadError(null);
        setDraftNotice(null);
      } catch (caught) {
        setLoadError(toPdfError(caught).code);
      }
    },
    [loadSession, multiDocumentEnabled, strings, validateLoadedFile],
  );

  /** Exporta la configuracion de TODA la ronda: con un documento, el .zip v1 de siempre; con varios, el v2. */
  const handleExportConfig = useCallback(
    async (files: File[], session: SignSession) => {
      try {
        if (files.length === 0) return;
        const documents = files.map((item) => {
          const id = docIdOf(item);
          const state = docStateOf(session.docs, id);
          return {
            id,
            file: item,
            fields: liveFields(state, session.signers),
            textFields: state.textFields,
            textValues: state.textValues,
          };
        });
        const blob = await exportSignConfigSet(documents, {
          mode: session.mode,
          signMode: session.signMode,
          signers: session.signers,
          blocks: session.blocks,
        });
        downloadBlob(
          blob,
          files.length > 1
            ? signConfigSetFilename(files.length)
            : signConfigFilename(files[0].name),
        );
        setLoadError(null);
      } catch (caught) {
        setLoadError(toPdfError(caught).code);
      }
    },
    [],
  );

  /**
   * Guarda la disposicion ACTUAL (firmantes + huecos + campos de texto,
   * sin valores) como plantilla con nombre, reutilizable en otro
   * documento. `pageCount` se resuelve del propio archivo.
   */
  const handleSaveTemplate = useCallback(
    async (file: File, options: SignToolOptions, name: string) => {
      try {
        const pdf = await loadPdf(file);
        const result = saveTemplate({
          name,
          pageCount: pdf.getPageCount(),
          signers: options.signers,
          fields: options.fields,
          textFields: options.textFields,
        });
        if (result === "limit") {
          setTemplateFeedback(strings.saveTemplateLimitError);
          return;
        }
        if (result === "unavailable") {
          setTemplateFeedback(strings.saveTemplateUnavailableError);
          return;
        }
        setTemplateFeedback(strings.saveTemplateSuccess);
      } catch {
        setTemplateFeedback(strings.saveTemplateUnavailableError);
      }
    },
    [strings],
  );

  /**
   * Aplica una plantilla al documento YA cargado (nunca lo reemplaza):
   * ids siempre nuevos (los acuñadores, nunca los guardados en la
   * plantilla), y `textFieldsDetectedFor` fijado al `documentKey` actual
   * -- sin esto, el efecto de deteccion de `MultiFlow` pisaria en
   * silencio los campos de texto recien aplicados (mismo riesgo que ya
   * evita `handleImportConfig`).
   */
  const performApplyTemplate = useCallback(
    async (
      template: SignTemplate,
      file: File,
      setOptions: (patch: Partial<SignToolOptions>) => void,
    ) => {
      try {
        const pdf = await loadPdf(file);
        const documentKey = await documentContentKey(file);
        const instantiated = instantiateTemplate(template, {
          pageCount: pdf.getPageCount(),
          mintSignerId: nextSignerId,
          mintFieldId: nextFieldId,
          mintTextFieldId: nextTextFieldId,
        });
        if (!instantiated) {
          setTemplateFeedback(strings.applyTemplateNothingFits);
          setPendingApplyTemplate(null);
          return;
        }
        setOptions({
          signers: instantiated.signers,
          fields: instantiated.fields,
          textFields: instantiated.textFields,
          captures: {},
          textValues: {},
          activeSignerId: instantiated.signers[0]?.id ?? null,
          selectedFieldId: null,
          selectedTextFieldId: null,
          editingTextFieldId: null,
          textFieldsDetectedFor: documentKey,
          step: "document",
        });
        setTemplateFeedback(
          instantiated.dropped > 0
            ? strings.applyTemplateDropped(instantiated.dropped)
            : null,
        );
        setTemplatesOpen(false);
        setPendingApplyTemplate(null);
      } catch (caught) {
        setPendingApplyTemplate(null);
        setLoadError(toPdfError(caught).code);
      }
    },
    [strings],
  );

  /**
   * «Aplicar a todos los documentos»: los firmantes de la plantilla se fijan UNA
   * vez (son los mismos para toda la ronda) y los huecos/campos se repiten en
   * cada documento con ids propios; lo que cae en una pagina que un documento
   * no tiene se descarta y se cuenta. Reemplaza la disposicion de TODOS los
   * documentos y borra las firmas ya hechas (los firmantes son nuevos). Se
   * escribe en una sola operacion contra el estado mas reciente de la sesion.
   */
  const performApplyTemplateToAll = useCallback(
    async (template: SignTemplate, files: File[]) => {
      try {
        const docs = await Promise.all(
          files.map(async (file) => ({
            id: docIdOf(file),
            pageCount: (await loadPdf(file)).getPageCount(),
            key: await documentContentKey(file),
          })),
        );
        const instantiated = instantiateTemplateForAll(
          template,
          docs.map(({ id, pageCount }) => ({ id, pageCount })),
          {
            mintSignerId: nextSignerId,
            mintFieldId: nextFieldId,
            mintTextFieldId: nextTextFieldId,
          },
        );
        if (!instantiated) {
          setTemplateFeedback(strings.applyTemplateNothingFits);
          setPendingApplyAll(null);
          return;
        }
        bridge.commit((current, currentFiles) => {
          const order = docIdsOf(currentFiles);
          const live = new Set(order);
          let nextDocs = current.docs;
          for (const doc of docs) {
            const layout = instantiated.perDoc[doc.id];
            if (!layout || !live.has(doc.id)) continue;
            nextDocs = {
              ...nextDocs,
              [doc.id]: {
                ...docStateOf(nextDocs, doc.id),
                fields: layout.fields,
                textFields: layout.textFields,
                textValues: {},
                // Sin esto la deteccion de `MultiFlow` pisaria los campos recien aplicados.
                textFieldsDetectedFor: doc.key,
              },
            };
          }
          return {
            signers: instantiated.signers,
            docs: nextDocs,
            // Firmantes nuevos: los bloques (y sus firmas) de los anteriores ya no valen.
            blocks: ensureBlocks(instantiated.signers, order, current.signMode, []),
            activeSignerId: instantiated.signers[0]?.id ?? null,
            selectedFieldId: null,
            selectedTextFieldId: null,
            editingTextFieldId: null,
            step: "document",
          };
        });
        setTemplateFeedback(
          strings.applyTemplateAllDone(files.length, instantiated.dropped),
        );
        setTemplatesOpen(false);
        setPendingApplyAll(null);
      } catch (caught) {
        setPendingApplyAll(null);
        setLoadError(toPdfError(caught).code);
      }
    },
    [bridge, strings],
  );

  /**
   * UN documento de la sesion -> su archivo firmado. Reutilizable por la
   * entrega de varios (U2): recibe el `docId` y trabaja con su vista derivada.
   */
  const processDocument = useCallback(
    async (
      docId: DocId,
      file: File,
      session: SignSession,
      onProgress: ProgressCallback,
    ): Promise<ProcessResult> => {
      const job = await prepareDocumentJob(docId, file, session, {
        language,
        strings,
        certificateEnabled: completionCertificateEnabled,
      });
      const blob = await runDocumentJob(job, onProgress);
      job.commit();
      // Solo texto editado y ninguna firma estampada: el archivo no esta «firmado».
      const baseFilename = withSuffix(
        file.name,
        isEditOnlyJob(job) ? strings.editedFilenameSuffix : strings.filenameSuffix,
      );

      if (session.mode === "single") return { blob, filename: baseFilename };

      const prefix = signerPrefixRef.current && !isEditOnlyJob(job)
        ? buildSignerFilenamePrefix(session.signers.map((signer) => signer.name))
        : null;
      return {
        blob,
        filename: prefix ? `${prefix}_${baseFilename}` : baseFilename,
      };
    },
    [strings, language, completionCertificateEnabled],
  );

  const processBatch = useCallback(
    (
      files: File[],
      session: SignSession,
      onProgress: ProgressCallback,
      signal: AbortSignal,
    ): Promise<ProcessResult> =>
      signDocumentsBatch({
        files,
        session,
        onProgress,
        signal,
        context: { language, strings, certificateEnabled: completionCertificateEnabled },
      }),
    [language, strings, completionCertificateEnabled],
  );

  /**
   * Remata la ronda. Con UN documento: el mismo procesado de siempre
   * (`processDocument`). Con varios: la entrega conjunta (`processBatch`).
   */
  const process = useCallback(
    async (
      files: File[],
      session: SignSession,
      onProgress: ProgressCallback,
      signal: AbortSignal,
    ): Promise<ProcessResult> => {
      if (files.length > 1) {
        if (!BATCH_DELIVERY_READY) {
          throw new PdfError("unknown", "sign:batchNotConnected");
        }
        return processBatch(files, session, onProgress, signal);
      }

      const { docId, file } = activeViewOf(session, files);
      if (!file) throw new PdfError("empty");
      return processDocument(docId, file, session, onProgress);
    },
    [processBatch, processDocument],
  );

  return (
    <Fragment>
    <div className="mx-auto mb-4 flex w-full max-w-[1200px] flex-wrap items-center gap-2 px-4 md:px-6">
      <Button variant="ghost" size="sm" onClick={() => setDraftsOpen(true)}>
        {strings.draftsButton}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => importInputRef.current?.click()}
      >
        {strings.importConfigButton}
      </Button>
      <input
        ref={importInputRef}
        type="file"
        accept=".zip,application/zip"
        aria-label={strings.importConfigButton}
        className="sr-only"
        onChange={(event) => {
          const zipFile = event.target.files?.[0];
          event.target.value = "";
          if (zipFile) void handleImportConfig(zipFile);
        }}
      />
      {loadError ? (
        <p role="alert" className="text-xs text-destructive">
          {t.tool.errors[loadError]}
        </p>
      ) : null}
      {/* Region viva siempre montada: lo que no cupo en la ronda (documentos, peso). */}
      <p
        role="status"
        aria-live="polite"
        className={admissionNotice ? "text-xs text-muted-foreground" : "sr-only"}
      >
        {admissionNotice}
      </p>
      {admissionNotice ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setAdmissionNotice(null)}
          aria-label={t.common.close}
        >
          {t.common.close}
        </Button>
      ) : null}
      {/* Region viva siempre montada: borrador de sesion (tope de tamano, ajustes al retomar). */}
      <p
        role="status"
        aria-live="polite"
        className={
          sessionTooBig || draftNotice
            ? "basis-full text-xs text-muted-foreground"
            : "sr-only"
        }
      >
        {draftStatusLine(sessionTooBig, strings.draftsTooBig, draftNotice)}
      </p>
    </div>
    <DraftsSheet
      open={draftsOpen}
      onClose={() => setDraftsOpen(false)}
      onResume={handleResumeEntry}
      strings={strings}
    />
    <FileAdmissionContext.Provider value={admission}>
    <ToolShell<SignSession>
      tool={tool}
      defaultOptions={DEFAULT_SESSION}
      process={process}
      progressMessage={strings.progressMessage}
      runRef={runRef}
      resetRef={resetRef}
      loadRef={loadRef}
      renderDone={({ options }) =>
        options.mode === "multi" && options.signers.length > 0 ? (
          <SignAgainPrompt
            onAccept={() =>
              resetSession({
                mode: "multi",
                signers: options.signers,
                step: "signers",
              })
            }
            strings={strings}
          />
        ) : null
      }
      // "Solo yo" necesita algo que aplicar: su firma colocada o algun campo
      // relleno; la ronda por turnos exige tenerlo todo firmado.
      // `options.signature` es la huella del documento sobre el que se
      // reservaron los huecos; que siga siendo la del archivo cargado lo
      // vuelve a comprobar `process()` antes de escribir nada.
      canRun={(files, session) => {
        // Varios documentos: la entrega conjunta exige que TODOS esten listos.
        if (files.length > 1) {
          return (
            BATCH_DELIVERY_READY &&
            deliveryBlockers(session, docIdsOf(files)).length === 0
          );
        }
        const { view: options } = activeViewOf(session, files);
        return options.mode === "single"
          ? soloReady(options)
          : multiReady(options, options.signature);
      }}
      renderMain={({ files, options: session, setOptions: setShellOptions }) => (
        <DocumentSessionHost
          files={files}
          session={session}
          setShellOptions={setShellOptions}
          bridge={bridge}
          strings={strings}
          holdMessage={
            null
          }
        >
          {({
            docId,
            file,
            view: options,
            setView: setOptions,
            nav,
            keys: docKeys,
            session: hostSession,
            withSequence,
          }) => (
        <>
          <section>
            <SegmentedControl<SignMode>
              label={strings.modeLabel}
              value={options.mode}
              onChange={(mode) => setOptions({ mode })}
              options={[
                { value: "single", label: strings.modeSingle },
                { value: "multi", label: strings.modeMulti },
              ]}
            />
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {options.mode === "single"
                ? strings.modeSingleHint
                : strings.modeMultiHint}
            </p>
          </section>

          {nav}

          <SessionDraftAutosave
            files={files}
            session={hostSession}
            identityRef={sessionIdentityRef}
            onTooBig={setSessionTooBig}
          />

          {withSequence(options.mode === "single" ? (
            <SoloSignatureSurface
              flowKey={docId}
              file={file}
              options={options}
              setOptions={setOptions}
              strings={strings}
              editStrings={EDIT_STRINGS[language].inline}
              vaultEnabled={vaultEnabled}
              hasSaved={
                vaultEnabled &&
                vault.status === "ready" &&
                vault.entries.some((entry) => entry.signature !== null)
              }
              composerOpen={composerOpen}
              onComposerOpenChange={setComposerOpen}
              vaultOpen={vaultOpen}
              onVaultOpenChange={setVaultOpen}
              vaultNotice={vaultNotice}
              onVaultNoticeChange={setVaultNotice}
            />
          ) : (
            <MultiFlow
              key={docId}
              file={file}
              options={options}
              setOptions={setOptions}
              // Varios documentos: sin pregunta de prefijo (el nombre es automatico).
              onFinish={() =>
                files.length > 1 ? runRef.current?.() : requestFinish(options.signers)
              }
              strings={strings}
              editStrings={EDIT_STRINGS[language].inline}
              multi={
                files.length > 1
                  ? { files, session: hostSession, keys: docKeys, bridge }
                  : undefined
              }
            />
          ))}
        </>
          )}
        </DocumentSessionHost>
      )}
      renderOptions={({ files, options: session }) => {
        // El panel no esta atado a un flujo: trabaja con el documento activo.
        const active = activeViewOf(session, files);
        const options = active.view;
        const activeFile = active.file;
        return options.mode === "single" ? (
          <section className="space-y-4">
            <Button
              variant={options.signaturePng ? "secondary" : "primary"}
              size="md"
              fullWidth
              onClick={() => setComposerOpen(true)}
            >
              <PenLine aria-hidden="true" className="size-4" />
              {options.signaturePng
                ? strings.changeSignature
                : strings.createSignature}
            </Button>

            {vaultEnabled ? (
              <Button
                variant="secondary"
                size="md"
                fullWidth
                onClick={() => {
                  setVaultNotice(null);
                  setVaultOpen(true);
                }}
              >
                <Bookmark aria-hidden="true" className="size-4" />
                {strings.vaultButton}
              </Button>
            ) : null}

            {options.signaturePng ? (
              <div className="rounded-ios-sm flex items-center justify-center border border-white/10 bg-white p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={options.signaturePng}
                  alt={strings.createTitle}
                  className="max-h-24 w-auto max-w-full object-contain"
                />
              </div>
            ) : (
              <p role="alert" className="text-xs text-destructive">
                {strings.noSignature}
              </p>
            )}

            {files.length > 1 ? (
              <BatchStatus files={files} session={session} strings={strings} />
            ) : null}

            <p className="text-xs leading-relaxed text-muted-foreground">
              {strings.legalNote}
            </p>
          </section>
        ) : (
          <section className="space-y-3">
            <span className="ui-label block text-muted-foreground">
              {strings.modeMulti}
            </span>
            {files.length > 1 ? (
              <BatchStatus files={files} session={session} strings={strings} />
            ) : (
              <>
                <p className="text-sm text-foreground tabular-nums">
                  {strings.totalFields(options.fields.length)}
                </p>
                {options.fields.length === 0 &&
                !hasFilledTextValue(options.textFields, options.textValues) &&
                !hasTextEdits(options.textEdits) ? (
                  <p className="text-xs leading-relaxed text-destructive">
                    {strings.noFieldsError}
                  </p>
                ) : multiReady(options, options.signature) ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {strings.allSignedBody}
                  </p>
                ) : (
                  <p className="text-xs leading-relaxed text-destructive">
                    {strings.notAllSignedError}{" "}
                    {strings.pendingBody(
                      pendingSigners(
                        options.signers,
                        options.fields,
                        options.captures,
                        stampKeyOf(options.signature, options.textEdits),
                      ).length,
                    )}
                  </p>
                )}
              </>
            )}
            {activeFile ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  fullWidth
                  onClick={() => void handleExportConfig(files, session)}
                >
                  {strings.exportConfigButton}
                </Button>
                <p className="text-footnote leading-relaxed text-muted-foreground">
                  {strings.exportConfigNote}
                </p>
                {/* Las ediciones del texto original no viajan en la configuracion (van en el borrador). */}
                <ExportEditsNotice
                  hasEdits={docIdsOf(files).some((id) => hasTextEdits(docStateOf(session.docs, id).textEdits))}
                  strings={strings}
                />
              </>
            ) : null}

            {reusableTemplatesEnabled ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  fullWidth
                  onClick={() => {
                    setTemplateFeedback(null);
                    setTemplatesOpen(true);
                  }}
                >
                  {strings.templatesButton}
                </Button>
                {activeFile &&
                (options.signers.length > 0 ||
                  options.fields.length > 0 ||
                  options.textFields.length > 0) ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    fullWidth
                    onClick={() => {
                      setTemplateName("");
                      setTemplateFeedback(null);
                      setSaveTemplateOpen(true);
                    }}
                  >
                    {strings.saveAsTemplateButton}
                  </Button>
                ) : null}

                <TemplatesSheet
                  open={templatesOpen}
                  onClose={() => setTemplatesOpen(false)}
                  onApply={(template) => {
                    const hasExisting =
                      options.signers.length > 0 ||
                      options.fields.length > 0 ||
                      options.textFields.length > 0;
                    if (!activeFile) return;
                    if (hasExisting) {
                      setPendingApplyTemplate(template);
                    } else {
                      void performApplyTemplate(template, activeFile, (patch) =>
                        bridge.setView(active.docId, patch),
                      );
                    }
                  }}
                  onApplyAll={
                    files.length > 1
                      ? (template) => {
                          const hasExisting =
                            session.signers.length > 0 ||
                            files.some((item) => {
                              const state = docStateOf(session.docs, docIdOf(item));
                              return (
                                liveFields(state, session.signers).length > 0 ||
                                state.textFields.length > 0
                              );
                            });
                          if (hasExisting) setPendingApplyAll(template);
                          else void performApplyTemplateToAll(template, files);
                        }
                      : undefined
                  }
                  strings={strings}
                />

                <ConfirmSheet
                  open={pendingApplyAll !== null}
                  onClose={() => setPendingApplyAll(null)}
                  onConfirm={() => {
                    if (pendingApplyAll) {
                      void performApplyTemplateToAll(pendingApplyAll, files);
                    }
                  }}
                  title={strings.applyTemplateConfirmTitle}
                  body={strings.applyTemplateAllConfirmBody}
                  confirmLabel={strings.templatesApplyAll}
                  cancelLabel={strings.confirmCancel}
                  closeLabel={strings.confirmClose}
                />

                {templateFeedback && !saveTemplateOpen ? (
                  <p role="status" className="text-footnote leading-relaxed text-muted-foreground">
                    {templateFeedback}
                  </p>
                ) : null}

                <ConfirmSheet
                  open={pendingApplyTemplate !== null}
                  onClose={() => setPendingApplyTemplate(null)}
                  onConfirm={() => {
                    if (pendingApplyTemplate && activeFile) {
                      void performApplyTemplate(
                        pendingApplyTemplate,
                        activeFile,
                        (patch) => bridge.setView(active.docId, patch),
                      );
                    }
                  }}
                  title={strings.applyTemplateConfirmTitle}
                  body={strings.applyTemplateConfirmBody}
                  confirmLabel={strings.applyTemplateConfirm}
                  cancelLabel={strings.confirmCancel}
                  closeLabel={strings.confirmClose}
                />

                <Sheet
                  open={saveTemplateOpen}
                  onClose={() => setSaveTemplateOpen(false)}
                  title={strings.saveTemplateTitle}
                  closeLabel={t.common.close}
                >
                  <p className="pb-2 text-sm leading-relaxed text-muted-foreground">
                    {strings.saveTemplateBody}
                  </p>
                  <label
                    htmlFor="sign-pdf-template-name"
                    className="block pb-1 text-xs font-medium text-foreground"
                  >
                    {strings.saveTemplateNameLabel}
                  </label>
                  <input
                    id="sign-pdf-template-name"
                    type="text"
                    value={templateName}
                    maxLength={TEMPLATE_NAME_MAX}
                    placeholder={strings.saveTemplateNamePlaceholder}
                    onChange={(event) => setTemplateName(event.target.value)}
                    className="mb-3 h-10 w-full rounded-ios-sm border border-white/14 bg-white/5 px-3 text-sm text-foreground transition-colors placeholder:text-muted-foreground/60 focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal"
                  />
                  {templateFeedback ? (
                    <p role="status" className="pb-2 text-xs text-muted-foreground">
                      {templateFeedback}
                    </p>
                  ) : null}
                  <Button
                    size="md"
                    fullWidth
                    disabled={templateName.trim().length === 0}
                    onClick={() => {
                      if (!activeFile) return;
                      void handleSaveTemplate(activeFile, options, templateName);
                    }}
                  >
                    {strings.saveTemplateConfirm}
                  </Button>
                </Sheet>
              </>
            ) : null}

            <p className="text-xs leading-relaxed text-muted-foreground">
              {strings.legalNote}
            </p>
          </section>
        );
      }}
    />
    </FileAdmissionContext.Provider>
    <Sheet
      open={prefixPromptOpen}
      onClose={() => setPrefixPromptOpen(false)}
      title={strings.filenamePrefixTitle}
      closeLabel={t.common.close}
    >
      <p className="pb-2 text-sm leading-relaxed text-muted-foreground">
        {strings.filenamePrefixBody}
      </p>
      <div className="flex flex-col gap-2 pb-2">
        <Button size="md" fullWidth onClick={() => choosePrefix(true)}>
          {strings.filenamePrefixYes}
        </Button>
        <Button
          variant="ghost"
          size="md"
          fullWidth
          onClick={() => choosePrefix(false)}
        >
          {strings.filenamePrefixNo}
        </Button>
      </div>
    </Sheet>
    </Fragment>
  );
}

type BatchStatusProps = {
  files: File[];
  session: SignSession;
  strings: SignStrings;
};

/**
 * Panel de opciones con VARIOS documentos: cuantos son, cuantos huecos hay y
 * que falta para poder descargar (cobertura, bloques por firmar, documentos
 * sin nada que aplicar...). La region viva esta siempre montada.
 */
function BatchStatus({ files, session, strings }: BatchStatusProps) {
  const docIds = docIdsOf(files);
  const blockers = deliveryBlockers(session, docIds);
  const messages = blockerMessages(
    blockers,
    {
      signers: session.signers,
      docs: files.map((item) => ({ id: docIdOf(item), name: item.name })),
    },
    strings,
  );
  const slots = docIds.reduce(
    (sum, id) =>
      sum + liveFields(docStateOf(session.docs, id), session.signers).length,
    0,
  );
  return (
    <div role="status" aria-live="polite" className="space-y-2">
      <p className="text-sm text-foreground tabular-nums">
        {session.mode === "multi"
          ? strings.batchSummary(files.length, slots)
          : strings.batchDocsCount(files.length)}
      </p>
      {messages.length > 0 ? (
        <>
          <p className="text-xs font-semibold text-foreground">
            {strings.deliveryBlockedTitle}
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-destructive-text">
            {messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {strings.batchReadyBody(files.length)}
        </p>
      )}
    </div>
  );
}

type SignAgainPromptProps = {
  onAccept: () => void;
  strings: SignStrings;
};

/**
 * Aparece tras descargar, solo en modo "varios firmantes" (el unico que
 * tiene un roster que valga la pena reutilizar). Un unico boton, sin
 * aceptar/declinar: a diferencia del prompt de prefijo (que decide algo
 * sobre el archivo que se acaba de escribir), aqui no aceptar es
 * simplemente no tocarlo -- la persona ya tiene "Empezar de nuevo" al
 * lado si quiere un documento en blanco.
 */
function SignAgainPrompt({ onAccept, strings }: SignAgainPromptProps) {
  return (
    <div className="surface-card rounded-ios mt-6 flex flex-col items-center gap-3 p-5 text-center">
      <h3 className="text-headline text-foreground">
        {strings.signAgainTitle}
      </h3>
      <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
        {strings.signAgainBody}
      </p>
      <Button size="md" onClick={onAccept}>
        {strings.signAgainAccept}
      </Button>
    </div>
  );
}

/** Lo que `MultiFlow` necesita de la ronda cuando hay MAS de un documento (bloques, huellas de todos, puente de escritura). */
export type MultiDocs = {
  /** Cola de documentos. */
  files: File[];
  /** La sesion canonica ya puesta al dia con los archivos. */
  session: SignSession;
  /** Huella de cada documento (`null` = aun calculandose). */
  keys: Record<DocId, string | null>;
  bridge: SessionBridge;
};

export type MultiFlowProps = {
  file: File | null;
  options: SignToolOptions;
  setOptions: (patch: Partial<SignToolOptions>) => void;
  onFinish: () => void;
  strings: SignStrings;
  /** Copy del editor de texto de Editar PDF; ausente = la herramienta «Editar texto» no existe en el lienzo. */
  editStrings?: EditInlineStrings;
  /** Ultimo archivo visto, compartido entre flujos (ver `useDocumentSession`). */
  seen?: SeenStore<SignToolOptions>;
  /** Varios documentos: control mismas/distintas, bloques por firmante y ceremonia por bloques. Ausente = un documento, la interfaz de siempre. */
  multi?: MultiDocs;
  /**
   * Guarda el borrador v1 de Firmar en IndexedDB mientras se trabaja (por defecto, si). El modo Firmar de
   * PDF Pro lo apaga: ahi el borrador es el del propio documento de PDF Pro y la sesion de firma se descarta
   * al salir (no se guardan dos borradores del mismo trabajo).
   */
  persistDraft?: boolean;
};

export function MultiFlow({
  file,
  options,
  setOptions,
  onFinish,
  strings,
  editStrings,
  seen,
  multi,
  persistDraft = true,
}: MultiFlowProps) {
  const keyboardNavEnabled = useSignPdfFeatureFlag("keyboardNav");
  const fieldsCompleteNoticeEnabled = useSignPdfFeatureFlag(
    "fieldsCompleteNotice",
  );
  const undoDeleteEnabled = useSignPdfFeatureFlag("undoDelete");
  const richFieldTypesEnabled = useSignPdfFeatureFlag("richFieldTypes");
  const pinchZoomEnabled = useSignPdfFeatureFlag("pinchZoom");
  const sequence = useCanvasSequence();

  /**
   * "Deshacer" al borrar un firmante: unico y propio (nunca comparte
   * hueco con el de un campo de texto/hueco de imagen -- `SignerManager`
   * y `DocumentCanvas` nunca estan montados a la vez, asi
   * que no hace falta coordinarlos). Restaura no solo al firmante sino
   * tambien sus huecos y su captura -- borrarlo hoy se los lleva a los
   * tres en silencio, sin ningun aviso.
   */
  const [pendingSignerUndo, setPendingSignerUndo] = useState<{
    signer: Signer;
    index: number;
    fields: SignatureField[];
    capture: CaptureMap[string] | undefined;
    wasActive: boolean;
    documentKey: string;
    /** Varios documentos: los bloques del firmante (alcance, trazos y sellos), para devolverlos tal cual. */
    blocks: SignerBlock[];
  } | null>(null);

  useEffect(() => {
    if (!pendingSignerUndo) return;
    const timer = window.setTimeout(() => setPendingSignerUndo(null), 6000);
    return () => window.clearTimeout(timer);
  }, [pendingSignerUndo]);

  /**
   * Varios documentos: «Deshacer» el paso de «distintas» a «mismas» (que
   * fusiona los bloques y puede descartar trazos). Mismo patron y misma
   * ventana de 6 s que el de borrar un firmante. Solo vale mientras los
   * bloques sean EXACTAMENTE los que dejo el cambio (`after`): si despues se
   * edita algo, deshacer pisaria ese trabajo.
   */
  const [modeUndo, setModeUndo] = useState<{
    before: SignerBlock[];
    beforeMode: BlockSignMode;
    after: SignerBlock[];
    discarded: number;
  } | null>(null);
  useEffect(() => {
    if (!modeUndo) return;
    const timer = window.setTimeout(() => setModeUndo(null), 6000);
    return () => window.clearTimeout(timer);
  }, [modeUndo]);
  /** Anuncio (region viva siempre montada) del ultimo cambio de modo, alcance o bloque. */
  const [announcement, setAnnouncement] = useState("");

  /**
   * Derivado en render, no limpiado con un `setState` dentro de un
   * efecto (eso encadena renders sin necesidad): deja de tener sentido
   * en cuanto cambia el documento, se sale del paso de firmantes, o ya
   * no cabe un firmante mas sin que dos compartan color al deshacer
   * (`signerColorAt` da la vuelta modulo el numero de colores). El
   * estado de abajo puede seguir "vivo" un rato de mas -- no importa,
   * nunca se lee ni se muestra fuera de esta variable derivada.
   */
  const liveSignerUndo =
    pendingSignerUndo &&
    pendingSignerUndo.documentKey === options.signature &&
    options.step === "signers"
      ? pendingSignerUndo
      : null;
  // El deshacer nunca supera MAX_SIGNERS (el limite de producto, no la paleta):
  // si entretanto se dio de alta otro firmante, ya no cabe y se dice con amabilidad.
  const signerUndoFits =
    options.signers.length < MAX_SIGNERS &&
    options.signers.length < SIGNER_COLORS.length;
  const visiblePendingSignerUndo = liveSignerUndo && signerUndoFits ? liveSignerUndo : null;
  const signerUndoUnavailable = liveSignerUndo !== null && !signerUndoFits;

  const restorePendingSignerUndo = () => {
    if (!visiblePendingSignerUndo) return;
    const snap = visiblePendingSignerUndo;
    const next = [...options.signers];
    next.splice(Math.min(snap.index, next.length), 0, snap.signer);
    setOptions({
      signers: recolor(next),
      fields: [...options.fields, ...snap.fields],
      captures: snap.capture
        ? { ...options.captures, [snap.signer.id]: snap.capture }
        : options.captures,
      ...(snap.wasActive ? { activeSignerId: snap.signer.id } : {}),
    });
    if (multi && snap.blocks.length > 0) {
      // Sus bloques vuelven tal cual (alcance, trazos y sellos) en vez del
      // bloque vacio que se crea al volver a la lista.
      multi.bridge.commit((current, currentFiles) => ({
        blocks: ensureBlocks(
          current.signers,
          docIdsOf(currentFiles),
          current.signMode,
          [
            ...current.blocks.filter((block) => block.signerId !== snap.signer.id),
            ...snap.blocks,
          ],
        ),
      }));
    }
    setPendingSignerUndo(null);
  };

  /**
   * La sesion del documento (huella, reinicio al cambiar de archivo,
   * deteccion de campos, valores a reutilizar y el puente con el lienzo) es
   * la misma que usa "Solo yo": ver `useDocumentSession`.
   */
  const session = useDocumentSession({
    file,
    options,
    setOptions,
    clearedState: CLEARED_DOCUMENT_STATE,
    // El "Deshacer" de un firmante borrado describe el documento anterior.
    onDocumentChange: () => setPendingSignerUndo(null),
    seen,
  });
  const {
    documentKey,
    detecting,
    detectionFailed,
    reuseMatches,
    acceptReuse,
    declineReuse,
    canvasSelection,
    onCanvasSelectionChange,
    onTextFieldsChange,
    onTextValueChange,
    textFieldsMissing,
    detectedFieldsCount,
  } = session;
  const textEditConfig = useTextEditConfig(options.textEdits, setOptions, editStrings);

  /**
   * Cachea los bytes leidos del `File` actual: se necesitan en cada
   * autoguardado (por si hace falta escribirlos, la primera vez que se ve
   * este `documentKey`), pero releerlos en cada disparo del debounce
   * seria releer un PDF potencialmente grande una y otra vez sin
   * necesidad -- `signDrafts.ts` ya evita reescribirlos si ya estan.
   */
  const fileBytesCacheRef = useRef<{ file: File; bytes: Promise<Uint8Array> } | null>(
    null,
  );
  const getFileBytes = (target: File): Promise<Uint8Array> => {
    if (fileBytesCacheRef.current?.file !== target) {
      fileBytesCacheRef.current = {
        file: target,
        bytes: target.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
      };
    }
    return fileBytesCacheRef.current.bytes;
  };

  /**
   * Generacion del autoguardado: se incrementa en cada pasada de este
   * efecto. Un volcado tardio (ver mas abajo) que todavia esta leyendo
   * los bytes del PDF puede completarse DESPUES de que una transicion
   * mas nueva ya decidiera otra cosa (por ejemplo un borrado) --
   * resucitando en IndexedDB un estado que el usuario ya dejo atras. Se
   * detecto de verdad asi, escribiendo un test que reproduce borrar el
   * ultimo firmante y desmontar de inmediato (limitacion 4.3 del
   * backlog), no es hipotetico. Cada volcado comprueba, justo antes de
   * escribir de verdad (no al principio: el salto asincrono de por
   * medio es lo que importa), si sigue siendo la generacion vigente; si
   * no, calla -- la generacion que lo reemplazo ya se encarga de dejar
   * el estado correcto.
   */
  const autosaveGenerationRef = useRef(0);
  /** Varios documentos: el borrador lo guarda `SessionDraftAutosave`, no este flujo. */
  const inSession = multi !== undefined;

  /**
   * Documentos para los que este componente ya escribio (o esta a punto
   * de escribir) un borrador real -- para saber si un borrado hace
   * falta. Sin esto, la primerisima vez que se carga un archivo (antes
   * de tocar nada, sin progreso) programaria un `deleteDraft` sobre un
   * `id` que nunca se guardo: inofensivo en si mismo, pero un viaje de
   * ida y vuelta a IndexedDB de mas en el caso, con mucha diferencia,
   * mas comun (abrir el documento y no hacer nada todavia).
   */
  const hasSavedDraftRef = useRef<Set<string>>(new Set());

  /**
   * Autoguardado del borrador con debounce: espera ~800ms de calma tras
   * el ultimo cambio antes de escribir. El `id`/estado que se guarda es
   * el vigente en el momento en que se AGENDA el guardado (capturado en
   * el cierre del efecto), no el que haya cuando el timer dispare: si el
   * documento cambia a medio camino, el guardado tardio del documento
   * anterior no debe escribirse bajo el `id` del nuevo. Si el efecto se
   * limpia antes de que el timer dispare (documento distinto, o el
   * componente se desmonta) se vuelca el guardado pendiente de
   * inmediato en vez de perderlo sin mas.
   *
   * Sin progreso (ni firmante, ni hueco, ni valor de texto) no hay nada
   * que guardar -- pero si YA existia un borrador de esta sesion porque
   * el usuario acaba de borrar el ultimo firmante/hueco/valor que
   * quedaba, hay que reflejarlo borrando ese borrador tambien, con el
   * mismo mecanismo de "volcar al limpiar" que el guardado. Saltarse
   * este caso (como hacia antes un `if (!hasProgress) return;` temprano,
   * sin dejar ningun volcado pendiente) deja el ultimo guardado CON
   * progreso como el estado persistido para siempre: lo borrado
   * "resucita" al reanudar, en vez de reflejar la lista vacia que el
   * usuario ve en pantalla.
   */
  useEffect(() => {
    if (!file || !documentKey) return;
    autosaveGenerationRef.current += 1;
    const myGeneration = autosaveGenerationRef.current;
    // Con VARIOS documentos el borrador es uno por SESION (`SessionDraftAutosave`):
    // este autoguardado de un solo documento no escribe nada y, si ya habia
    // guardado un borrador suyo (la ronda tenia un solo documento y se sumaron
    // mas), lo borra por el mismo mecanismo de "sin progreso".
    // Un PDF que se abrio con contrasena (copia descifrada) NUNCA se guarda como borrador:
    // dejaria su contenido sin el cifrado en el navegador (Wave 6 · U3).
    const hasProgress =
      persistDraft &&
      !inSession &&
      !isDecryptedCopy(file) &&
      (options.signers.length > 0 ||
        options.fields.length > 0 ||
        options.textFields.length > 0 ||
        Object.keys(options.textValues).length > 0 ||
        hasTextEdits(options.textEdits));

    const targetId = documentKey;
    if (!hasProgress && !hasSavedDraftRef.current.has(targetId)) return;

    // Marcado de inmediato (no cuando el guardado/borrado asincrono
    // termina): una transicion posterior, incluso muy rapida, tiene que
    // ver ya la intencion vigente, no la del ultimo guardado que aterrizo.
    if (hasProgress) {
      hasSavedDraftRef.current.add(targetId);
    } else {
      hasSavedDraftRef.current.delete(targetId);
    }

    const snapshot: Omit<SaveDraftParams, "fileBytes"> | null = hasProgress
      ? {
          id: targetId,
          fileName: file.name,
          manifest: {
            mode: options.mode,
            signers: options.signers,
            fields: options.fields,
            textFields: options.textFields,
            textValues: options.textValues,
          },
          step: options.step,
          captures: options.captures,
          textFieldsDetectedFor: options.textFieldsDetectedFor,
          textEdits: options.textEdits,
        }
      : null;
    const targetFile = file;

    let fired = false;
    let stopHide = () => {};
    const flush = () => {
      fired = true;
      stopHide();
      if (snapshot) {
        void getFileBytes(targetFile).then((fileBytes) => {
          if (autosaveGenerationRef.current !== myGeneration) return;
          return saveDraft({ ...snapshot, fileBytes });
        });
      } else {
        void Promise.resolve().then(() => {
          if (autosaveGenerationRef.current !== myGeneration) return;
          return deleteDraft(targetId);
        });
      }
    };
    const timer = setTimeout(flush, 800);
    // Al irse de la pagina (recargar, cerrar, pestana oculta) no se espera al
    // debounce; `flush` respeta la generacion (`autosaveGenerationRef`).
    stopHide = flushOnPageHide(() => {
      if (!fired) flush();
    });
    return () => {
      clearTimeout(timer);
      stopHide();
      if (!fired) flush();
    };
  }, [
    file,
    documentKey,
    inSession,
    persistDraft,
    options.mode,
    options.signers,
    options.fields,
    options.textFields,
    options.textValues,
    options.step,
    options.captures,
    options.textFieldsDetectedFor,
    options.textEdits,
  ]);

  const stepLabels: Record<MultiStep, string> = {
    signers: strings.stepSigners,
    document: strings.stepDocument,
    sign: strings.stepSign,
  };

  /**
   * Un paso solo se abre cuando el anterior ya tiene lo que necesita. El
   * paso "Documento" no depende de los firmantes (un campo de texto no
   * tiene dueño; sin firmantes el lienzo solo ofrece campos de texto),
   * asi que siempre esta abierto; el de firmar se abre con huecos de
   * imagen listos O con algun campo de texto relleno.
   */
  const reachable = (step: MultiStep): boolean => {
    if (step === "signers" || step === "document") return true;
    return anySlots || anyFilledText;
  };

  const position = MULTI_STEPS.indexOf(options.step);
  const nextStep = MULTI_STEPS[position + 1];
  const previousStep = MULTI_STEPS[position - 1];

  /**
   * Aviso NO bloqueante (Recomendacion #2): se muestra en linea en el paso
   * "Documento" (bajo el lienzo) y de nuevo en el panel de descarga del
   * paso "Firmar" cuando no hay huecos, el ultimo momento antes de
   * descargar en que la persona puede verlo.
   */
  const showPendingTextFieldsNotice =
    fieldsCompleteNoticeEnabled &&
    options.step === "document" &&
    textFieldsMissing > 0;

  /* --- Varios documentos --- */
  const docRefs: DocRef[] = multi
    ? multi.files.map((item) => ({ id: docIdOf(item), name: item.name }))
    : [];
  const docIds = docRefs.map((doc) => doc.id);
  const multiDocs = multi ? multi.session.docs : null;
  /** Huecos vivos de cada documento (con un documento: solo el activo, como siempre). */
  const slotsByDoc = (docId: DocId): SignatureField[] =>
    multiDocs ? liveFields(docStateOf(multiDocs, docId), options.signers) : options.fields;
  const multiBlockers: DeliveryBlocker[] = multi ? deliveryBlockers(multi.session, docIds) : [];
  /**
   * Huella de cada documento con la que se sellan los trazos: la del archivo mas la de sus
   * ediciones de texto (`stampKeyOf`). Sin ediciones es la huella del archivo, sin mas.
   */
  const stampKeys: Record<DocId, string | null> = {};
  if (multi) {
    for (const id of docIds) {
      stampKeys[id] = stampKeyOf(multi.keys[id] ?? null, docStateOf(multi.session.docs, id).textEdits) ?? null;
    }
  }
  const blocksNow: SignerBlock[] = multi ? multi.session.blocks : [];
  const issues = multi
    ? coverageIssues(
        options.signers,
        docIds,
        Object.fromEntries(docIds.map((id) => [id, { fields: slotsByDoc(id) }])),
        blocksNow,
      )
    : [];

  const fieldCounts: Record<string, number> = {};
  for (const docFields of multi ? docIds.map(slotsByDoc) : [options.fields]) {
    for (const field of docFields) {
      fieldCounts[field.signerId] = (fieldCounts[field.signerId] ?? 0) + 1;
    }
  }

  const anySlots = multi ? docIds.some((id) => slotsByDoc(id).length > 0) : options.fields.length > 0;
  // Texto relleno o texto original editado: ambos bastan para «rellenar y descargar» sin huecos.
  const anyFilledText = multi
    ? docIds.some((id) => {
        const doc = docStateOf(multi.session.docs, id);
        return hasFilledTextValue(doc.textFields, doc.textValues) || hasTextEdits(doc.textEdits);
      })
    : hasFilledTextValue(options.textFields, options.textValues) ||
      hasTextEdits(options.textEdits);

  /**
   * Al quitar a un firmante desaparecen tambien sus huecos y su trazo:
   * dejarlos sueltos convertiria el documento en algo imposible de
   * completar. `onSignersChange` tambien corre en un renombrado o un
   * alta (mismo callback para las tres cosas en `SignerManager`) -- se
   * detecta que hubo un BORRADO comparando los ids de antes contra los
   * de ahora; en un renombrado/alta esa resta siempre sale vacia.
   */
  const onSignersChange = (signers: Signer[]) => {
    const alive = new Set(signers.map((signer) => signer.id));
    const fields = options.fields.filter((field) => alive.has(field.signerId));
    const captures: CaptureMap = {};
    for (const [id, capture] of Object.entries(options.captures)) {
      if (alive.has(id)) captures[id] = capture;
    }

    if (undoDeleteEnabled) {
      const removedId = options.signers.find((s) => !alive.has(s.id))?.id;
      if (removedId) {
        const index = options.signers.findIndex((s) => s.id === removedId);
        setPendingSignerUndo({
          signer: options.signers[index],
          index,
          fields: options.fields.filter((field) => field.signerId === removedId),
          capture: options.captures[removedId],
          wasActive: options.activeSignerId === removedId,
          documentKey: options.signature,
          blocks: multi ? signerBlocks(multi.session.blocks, removedId) : [],
        });
      }
    }

    setOptions({ signers, fields, captures });
  };

  /* --- Varios documentos: modo global y bloques --- */

  const refsOf = (currentFiles: readonly File[]): DocRef[] =>
    currentFiles.map((item) => ({ id: docIdOf(item), name: item.name }));

  /** «Mismas» <-> «distintas». Distintas -> Mismas puede descartar trazos: se ofrece «Deshacer» 6 s. */
  const changeSignMode = (to: BlockSignMode) => {
    if (!multi) return;
    multi.bridge.commit((current, currentFiles) => {
      if (current.signMode === to) return {};
      const switched = switchMode(
        current.blocks,
        current.signers,
        docIdsOf(currentFiles),
        to,
      );
      setAnnouncement(
        to === "same" ? strings.signModeChangedSame : strings.signModeChangedIndependent,
      );
      setModeUndo(
        switched.discarded.length > 0
          ? {
              before: current.blocks,
              beforeMode: current.signMode,
              after: switched.blocks,
              discarded: switched.discarded.length,
            }
          : null,
      );
      return { signMode: to, blocks: switched.blocks };
    });
  };

  const visibleModeUndo =
    modeUndo &&
    multi &&
    multi.session.blocks === modeUndo.after &&
    multi.session.signMode === "same" &&
    options.step === "signers"
      ? modeUndo
      : null;

  const modeControlRef = useRef<HTMLElement>(null);
  const restoreSignMode = () => {
    if (!visibleModeUndo || !multi) return;
    const snap = visibleModeUndo;
    multi.bridge.commit((current) =>
      current.blocks === snap.after
        ? { signMode: snap.beforeMode, blocks: snap.before }
        : {},
    );
    setModeUndo(null);
    setAnnouncement(strings.signModeRestored);
    // El boton «Deshacer» se desmonta: el foco vuelve al segmento del modo recuperado.
    modeControlRef.current
      ?.querySelectorAll<HTMLElement>('[role="tab"]')
      [snap.beforeMode === "same" ? 0 : 1]?.focus({ preventScroll: true });
  };

  /**
   * Foco tras «Anadir bloque para X» (cobertura): el boton pulsado se
   * desmonta al resolverse el aviso, asi que el foco va al «Cambiar» del
   * bloque recien creado en cuanto aparece.
   */
  const focusNewBlockRef = useRef<string | null>(null);
  useEffect(() => {
    const id = focusNewBlockRef.current;
    if (!id) return;
    const target = document.querySelector<HTMLElement>(`[data-block-scope="${id}"]`);
    if (!target) return;
    focusNewBlockRef.current = null;
    target.focus({ preventScroll: true });
  }, [multi?.session.blocks]);

  /** Anade un bloque al firmante; con `docId`, el bloque que cubre ESE documento (cobertura). */
  const addBlockTo = (signerId: string, docId?: DocId) => {
    if (!multi) return;
    multi.bridge.commit((current, currentFiles) => {
      const added = addBlock(current.blocks, signerId, docIdsOf(currentFiles), docId);
      if (added.addedBlockId === null) return {};
      const moves = scopeMoveAnnouncement(
        added,
        current.blocks,
        added.blocks,
        refsOf(currentFiles),
        strings,
      );
      setAnnouncement(
        [
          strings.blockAdded(
            signerLabel(current.signers, signerId, strings),
            blockNumber(added.blocks, added.addedBlockId),
          ),
          moves,
        ]
          .filter(Boolean)
          .join(" "),
      );
      focusNewBlockRef.current = added.addedBlockId;
      return { blocks: added.blocks };
    });
  };

  const blocksApi: SignerBlocksApi | undefined = multi
    ? {
        docs: docRefs,
        blocks: blocksNow,
        onChangeScope: (blockId, scope) => {
          multi.bridge.commit((current, currentFiles) => {
            const edit = changeBlockScope(
              current.blocks,
              blockId,
              scope,
              refsOf(currentFiles),
              strings,
            );
            if (edit.blocks === current.blocks) return {};
            setAnnouncement(edit.message);
            return { blocks: edit.blocks };
          });
        },
        issues,
        onAddBlock: (signerId, docId) => addBlockTo(signerId, docId),
        onRemoveBlock: (blockId) => {
          multi.bridge.commit((current, currentFiles) => {
            const removed = removeBlock(current.blocks, blockId, docIdsOf(currentFiles));
            if (removed.receiverId === null) return {};
            setAnnouncement(strings.blockRemoved(blockNumber(removed.blocks, removed.receiverId)));
            return { blocks: removed.blocks };
          });
        },
      }
    : undefined;

  /**
   * Al cambiar de paso con los botones «Atrás» / «Continuar», el que se acaba
   * de pulsar puede desaparecer (no hay «Atrás» en el primer paso ni «Continuar»
   * en el ultimo) y el foco caeria a `<body>`. Solo en ese caso se lleva al
   * paso actual de la barra; si el foco sigue en un boton vivo, no se toca.
   * No actua al montar.
   */
  const stepNavRef = useRef<HTMLElement>(null);
  const lastStepRef = useRef(options.step);
  useEffect(() => {
    if (lastStepRef.current === options.step) return;
    lastStepRef.current = options.step;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    stepNavRef.current
      ?.querySelector<HTMLElement>('[aria-current="step"]')
      ?.focus({ preventScroll: true });
  }, [options.step]);

  return (
    <div className="space-y-5">
      {/* Region viva siempre montada (varios documentos): modo, alcance y bloques. */}
      {multi ? (
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>
      ) : null}
      <nav
        ref={stepNavRef}
        aria-label={strings.ceremonyTitle}
        className="flex flex-wrap gap-1.5"
      >
        {MULTI_STEPS.map((step, index) => {
          const active = step === options.step;
          const open = reachable(step);
          return (
            <button
              key={step}
              type="button"
              disabled={!open}
              aria-current={active ? "step" : undefined}
              onClick={() => setOptions({ step })}
              className={
                active
                  ? "min-h-11 rounded-ios-sm border border-signal/60 bg-signal/15 px-3 text-footnote font-semibold text-foreground"
                  : "min-h-11 rounded-ios-sm border border-white/10 bg-white/5 px-3 text-footnote font-semibold text-muted-foreground transition-colors enabled:hover:border-white/25 enabled:hover:text-foreground disabled:opacity-40"
              }
            >
              {index + 1}. {stepLabels[step]}
            </button>
          );
        })}
      </nav>

      <PrivacyNotice strings={strings} />

      {options.step === "signers" ? (
        <>
          {multi ? (
            <SignModeControl
              containerRef={modeControlRef}
              value={multi.session.signMode}
              onChange={changeSignMode}
              strings={strings}
            />
          ) : null}
          <SignerManager
            signers={options.signers}
            onSignersChange={onSignersChange}
            activeSignerId={options.activeSignerId}
            onActiveSignerIdChange={(activeSignerId) =>
              setOptions({ activeSignerId })
            }
            fieldCounts={fieldCounts}
            strings={strings}
            blocks={blocksApi}
          />
          {multi ? (
            <CoverageNotices
              issues={issues}
              signers={options.signers}
              docs={docRefs}
              onAddBlock={addBlockTo}
              strings={strings}
            />
          ) : null}
          {visibleModeUndo ? (
            <div
              role="status"
              aria-live="polite"
              className="mt-3 flex items-center justify-between gap-3 rounded-ios-sm border border-white/14 bg-elevated px-3.5 py-2.5"
            >
              <span className="text-xs text-muted-foreground">
                {strings.signModeMergedNotice(visibleModeUndo.discarded)}
              </span>
              <Button variant="ghost" size="sm" onClick={restoreSignMode}>
                {strings.undoSignMode}
              </Button>
            </div>
          ) : null}
          {signerUndoUnavailable ? (
            <p
              role="status"
              aria-live="polite"
              className="mt-3 text-xs text-muted-foreground"
            >
              {strings.undoRemoveSignerUnavailable}
            </p>
          ) : null}
          {visiblePendingSignerUndo ? (
            <div
              role="status"
              aria-live="polite"
              className="mt-3 flex items-center justify-between gap-3 rounded-ios-sm border border-white/14 bg-elevated px-3.5 py-2.5"
            >
              <span className="text-xs text-muted-foreground">
                {strings.signerDeletedNotice}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={restorePendingSignerUndo}
              >
                {strings.undoRemoveSigner}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {options.step === "document" ? (
        <section className="flex flex-col gap-4">
          <DetectionStatus
            detecting={detecting}
            failed={detectionFailed}
            detectedCount={detectedFieldsCount}
            strings={strings}
          />

          {reuseMatches ? (
            <ReuseValuesPrompt
              matches={reuseMatches}
              textFields={options.textFields}
              onAccept={acceptReuse}
              onDecline={declineReuse}
              strings={strings}
            />
          ) : null}

          <DocumentCanvas
            file={file}
            signers={options.signers}
            activeSignerId={options.activeSignerId}
            onActiveSignerIdChange={(activeSignerId) =>
              setOptions({ activeSignerId })
            }
            tool={options.placementTool}
            onToolChange={(placementTool) => setOptions({ placementTool })}
            slots={options.fields}
            onSlotsChange={(fields) => setOptions({ fields })}
            textFields={options.textFields}
            onTextFieldsChange={onTextFieldsChange}
            values={options.textValues}
            onValueChange={onTextValueChange}
            pageIndex={options.fieldPageIndex}
            onPageIndexChange={(fieldPageIndex) => setOptions({ fieldPageIndex })}
            selection={canvasSelection}
            onSelectionChange={onCanvasSelectionChange}
            editingId={options.editingTextFieldId}
            onEditingIdChange={(editingTextFieldId) =>
              setOptions({ editingTextFieldId })
            }
            strings={strings}
            keyboardNavEnabled={keyboardNavEnabled}
            undoDeleteEnabled={undoDeleteEnabled}
            richFieldTypesEnabled={richFieldTypesEnabled}
            pinchZoomEnabled={pinchZoomEnabled}
            sequence={sequence}
            textEdit={textEditConfig}
          />

          <PendingFieldsNotice
            missing={showPendingTextFieldsNotice ? textFieldsMissing : 0}
            strings={strings}
          />
        </section>
      ) : null}

      {options.step === "sign" && anySlots ? (
        multi ? (
          <BlockCeremony
            signers={options.signers}
            docs={docRefs}
            docStates={multi.session.docs}
            keys={stampKeys}
            blocks={blocksNow}
            onBlocksChange={(blocks) => multi.bridge.commit(() => ({ blocks }))}
            blockerMessages={blockerMessages(
              // Los pendientes y la cobertura ya tienen su propio sitio en la ceremonia.
              multiBlockers.filter(
                (blocker) => blocker.kind !== "pending" && blocker.kind !== "coverage",
              ),
              { signers: options.signers, docs: docRefs },
              strings,
            )}
            blocked={multiBlockers.length > 0}
            onFinish={onFinish}
            strings={strings}
          />
        ) : (
          <SigningCeremony
            signers={options.signers}
            fields={options.fields}
            captures={options.captures}
            onCapturesChange={(captures) => setOptions({ captures })}
            documentKey={stampKeyOf(documentKey, options.textEdits)}
            documentName={file?.name}
            onFinish={onFinish}
            strings={strings}
          />
        )
      ) : null}

      {/*
       * Sin huecos de imagen no hay ronda que mostrar: `SigningCeremony`
       * (su cola de firmantes viene de `fields`, vacio aqui) se queda
       * con el boton deshabilitado para siempre, aunque el documento ya
       * este listo (rellenar-y-descargar). Se muestra en su lugar un
       * panel minimo con el mismo `onFinish`.
       */}
      {options.step === "sign" && !anySlots ? (
        <div className="surface-card rounded-ios p-5">
          <h4 className="text-headline text-foreground">
            {strings.textOnlyReadyTitle}
          </h4>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {strings.textOnlyReadyBody}
          </p>
          {fieldsCompleteNoticeEnabled && textFieldsMissing > 0 ? (
            <p
              role="status"
              className="mt-2 flex items-start gap-2 text-footnote leading-relaxed text-foreground"
            >
              <span
                aria-hidden="true"
                className="mt-[0.45em] size-2 shrink-0 rounded-full bg-amber-400"
              />
              {strings.pendingTextFieldsWarning(textFieldsMissing)}
            </p>
          ) : null}
          <div className="mt-4">
            <Button
              size="lg"
              disabled={
                multi
                  ? multiBlockers.length > 0
                  : !hasFilledTextValue(options.textFields, options.textValues)
              }
              onClick={onFinish}
            >
              {strings.finishAndDownload}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {previousStep ? (
          <Button
            variant="secondary"
            size="md"
            onClick={() => setOptions({ step: previousStep })}
          >
            {strings.back}
          </Button>
        ) : null}
        {nextStep ? (
          <Button
            size="md"
            disabled={!reachable(nextStep)}
            onClick={() => setOptions({ step: nextStep })}
          >
            {strings.next}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export type SoloSignatureSurfaceProps = {
  /** Clave del documento: el flujo se remonta al cambiar de documento (el compositor y el baul no). */
  flowKey: string;
  file: File | null;
  options: SignToolOptions;
  setOptions: (patch: Partial<SignToolOptions>) => void;
  strings: SignStrings;
  editStrings?: EditInlineStrings;
  seen?: SeenStore<SignToolOptions>;
  /** Baul de firmas encendido (ajuste `signatureVault`). */
  vaultEnabled: boolean;
  /** Hay alguna firma guardada que ofrecer. */
  hasSaved: boolean;
  composerOpen: boolean;
  onComposerOpenChange: (open: boolean) => void;
  vaultOpen: boolean;
  onVaultOpenChange: (open: boolean) => void;
  vaultNotice: VaultNotice | null;
  onVaultNoticeChange: (notice: VaultNotice | null) => void;
};

/**
 * «Solo yo» con todo lo que cuelga de la firma propia: el flujo sobre el lienzo, el compositor de la
 * firma y la hoja del baul, con sus avisos. El estado (hojas abiertas, aviso del baul) lo pone quien
 * lo monta: la herramienta suelta (`SignToolClient`) y el modo Firmar de PDF Pro (`SignEmbedded`)
 * comparten ESTE mismo cuerpo, sin copiarlo.
 */
export function SoloSignatureSurface({
  flowKey,
  file,
  options,
  setOptions,
  strings,
  editStrings,
  seen,
  vaultEnabled,
  hasSaved,
  composerOpen,
  onComposerOpenChange,
  vaultOpen,
  onVaultOpenChange,
  vaultNotice,
  onVaultNoticeChange,
}: SoloSignatureSurfaceProps) {
  return (
    <>
      <VaultNoticeLine notice={vaultNotice} />
      <SoloFlow
        key={flowKey}
        file={file}
        options={options}
        setOptions={setOptions}
        onCreateSignature={() => onComposerOpenChange(true)}
        onOpenSaved={
          vaultEnabled
            ? () => {
                onVaultNoticeChange(null);
                onVaultOpenChange(true);
              }
            : undefined
        }
        hasSaved={hasSaved}
        strings={strings}
        editStrings={editStrings}
        seen={seen}
      />
      <SignatureComposer
        open={composerOpen}
        onClose={() => onComposerOpenChange(false)}
        strings={strings}
        // La firma nueva se coloca sola en el lienzo (o, si ya habia una
        // colocada, se ajusta a su proporcion): ver `DocumentCanvas`.
        onSave={(draft: SignatureDraft) =>
          setOptions({ signaturePng: draft.dataUrl, ratio: draft.ratio })
        }
        onRemember={
          vaultEnabled
            ? (draft, who) => {
                void rememberDrafts(strings, {
                  signerName: who.signerName,
                  sourceDocument: file?.name ?? "",
                  signature: draft,
                  initials: null,
                }).then(onVaultNoticeChange);
              }
            : undefined
        }
      />
      {vaultEnabled ? (
        <SignatureVaultSheet
          open={vaultOpen}
          onClose={() => onVaultOpenChange(false)}
          strings={strings}
          need="signature"
          onCreateNew={() => {
            onVaultOpenChange(false);
            onComposerOpenChange(true);
          }}
          // Misma ruta que `onSave` del compositor: la firma elegida se
          // coloca sola en el lienzo (autocolocado de `DocumentCanvas`).
          onUse={(entry) => {
            if (!entry.signature) return;
            setOptions({
              signaturePng: vaultImageToDataUrl(entry.signature),
              ratio: entry.signature.ratio,
            });
            void touchVaultEntry(entry.id);
            onVaultOpenChange(false);
            onVaultNoticeChange({
              text: strings.vaultApplied(entry.signerName),
              tone: "success",
            });
          }}
        />
      ) : null}
    </>
  );
}

export type SoloFlowProps = {
  file: File | null;
  options: SignToolOptions;
  setOptions: (patch: Partial<SignToolOptions>) => void;
  /** Abre el compositor de la firma. */
  onCreateSignature: () => void;
  /** Abre las firmas guardadas (W3); ausente = baul apagado. */
  onOpenSaved?: () => void;
  /** Hay alguna firma guardada que ofrecer. */
  hasSaved?: boolean;
  strings: SignStrings;
  /** Copy del editor de texto de Editar PDF; ausente = la herramienta «Editar texto» no existe en el lienzo. */
  editStrings?: EditInlineStrings;
  /** Ultimo archivo visto, compartido entre flujos (ver `useDocumentSession`). */
  seen?: SeenStore<SignToolOptions>;
};

/**
 * Modo "Solo yo" sobre el MISMO lienzo que el paso "Documento" (W2-C): la
 * firma propia es un elemento mas (se coloca con la herramienta Firma, se
 * mueve, se redimensiona, se quita con "Deshacer") y, ademas, se rellenan en
 * linea los campos del documento (detectados o añadidos a mano) con la
 * paleta, la barra flotante, el teclado y el toque. No hay formulario ni
 * lista de campos aparte. El flujo rapido sigue siendo: crear la firma -> ya
 * esta colocada -> descargar.
 *
 * Sin firmantes, sin huecos por turnos, sin certificado ni autoguardado de
 * borrador (como antes): el estado vive en las opciones de la herramienta.
 */
export function SoloFlow({
  file,
  options,
  setOptions,
  onCreateSignature,
  onOpenSaved,
  hasSaved,
  strings,
  editStrings,
  seen,
}: SoloFlowProps) {
  const keyboardNavEnabled = useSignPdfFeatureFlag("keyboardNav");
  const fieldsCompleteNoticeEnabled = useSignPdfFeatureFlag(
    "fieldsCompleteNotice",
  );
  const undoDeleteEnabled = useSignPdfFeatureFlag("undoDelete");
  const richFieldTypesEnabled = useSignPdfFeatureFlag("richFieldTypes");
  const pinchZoomEnabled = useSignPdfFeatureFlag("pinchZoom");
  const sequence = useCanvasSequence();

  const {
    detecting,
    detectionFailed,
    reuseMatches,
    acceptReuse,
    declineReuse,
    canvasSelection,
    onCanvasSelectionChange,
    onTextFieldsChange,
    onTextValueChange,
    textFieldsMissing,
    detectedFieldsCount,
  } = useDocumentSession({
    file,
    options,
    setOptions,
    clearedState: CLEARED_DOCUMENT_STATE,
    seen,
  });
  const textEditConfig = useTextEditConfig(options.textEdits, setOptions, editStrings);

  return (
    <section className="flex flex-col gap-4">
      <DetectionStatus
        detecting={detecting}
        failed={detectionFailed}
        detectedCount={detectedFieldsCount}
        strings={strings}
      />

      {reuseMatches ? (
        <ReuseValuesPrompt
          matches={reuseMatches}
          textFields={options.textFields}
          onAccept={acceptReuse}
          onDecline={declineReuse}
          strings={strings}
        />
      ) : null}

      <DocumentCanvas
        file={file}
        solo={{
          signaturePng: options.signaturePng,
          ratio: options.ratio,
          onCreateSignature,
          onOpenSaved,
          hasSaved,
        }}
        signers={[]}
        activeSignerId={null}
        onActiveSignerIdChange={() => {}}
        tool={options.placementTool}
        onToolChange={(placementTool) => setOptions({ placementTool })}
        slots={soloSlotsFrom(options)}
        onSlotsChange={(slots) => setOptions(soloPlacementFromSlots(slots))}
        textFields={options.textFields}
        onTextFieldsChange={onTextFieldsChange}
        values={options.textValues}
        onValueChange={onTextValueChange}
        pageIndex={options.fieldPageIndex}
        onPageIndexChange={(fieldPageIndex) => setOptions({ fieldPageIndex })}
        selection={canvasSelection}
        onSelectionChange={onCanvasSelectionChange}
        editingId={options.editingTextFieldId}
        onEditingIdChange={(editingTextFieldId) =>
          setOptions({ editingTextFieldId })
        }
        strings={strings}
        keyboardNavEnabled={keyboardNavEnabled}
        undoDeleteEnabled={undoDeleteEnabled}
        richFieldTypesEnabled={richFieldTypesEnabled}
        pinchZoomEnabled={pinchZoomEnabled}
        sequence={sequence}
        textEdit={textEditConfig}
      />

      <PendingFieldsNotice
        missing={fieldsCompleteNoticeEnabled ? textFieldsMissing : 0}
        strings={strings}
      />
    </section>
  );
}
