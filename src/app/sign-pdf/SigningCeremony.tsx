"use client";

import { useState } from "react";
import { ArrowRight, Check, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";
import {
  SignatureComposer,
  type SignatureDraft,
} from "@/app/sign-pdf/SignatureComposer";
import { SignatureVaultSheet } from "@/app/sign-pdf/SignatureVaultSheet";
import { VaultNoticeLine } from "@/app/sign-pdf/VaultNoticeLine";
import { useSignPdfFeatureFlag } from "@/app/sign-pdf/signFeatureFlags";
import { useCeremonyFocus } from "@/app/sign-pdf/useCeremonyFocus";
import {
  touchVaultEntry,
  vaultImageToDataUrl,
  type VaultEntry,
} from "@/app/sign-pdf/signVault";
import { rememberDrafts, type VaultNotice } from "@/app/sign-pdf/vaultMessages";
import type { SignStrings } from "@/app/sign-pdf/strings";
import {
  signerDisplayName,
  type SignatureField,
  type SignatureFieldType,
  type Signer,
} from "@/lib/pdf/sign";

import {
  EMPTY_CAPTURE,
  captureStamp,
  isSignerComplete,
  pendingSigners,
  requiredCaptureTypes,
  signingQueue,
  validCapture,
  type CaptureMap,
  type SignerCapture,
} from "@/app/sign-pdf/captures";

// Las capturas viven en `captures.ts` (puras, sin React); se re-exportan con
// las mismas firmas para no romper a quien las importa de aqui.
export {
  EMPTY_CAPTURE,
  captureStamp,
  isSignerComplete,
  pendingSigners,
  requiredCaptureTypes,
  signingQueue,
  validCapture,
};
export type { CaptureMap, SignerCapture };

type Stage = "handoff" | "capture" | "review";

/**
 * Encabezado de etapa que recibe el foco al cambiar de etapa o de turno
 * (`useCeremonyFocus`): enfocable por codigo, fuera del orden de tabulacion.
 * El anillo lo pone el `:focus-visible` global; sin `outline-none` (en
 * Tailwind v4 dejaria invisible el anillo).
 */
export const CEREMONY_HEADING_CLASS =
  "rounded-ios-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-signal";

export type SigningCeremonyProps = {
  signers: Signer[];
  fields: SignatureField[];
  captures: CaptureMap;
  onCapturesChange: (captures: CaptureMap) => void;
  /**
   * Identidad del archivo cargado; entra en la huella de cada captura.
   * `null` mientras se calcula: hasta tenerla no se firma nada.
   */
  documentKey: string | null;
  /** Nombre del archivo; solo se usa para anotar en que documento se recordo una firma. */
  documentName?: string;
  onFinish: () => void;
  strings: SignStrings;
  busy?: boolean;
};

/**
 * Ronda de firma en un solo dispositivo: cada persona recibe el aparato,
 * crea su trazo, comprueba como queda y se lo pasa a la siguiente. No hay
 * envio remoto ni servidor; todo ocurre en esta pestaña.
 */
export function SigningCeremony({
  signers,
  fields,
  captures,
  onCapturesChange,
  documentKey,
  documentName,
  onFinish,
  strings,
  busy = false,
}: SigningCeremonyProps) {
  const [turn, setTurn] = useState(0);
  const [stage, setStage] = useState<Stage>("handoff");
  const [composer, setComposer] = useState<SignatureFieldType | null>(null);
  const vaultEnabled = useSignPdfFeatureFlag("signatureVault");
  /**
   * Hoja de firmas guardadas: abierta PARA un firmante, un tipo y un
   * documento concretos. Si cualquiera de los tres cambia con ella abierta,
   * deja de estar abierta (derivado en render, sin efecto).
   */
  const [vaultFor, setVaultFor] = useState<{
    type: SignatureFieldType;
    signerId: string;
    documentKey: string;
  } | null>(null);
  const [vaultShown, setVaultShown] = useState(false);
  const queue = signingQueue(signers, fields);
  const position = Math.min(turn, queue.length);
  /** Etapa y turno cambian al pulsar un boton que se desmonta: el foco va al encabezado nuevo. */
  const headingRef = useCeremonyFocus(stage, position);
  /**
   * Aviso del baul, atado al firmante y a la etapa en que se dio: al pasar a
   * otro firmante o a otra pantalla (traspaso, revision) deja de mostrarse en
   * vez de quedarse colgado («Aplicada la firma de Ana» en el traspaso a Luis).
   */
  const [vaultNoticeState, setVaultNoticeState] = useState<{
    notice: VaultNotice;
    signerId: string;
    stage: Stage;
  } | null>(null);

  // Sin identidad del documento la ronda no arranca: cualquier trazo que
  // se guardase ahora quedaria atado a un archivo sin comprobar.
  if (!documentKey) {
    return (
      <section className="space-y-4">
        <h3 className="ui-label text-muted-foreground">
          {strings.ceremonyTitle}
        </h3>
        <div className="glass rounded-ios flex items-center gap-3 p-6">
          <Spinner />
          <p className="text-sm text-muted-foreground">
            {strings.checkingDocument}
          </p>
        </div>
      </section>
    );
  }

  const pending = pendingSigners(signers, fields, captures, documentKey);
  const current = queue[position] ?? null;
  const required = current ? requiredCaptureTypes(fields, current.id) : [];
  const capture = current
    ? validCapture(captures, fields, current.id, documentKey)
    : EMPTY_CAPTURE;
  const currentFieldCount = current
    ? fields.filter((field) => field.signerId === current.id).length
    : 0;
  const ready = required.every((type) => capture[type] !== null);

  /** Nombre a mostrar de un firmante, con el mismo fallback numerado que `SignerManager`. */
  const displayNameOf = (signer: Signer): string =>
    signerDisplayName(
      signer.name,
      signers.findIndex((candidate) => candidate.id === signer.id),
      strings.defaultSignerName,
    );
  const currentDisplayName = current ? displayNameOf(current) : "";

  const saveDraft = (type: SignatureFieldType, draft: SignatureDraft) => {
    if (!current) return;
    // `capture` ya viene vacio si los huecos cambiaron: lo que se guarda
    // queda atado al documento y a la disposicion de ahora mismo.
    onCapturesChange({
      ...captures,
      [current.id]: {
        ...capture,
        [type]: draft,
        stamp: captureStamp(documentKey, fields, current.id),
      },
    });
  };

  /**
   * Aplica una firma guardada: misma ruta que `saveDraft` (la captura queda
   * atada al documento y a los huecos de AHORA), pero con las dos imagenes de
   * la entrada a la vez. El sello se calcula aqui, en el clic, con la
   * `documentKey` y los huecos vigentes -- no al abrir la hoja. Lo que la
   * entrada no trae (p. ej. iniciales) NO se inventa: queda como captura
   * parcial y se avisa.
   */
  const applyVaultEntry = (entry: VaultEntry) => {
    if (!current || !documentKey) return;
    const next: SignerCapture = {
      ...capture,
      stamp: captureStamp(documentKey, fields, current.id),
    };
    const missing: SignatureFieldType[] = [];
    for (const type of required) {
      const image = entry[type];
      if (image) {
        next[type] = { dataUrl: vaultImageToDataUrl(image), ratio: image.ratio };
      } else if (!capture[type]) {
        missing.push(type);
      }
    }
    onCapturesChange({ ...captures, [current.id]: next });
    void touchVaultEntry(entry.id);
    setVaultShown(false);
    showVaultNotice(current.id, stage, {
      text:
        missing.length > 0
          ? strings.vaultAppliedPartial(entry.signerName, missing)
          : strings.vaultApplied(entry.signerName),
      // Una captura parcial no es un error: se explica, sin alarma.
      tone: missing.length > 0 ? "info" : "success",
    });
  };

  const showVaultNotice = (
    signerId: string,
    atStage: Stage,
    notice: VaultNotice,
  ) => setVaultNoticeState({ notice, signerId, stage: atStage });
  const vaultNotice =
    vaultNoticeState &&
    current &&
    vaultNoticeState.signerId === current.id &&
    vaultNoticeState.stage === stage
      ? vaultNoticeState.notice
      : null;

  const vaultOpen =
    vaultShown &&
    vaultFor !== null &&
    current !== null &&
    vaultFor.signerId === current.id &&
    vaultFor.documentKey === documentKey;

  const goToTurn = (next: number) => {
    setTurn(next);
    setStage("handoff");
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="ui-label text-muted-foreground">
          {strings.ceremonyTitle}
        </h3>
        {current ? (
          <span className="text-footnote font-medium text-foreground tabular-nums">
            {strings.turnOf(position + 1, queue.length)}
          </span>
        ) : null}
      </div>

      <VaultNoticeLine notice={vaultNotice} />

      {current && stage === "handoff" ? (
        <div className="glass rounded-ios p-6 text-center">
          <span
            className="mx-auto flex size-12 items-center justify-center rounded-full"
            /* Color del firmante: dato del documento, no un token del tema. */
            style={{ backgroundColor: `${current.color}33` }}
          >
            <Smartphone
              aria-hidden="true"
              className="size-6"
              style={{ color: current.color }}
            />
          </span>
          <h4
            ref={headingRef}
            tabIndex={-1}
            className={cn("mt-4 text-title-3 text-foreground", CEREMONY_HEADING_CLASS)}
          >
            {strings.handoffTitle(currentDisplayName)}
          </h4>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            {strings.handoffBody(currentDisplayName)}
          </p>
          <div className="mt-5 flex justify-center">
            <Button size="lg" onClick={() => setStage("capture")}>
              {strings.handoffReady}
            </Button>
          </div>
        </div>
      ) : null}

      {current && stage === "capture" ? (
        <div className="glass rounded-ios p-5">
          <h4
            ref={headingRef}
            tabIndex={-1}
            className={cn("text-headline text-foreground", CEREMONY_HEADING_CLASS)}
          >
            {strings.captureTitle(currentDisplayName)}
          </h4>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {strings.captureBody}
          </p>

          <ul className="mt-4 space-y-3">
            {required.map((type) => (
              <CaptureRow
                key={type}
                type={type}
                draft={capture[type]}
                strings={strings}
                onCompose={() => setComposer(type)}
                onOpenVault={
                  vaultEnabled
                    ? () => {
                        if (!documentKey) return;
                        setVaultNoticeState(null);
                        setVaultFor({
                          type,
                          signerId: current.id,
                          documentKey,
                        });
                        setVaultShown(true);
                      }
                    : undefined
                }
                vaultDisabled={!documentKey}
              />
            ))}
          </ul>

          <div className="mt-4">
            <Button
              size="md"
              disabled={!ready}
              onClick={() => setStage("review")}
            >
              {strings.captureContinue}
              <ArrowRight aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}

      {current && stage === "review" ? (
        <div className="glass rounded-ios p-5">
          <h4
            ref={headingRef}
            tabIndex={-1}
            className={cn("text-headline text-foreground", CEREMONY_HEADING_CLASS)}
          >
            {strings.reviewTitle(currentDisplayName)}
          </h4>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {strings.reviewBody(currentFieldCount)}
          </p>

          <div className="mt-4 flex flex-wrap gap-3">
            {required.map((type) => {
              const draft = capture[type];
              if (!draft) return null;
              return (
                <ReviewFigure key={type} type={type} draft={draft} strings={strings} />
              );
            })}
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <Button size="md" onClick={() => goToTurn(position + 1)}>
              {position + 1 < queue.length
                ? strings.reviewNext
                : strings.reviewFinish}
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => setStage("capture")}
            >
              {strings.reviewRedo}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Estado de la ronda */}
      <ul className="space-y-2">
        {queue.map((signer, index) => {
          const done = isSignerComplete(
            fields,
            captures,
            signer.id,
            documentKey,
          );
          return (
            <li
              key={signer.id}
              className="rounded-ios-sm flex items-center gap-3 border border-white/10 bg-white/5 p-3"
            >
              <span
                aria-hidden="true"
                className="size-3 shrink-0 rounded-full"
                /* Color del firmante: dato del documento, no un token del tema. */
                style={{ backgroundColor: signer.color }}
              />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {displayNameOf(signer)}
              </span>
              <span
                className={cn(
                  "flex items-center gap-1 text-caption font-semibold",
                  done ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {done ? (
                  <Check aria-hidden="true" className="size-3.5" />
                ) : null}
                {done ? strings.statusSigned : strings.statusPending}
              </span>
              {!done ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => goToTurn(index)}
                >
                  {strings.handoffReady}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="glass rounded-ios p-5">
        <h4
          // Sin turno a la vista (todos pasaron), el foco va al balance de la ronda.
          ref={current ? undefined : headingRef}
          tabIndex={-1}
          className={cn("text-headline text-foreground", CEREMONY_HEADING_CLASS)}
        >
          {pending.length === 0 ? strings.allSignedTitle : strings.ceremonyTitle}
        </h4>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {pending.length === 0
            ? strings.allSignedBody
            : strings.pendingBody(pending.length)}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="lg"
            disabled={pending.length > 0 || queue.length === 0 || busy}
            onClick={onFinish}
          >
            {strings.applyAndDownload}
          </Button>
          <Button
            variant="ghost"
            size="lg"
            onClick={() => {
              onCapturesChange({});
              goToTurn(0);
            }}
          >
            {strings.restartCeremony}
          </Button>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          {strings.legalNote}
        </p>
      </div>

      {current && composer ? (
        <SignatureComposer
          open
          onClose={() => setComposer(null)}
          strings={strings}
          variant={composer === "initials" ? "initials" : "signature"}
          title={
            composer === "initials"
              ? strings.composerInitialsFor(currentDisplayName)
              : strings.composerFor(currentDisplayName)
          }
          onSave={(draft) => saveDraft(composer, draft)}
          signerName={current.name}
          onRemember={
            vaultEnabled
              ? (draft, who) => {
                  // La firma y las iniciales de una misma persona van en UNA
                  // entrada: se junta lo recien creado con el otro trazo ya capturado.
                  const other =
                    composer === "signature" ? capture.initials : capture.signature;
                  const signerId = current.id;
                  const atStage = stage;
                  void rememberDrafts(strings, {
                    signerName: who.signerName,
                    sourceDocument: documentName ?? "",
                    signature: composer === "signature" ? draft : other,
                    initials: composer === "initials" ? draft : other,
                    created: composer,
                  }).then((notice) => showVaultNotice(signerId, atStage, notice));
                }
              : undefined
          }
        />
      ) : null}

      {/* Se monta al abrirla por primera vez y se queda: asi la salida se anima. */}
      {vaultEnabled && current && vaultFor ? (
        <SignatureVaultSheet
          open={vaultOpen}
          onClose={() => setVaultShown(false)}
          strings={strings}
          need={vaultFor.type}
          preferSignerName={current.name}
          onUse={applyVaultEntry}
        />
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Piezas presentacionales (las reutiliza `BlockCeremony`)
 * ------------------------------------------------------------------ */

function typeLabelOf(type: SignatureFieldType, strings: SignStrings): string {
  return type === "signature" ? strings.fieldSignature : strings.fieldInitials;
}

export type CaptureRowProps = {
  type: SignatureFieldType;
  draft: SignatureDraft | null;
  strings: SignStrings;
  /** Abre el compositor de este tipo. */
  onCompose: () => void;
  /** Abre las firmas guardadas; ausente = baul apagado (no se pinta el boton). */
  onOpenVault?: () => void;
  vaultDisabled?: boolean;
  /**
   * Cuando hay varias filas iguales en pantalla (un bloque cada una), el nombre
   * accesible de sus botones lleva este contexto: «Crear firma · Bloque 2».
   */
  context?: string;
};

/** Una fila de captura: el trazo (o «pendiente»), «Crear/Rehacer» y «Usar una guardada». */
export function CaptureRow({
  type,
  draft,
  strings,
  onCompose,
  onOpenVault,
  vaultDisabled = false,
  context,
}: CaptureRowProps) {
  const label = typeLabelOf(type, strings);
  const composeText = draft
    ? strings.captureRedo
    : type === "signature"
      ? strings.captureSignature
      : strings.captureInitials;
  const withContext = (text: string) => (context ? `${text} · ${context}` : text);
  return (
    <li className="rounded-ios-sm flex flex-wrap items-center gap-3 border border-white/10 bg-white/5 p-3">
      <span className="ui-label min-w-20 text-muted-foreground">{label}</span>
      {draft ? (
        <span className="rounded-ios-sm flex min-h-12 flex-1 items-center justify-center bg-white p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={draft.dataUrl}
            alt={label}
            className="max-h-12 w-auto max-w-full object-contain"
          />
        </span>
      ) : (
        <span className="flex-1 text-xs text-muted-foreground">
          {strings.capturePending}
        </span>
      )}
      <Button
        variant={draft ? "ghost" : "primary"}
        size="sm"
        aria-label={context ? withContext(composeText) : undefined}
        onClick={onCompose}
      >
        {composeText}
      </Button>
      {onOpenVault ? (
        <Button
          variant="secondary"
          size="sm"
          // 44 px reales con puntero grueso (el `sm` mide 36 px).
          className="pointer-coarse:h-11 pointer-coarse:before:hidden"
          disabled={vaultDisabled}
          aria-label={withContext(strings.vaultUseSavedFor(label))}
          onClick={onOpenVault}
        >
          {strings.vaultUseSaved}
        </Button>
      ) : null}
    </li>
  );
}

export type ReviewFigureProps = {
  type: SignatureFieldType;
  draft: SignatureDraft;
  strings: SignStrings;
};

/** El trazo creado, en la revision del turno. */
export function ReviewFigure({ type, draft, strings }: ReviewFigureProps) {
  const label = typeLabelOf(type, strings);
  return (
    <figure className="rounded-ios-sm border border-white/10 bg-white p-3">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={draft.dataUrl}
        alt={label}
        className="max-h-16 w-auto max-w-40 object-contain"
      />
      <figcaption className="mt-2 text-caption-2 text-neutral-500">
        {label}
      </figcaption>
    </figure>
  );
}
