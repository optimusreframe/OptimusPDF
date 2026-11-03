"use client";

import { useId, useState } from "react";
import { ArrowRight, Check, Circle, Smartphone, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { StatusRegion } from "@/components/tool/liveRouting";
import { cn } from "@/lib/cn";
import {
  SignatureComposer,
  type SignatureDraft,
} from "@/app/sign-pdf/SignatureComposer";
import { SignatureVaultSheet } from "@/app/sign-pdf/SignatureVaultSheet";
import { StaleSignatureNotice } from "@/app/sign-pdf/StaleSignatureNotice";
import { VaultNoticeLine } from "@/app/sign-pdf/VaultNoticeLine";
import { useSignPdfFeatureFlag } from "@/app/sign-pdf/signFeatureFlags";
import { useCeremonyFocus } from "@/app/sign-pdf/useCeremonyFocus";
import { useCeremonyTurn } from "@/app/sign-pdf/useCeremonyTurn";
import { captureTypeLabel, type CeremonyState } from "@/app/sign-pdf/blockModel";
import {
  touchVaultEntry,
  vaultImageToDataUrl,
  type VaultEntry,
} from "@/app/sign-pdf/signVault";
import { rememberDrafts, type VaultNotice } from "@/app/sign-pdf/vaultMessages";
import { CeremonySummary, QuickSignCard } from "@/app/sign-pdf/quickSign/QuickSignCard";
import { savedDraftsOf, signerSlotCounts } from "@/app/sign-pdf/quickSign/quickSignModel";
import { useQuickSign } from "@/app/sign-pdf/quickSign/useQuickSign";
import { useQuickSignStrings } from "@/app/sign-pdf/fillMode/fillStrings";
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
  staleCaptureReason,
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

type Stage = CeremonyState["stage"];

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
  /**
   * Turno guardado en la sesion (de quien es y en que etapa). Con `onCeremonyChange`
   * el turno sobrevive a que esta ceremonia se vuelva a montar («Atras» ->
   * «Continuar», recarga); sin el, la ceremonia lo lleva por su cuenta.
   */
  ceremony?: CeremonyState | null;
  onCeremonyChange?: (next: CeremonyState | null) => void;
  /** Campos de texto con algo escrito (para el resumen del turno «Firmas · Iniciales · Campos»). */
  filledFields?: number;
  /** «Editar» del resumen del turno: vuelve al documento para cambiar los huecos o los campos. Ausente = sin boton. */
  onEdit?: () => void;
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
  ceremony,
  onCeremonyChange,
  filledFields = 0,
  onEdit,
}: SigningCeremonyProps) {
  const queue = signingQueue(signers, fields);
  // Firmantes cuya firma YA hecha dejo de valer (se cambio el texto del documento o sus huecos): vuelven a estar pendientes
  // y se dice por que (F0-fix, D7). El turno vuelve al primero de ellos.
  const stale = queue.flatMap((signer) => {
    if (isSignerComplete(fields, captures, signer.id, documentKey)) return [];
    const reason = staleCaptureReason(captures, fields, signer.id, documentKey);
    return reason ? [{ signerId: signer.id, reason }] : [];
  });
  // El turno se deriva de lo que falta y, desde que alguien actua, vive en la sesion.
  const {
    position,
    stage,
    goTo: goToTurn,
    setStage,
    advance,
    othersPending,
  } = useCeremonyTurn({
    stored: ceremony,
    onChange: onCeremonyChange,
    queue,
    isDone: (signerId) => isSignerComplete(fields, captures, signerId, documentKey),
    staleSignerId: stale[0]?.signerId ?? null,
  });
  const [composer, setComposer] = useState<SignatureFieldType | null>(null);
  /** UNA sola region viva (siempre montada): lo que queda por recoger tras cada trazo. */
  const [liveMessage, setLiveMessage] = useState("");
  const composeIdBase = useId();
  const vaultEnabled = useSignPdfFeatureFlag("signatureVault");
  const quick = useQuickSignStrings();
  /** Con UNA sola persona que firma no hay a quien pasarle el dispositivo: el traspaso se salta y se dice por que (W3-B2). */
  const soleSigner = queue.length === 1;
  const shownStage: Stage = stage === "handoff" && soleSigner ? "capture" : stage;
  /** Lo que habia antes de «Firmar todo con mi firma guardada», para «Deshacer». */
  const [quickUndo, setQuickUndo] = useState<{ signerId: string; captures: CaptureMap } | null>(null);
  const turnSigner = queue[position] ?? null;
  const proposal = useQuickSign({
    enabled: vaultEnabled && turnSigner !== null && shownStage !== "review" && documentKey !== null,
    signerName: turnSigner?.name ?? "",
    need: turnSigner
      ? requiredCaptureTypes(fields, turnSigner.id).filter((type) => validCapture(captures, fields, turnSigner.id, documentKey)[type] === null)
      : [],
  });
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
        <div className="surface-card rounded-ios flex items-center gap-3 p-6">
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
  const missing = required.filter((type) => capture[type] === null);
  const composeIdOf = (type: SignatureFieldType) => `${composeIdBase}-${type}`;
  const missingHintId = `${composeIdBase}-missing`;
  /** «Ir a lo que falta»: lleva el foco (y la vista) al primer trazo pendiente. */
  const goToMissing = () => {
    const first = missing[0];
    const target = first ? document.getElementById(composeIdOf(first)) : null;
    if (!target) return;
    // jsdom no implementa `scrollIntoView`; `auto` = sin animacion (tambien con movimiento reducido).
    target.scrollIntoView?.({ block: "center", behavior: "auto" });
    target.focus({ preventScroll: true });
  };
  /** Tras guardar un trazo: lo que queda por recoger, en la region viva. */
  const announceProgress = (next: SignerCapture) => {
    const left = required.filter((type) => next[type] === null);
    setLiveMessage(
      left.length === 0
        ? strings.ceremonyAllCaptured
        : strings.ceremonyMissing(left.map((type) => captureTypeLabel(type, strings))),
    );
  };

  /** Nombre a mostrar de un firmante, con el mismo fallback numerado que `SignerManager`. */
  const displayNameOf = (signer: Signer): string =>
    signerDisplayName(
      signer.name,
      signers.findIndex((candidate) => candidate.id === signer.id),
      strings.defaultSignerName,
    );
  const currentDisplayName = current ? displayNameOf(current) : "";
  const staleReasonOf = new Map(stale.map((item) => [item.signerId, item.reason]));
  const staleNotes = stale.flatMap((item) => {
    const signer = signers.find((candidate) => candidate.id === item.signerId);
    return signer ? [{ signerId: item.signerId, text: strings.staleSignature(displayNameOf(signer), item.reason) }] : [];
  });

  const saveDraft = (type: SignatureFieldType, draft: SignatureDraft) => {
    if (!current) return;
    // `capture` ya viene vacio si los huecos cambiaron: lo que se guarda
    // queda atado al documento y a la disposicion de ahora mismo.
    const next: SignerCapture = {
      ...capture,
      [type]: draft,
      stamp: captureStamp(documentKey, fields, current.id),
    };
    onCapturesChange({ ...captures, [current.id]: next });
    announceProgress(next);
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
    announceProgress(next);
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

  /**
   * «Firmar todo con mi firma guardada»: con UN toque, firma e iniciales del baul van a TODOS los huecos del firmante. Solo se
   * rellena lo que falta (lo vigente no se pisa) y lo que la entrada no trae se pide aparte. Si no falta nada, la persona pasa a
   * la revision: ve como queda antes de seguir. Nada se descarga aqui.
   */
  const applyQuick = (entry: VaultEntry) => {
    if (!current || !documentKey) return;
    const all = savedDraftsOf(entry);
    const next: SignerCapture = { ...capture, stamp: captureStamp(documentKey, fields, current.id) };
    for (const type of required) {
      if (!capture[type] && all[type]) next[type] = all[type];
    }
    const left = required.filter((type) => next[type] === null);
    setQuickUndo({ signerId: current.id, captures });
    onCapturesChange({ ...captures, [current.id]: next });
    announceProgress(next);
    void touchVaultEntry(entry.id);
    const nextStage: Stage = left.length === 0 ? "review" : "capture";
    showVaultNotice(current.id, nextStage, {
      text:
        left.length === 0
          ? quick.applied(entry.signerName)
          : quick.appliedMissing(entry.signerName, left.map((type) => captureTypeLabel(type, strings))),
      tone: left.length === 0 ? "success" : "info",
    });
    setStage(nextStage);
  };

  /** «Deshacer»: devuelve los trazos a como estaban antes del toque y vuelve a la captura. */
  const undoQuickSign = () => {
    if (!quickUndo || !current || quickUndo.signerId !== current.id) return;
    onCapturesChange(quickUndo.captures);
    setQuickUndo(null);
    setLiveMessage(quick.undone);
    setStage("capture");
  };

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

  /** Ultimo firmante y nada pendiente: «Revisar» y «Descargar» son UNA sola pantalla (la tarjeta de abajo trae el boton). */
  const merged = current !== null && shownStage === "review" && !othersPending && pending.length === 0;
  const turnCounts = current ? signerSlotCounts([fields], current.id) : { signatures: 0, initials: 0 };
  const quickCard =
    proposal && current && shownStage !== "review" ? (
      <QuickSignCard
        proposal={proposal}
        signerName={currentDisplayName}
        counts={turnCounts}
        onApply={applyQuick}
        onChooseOther={
          vaultEnabled && documentKey
            ? () => {
                const type = required.find((candidate) => capture[candidate] === null) ?? required[0] ?? "signature";
                setVaultNoticeState(null);
                setVaultFor({ type, signerId: current.id, documentKey });
                setVaultShown(true);
              }
            : undefined
        }
        signStrings={strings}
        disabled={busy}
      />
    ) : null;

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

      {/*
       * Region viva UNICA de la ceremonia, siempre montada: lo que falta por recoger tras cada trazo.
       * `StatusRegion` la encamina a la region unica de PDF Pro cuando la ceremonia vive dentro de el.
       */}
      <StatusRegion as="p" text={liveMessage || staleNotes.map((note) => note.text).join(" ")} className="sr-only">
        {liveMessage || staleNotes.map((note) => note.text).join(" ")}
      </StatusRegion>

      <StaleSignatureNotice items={staleNotes} />

      {current && shownStage === "handoff" ? (
        <div className="surface-card rounded-ios p-6 text-center">
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
          {/* La firma guardada en el propio traspaso: quien tiene el dispositivo firma con UN toque y pasa a ver como queda. */}
          {quickCard ? <div className="mx-auto mt-5 max-w-md text-left">{quickCard}</div> : null}
        </div>
      ) : null}

      {current && shownStage === "capture" ? (
        <div className="surface-card rounded-ios p-5">
          <h4
            ref={headingRef}
            tabIndex={-1}
            className={cn("text-headline text-foreground", CEREMONY_HEADING_CLASS)}
          >
            {strings.captureTitle(currentDisplayName)}
          </h4>
          {/* Lo primero: firmar con la firma guardada es el camino corto; crear una firma nueva queda debajo. */}
          {quickCard ? <div className="mt-3">{quickCard}</div> : null}
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {strings.captureBody}
          </p>
          {/* Con una sola persona no hay traspaso: se dice por que, y el resumen del turno deja corregir lo decidido. */}
          {soleSigner && stage === "handoff" ? (
            <p className="mt-2 text-footnote text-muted-foreground" data-sole-signer="">
              {quick.singleSigner}
            </p>
          ) : null}
          <CeremonySummary counts={turnCounts} fields={filledFields} onEdit={onEdit} className="mt-2" />

          {required.length > 1 ? (
            <TurnProgressList
              label={strings.ceremonyProgressLabel(currentDisplayName)}
              doneText={strings.ceremonyItemDone}
              missingText={strings.ceremonyItemMissing}
              staleText={strings.ceremonyItemStale}
              items={required.map((type) => ({
                key: type,
                label: captureTypeLabel(type, strings),
                done: capture[type] !== null,
                // Ya estaba hecho (hay trazo guardado) pero su sello dejo de valer.
                stale: capture[type] === null && staleReasonOf.has(current.id) && captures[current.id]?.[type] != null,
              }))}
            />
          ) : null}

          <ul className="mt-4 space-y-3">
            {required.map((type) => (
              <CaptureRow
                key={type}
                type={type}
                draft={capture[type]}
                strings={strings}
                composeId={composeIdOf(type)}
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

          <div className="mt-4 space-y-3">
            {/* Por que «Ver como queda» esta apagado: que falta y un salto directo a ello. */}
            {missing.length > 0 ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <p
                  id={missingHintId}
                  className="min-w-0 flex-1 text-footnote font-medium leading-relaxed text-foreground [overflow-wrap:anywhere]"
                >
                  {strings.ceremonyMissing(
                    missing.map((type) => captureTypeLabel(type, strings)),
                  )}
                </p>
                <Button variant="secondary" size="md" onClick={goToMissing}>
                  {strings.ceremonyGoToMissing}
                </Button>
              </div>
            ) : null}
            <Button
              size="md"
              disabled={!ready}
              aria-describedby={missing.length > 0 ? missingHintId : undefined}
              onClick={() => setStage("review")}
            >
              {strings.captureContinue}
              <ArrowRight aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}

      {current && shownStage === "review" && !merged ? (
        <div className="surface-card rounded-ios p-5">
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
            <Button size="md" wrap onClick={advance}>
              {othersPending ? strings.reviewNext : strings.reviewFinish}
            </Button>
            {quickUndo && quickUndo.signerId === current.id ? (
              <Button wrap variant="secondary" size="md" onClick={undoQuickSign} data-quick-sign-undo="">
                {quick.undo}
              </Button>
            ) : (
              <Button
                wrap
                variant="secondary"
                size="md"
                onClick={() => setStage("capture")}
              >
                {strings.reviewRedo}
              </Button>
            )}
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
          const staleReason = done ? undefined : staleReasonOf.get(signer.id);
          return (
            <li
              key={signer.id}
              data-stale-signer={staleReason ? signer.id : undefined}
              className="rounded-ios-sm flex flex-wrap items-center gap-x-3 gap-y-1 border border-white/10 bg-white/5 p-3"
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
                ) : staleReason ? (
                  <X aria-hidden="true" className="size-3.5" />
                ) : null}
                {done ? strings.statusSigned : strings.statusPending}
              </span>
              {!done ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="pointer-coarse:h-11 pointer-coarse:before:hidden"
                  onClick={() => goToTurn(index)}
                >
                  {strings.handoffReady}
                </Button>
              ) : null}
              {staleReason ? (
                <p data-stale-reason="" className="basis-full pl-6 text-caption text-foreground [overflow-wrap:anywhere]">
                  {strings.statusStale} · {strings.staleReasonShort(staleReason)}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="surface-card rounded-ios p-5">
        <h4
          // Sin turno a la vista (todos pasaron), el foco va al balance de la ronda.
          ref={current && !merged ? undefined : headingRef}
          tabIndex={-1}
          className={cn("text-headline text-foreground", CEREMONY_HEADING_CLASS)}
        >
          {merged ? (strings.embedded ? quick.finalTitleApply : quick.finalTitle) : pending.length === 0 ? strings.allSignedTitle : strings.ceremonyTitle}
        </h4>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {merged
            ? (strings.embedded ? quick.finalBodyApply(1) : quick.finalBody(1))
            : pending.length === 0
              ? strings.allSignedBody
              : strings.pendingBody(pending.length)}
        </p>
        {/* Pantalla unica «Revisar y descargar»: lo que firmo la persona del turno, a la vista junto al boton. */}
        {merged ? (
          <div className="mt-3 flex flex-wrap gap-3" data-merged-review="">
            {required.map((type) => {
              const draft = capture[type];
              return draft ? <ReviewFigure key={type} type={type} draft={draft} strings={strings} /> : null;
            })}
          </div>
        ) : null}
        {/* Todo lo que hace falta ya esta recogido (quiza antes de poner los campos): se dice claro y no se pide nada. */}
        {pending.length === 0 && queue.length > 0 ? (
          <p data-all-covered="" className="mt-2 text-footnote font-medium leading-relaxed text-foreground">
            {strings.early.allCovered}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="lg"
            wrap
            disabled={pending.length > 0 || queue.length === 0 || busy}
            onClick={onFinish}
          >
            {strings.applyAndDownload}
          </Button>
          {merged && quickUndo && current && quickUndo.signerId === current.id ? (
            <Button variant="secondary" size="lg" wrap onClick={undoQuickSign} data-quick-sign-undo="">
              {quick.undo}
            </Button>
          ) : merged ? (
            <Button variant="secondary" size="lg" wrap onClick={() => setStage("capture")}>
              {quick.finalRedo}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="lg"
            wrap
            onClick={() => {
              // Solo quien esta en la cola: lo recogido de quien aun no tiene campos no se toca.
              const inQueue = new Set(queue.map((signer) => signer.id));
              onCapturesChange(Object.fromEntries(Object.entries(captures).filter(([id]) => !inQueue.has(id))));
              goToTurn(0);
              setLiveMessage("");
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

const typeLabelOf = captureTypeLabel;

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
  /** `id` del boton de crear/rehacer: lo usa «Ir a lo que falta» para llevarle el foco. */
  composeId?: string;
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
  composeId,
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
        id={composeId}
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

export type TurnProgressListProps = {
  /** Nombre accesible de la lista («Progreso de Ana»). */
  label: string;
  doneText: string;
  missingText: string;
  /** Lo que se dice de un trazo que ya estaba hecho y dejo de valer («ya no es valida»). */
  staleText?: string;
  items: readonly { key: string; label: string; done: boolean; stale?: boolean }[];
};

/**
 * Lo que el turno exige, trazo a trazo, con ✓ (hecho), ○ (falta) y ✗ (ya estaba hecho y dejo de valer, con el motivo a la
 * vista). Un icono solo no basta: cada elemento lleva tambien el estado en texto.
 */
export function TurnProgressList({ label, doneText, missingText, staleText, items }: TurnProgressListProps) {
  return (
    <ul aria-label={label} className="mt-3 flex flex-wrap gap-2">
      {items.map((item) => (
        <li
          key={item.key}
          className={cn(
            "rounded-ios-sm flex items-center gap-1.5 border px-2.5 py-1.5 text-footnote font-medium",
            item.done
              ? "border-signal/40 bg-signal/10 text-foreground"
              : "border-white/10 bg-white/5 text-muted-foreground",
          )}
        >
          {item.done ? (
            <Check aria-hidden="true" className="size-3.5 shrink-0" />
          ) : item.stale ? (
            <X aria-hidden="true" className="size-3.5 shrink-0" />
          ) : (
            <Circle aria-hidden="true" className="size-3.5 shrink-0" />
          )}
          <span className="[overflow-wrap:anywhere]">{item.label}</span>
          {item.stale && !item.done && staleText ? (
            <span className="[overflow-wrap:anywhere]">· {staleText}</span>
          ) : null}
          <span className="sr-only">{item.done ? doneText : item.stale && staleText ? staleText : missingText}</span>
        </li>
      ))}
    </ul>
  );
}
