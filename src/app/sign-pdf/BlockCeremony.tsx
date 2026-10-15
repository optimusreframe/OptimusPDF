"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, Check, Smartphone, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { StatusRegion } from "@/components/tool/liveRouting";
import { cn } from "@/lib/cn";
import {
  SignatureComposer,
  type SignatureDraft,
} from "@/app/sign-pdf/SignatureComposer";
import { SignatureVaultSheet } from "@/app/sign-pdf/SignatureVaultSheet";
import { VaultNoticeLine } from "@/app/sign-pdf/VaultNoticeLine";
import { BlockScopeSheet } from "@/app/sign-pdf/BlockScopeSheet";
import { StaleSignatureNotice } from "@/app/sign-pdf/StaleSignatureNotice";
import { CoverageNotices } from "@/app/sign-pdf/SignerBlocks";
import {
  CEREMONY_HEADING_CLASS,
  CaptureRow,
  ReviewFigure,
  TurnProgressList,
} from "@/app/sign-pdf/SigningCeremony";
import {
  addBlock,
  applySavedToBlocks,
  blockRequiredTypes,
  blockSlotDocs,
  captureForBlock,
  ceremonyQueue,
  changeBlockScope,
  clearBlock,
  fieldsOfDoc,
  isBlockComplete,
  isSignerDone,
  pendingBlockSigners,
  rememberSource,
  scopeSummary,
  signerBlocks,
  signerLabel,
  staleSigners,
  turnItemLabel,
  turnProgress,
  visibleDraft,
  type BlockContext,
  type CeremonyState,
  type DocRef,
} from "@/app/sign-pdf/blockModel";
import {
  coverageIssues,
  type DocId,
  type DocState,
  type SignerBlock,
} from "@/app/sign-pdf/docSet";
import { useSignPdfFeatureFlag } from "@/app/sign-pdf/signFeatureFlags";
import {
  touchVaultEntry,
  vaultImageToDataUrl,
  type VaultEntry,
} from "@/app/sign-pdf/signVault";
import type { SignStrings } from "@/app/sign-pdf/strings";
import { rememberDrafts, type VaultNotice } from "@/app/sign-pdf/vaultMessages";
import { useCeremonyFocus } from "@/app/sign-pdf/useCeremonyFocus";
import { useCeremonyTurn } from "@/app/sign-pdf/useCeremonyTurn";
import type { SignatureFieldType, Signer } from "@/lib/pdf/sign";

type Stage = CeremonyState["stage"];

export type BlockCeremonyProps = {
  signers: Signer[];
  /** Documentos de la ronda, en el orden de la cola. */
  docs: readonly DocRef[];
  /** Estado de cada documento (huecos). */
  docStates: Readonly<Record<DocId, DocState>>;
  /** Huella de cada documento; `null` = aun calculandose. */
  keys: Readonly<Record<DocId, string | null>>;
  blocks: SignerBlock[];
  onBlocksChange: (blocks: SignerBlock[]) => void;
  /** Frases que impiden descargar (cobertura, pendientes, huellas...), ya traducidas. */
  blockerMessages: readonly string[];
  /** Hay algo que impida descargar (la ceremonia en si puede estar completa). */
  blocked: boolean;
  onFinish: () => void;
  strings: SignStrings;
  busy?: boolean;
  /**
   * Turno guardado en la sesion (de quien es y en que etapa). Con `onCeremonyChange`
   * el turno sobrevive a que esta ceremonia se vuelva a montar (pestanas de
   * documento, «Atras», recarga); sin el, la ceremonia lo lleva por su cuenta.
   */
  ceremony?: CeremonyState | null;
  onCeremonyChange?: (next: CeremonyState | null) => void;
};

/**
 * Ronda de firma por BLOQUES (varios documentos). El turno es de un firmante
 * (maximo 2) y, dentro, hay una fila por bloque con su firma e iniciales: el
 * mismo trazo vale para todos los documentos del bloque, pero el SELLO se
 * calcula por documento en el momento de crearlo (`captureForBlock`). Una
 * firma del baul rellena un bloque, o todos los vacios del firmante.
 *
 * Mismo guion que `SigningCeremony` (traspaso -> captura -> revision) y la
 * misma gestion del foco: al cambiar de etapa o de turno el encabezado nuevo
 * recibe el foco (no al montar).
 */
export function BlockCeremony({
  signers,
  docs,
  docStates,
  keys,
  blocks,
  onBlocksChange,
  blockerMessages,
  blocked,
  onFinish,
  strings,
  busy = false,
  ceremony,
  onCeremonyChange,
}: BlockCeremonyProps) {
  const docIds = docs.map((doc) => doc.id);
  const ctx: BlockContext = { signers, docs: docStates, keys };
  const queue = ceremonyQueue(ctx, docIds);
  // Firmantes cuya firma YA hecha dejo de valer (se cambio el texto del documento, sus huecos o el archivo): vuelven a estar
  // pendientes, se dice por que y el turno vuelve al primero de ellos (F0-fix, D7).
  const stale = staleSigners(blocks, ctx, docIds);
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
    isDone: (signerId) => isSignerDone(blocks, signerId, ctx),
    staleSignerId: stale[0]?.signerId ?? null,
  });
  const [composer, setComposer] = useState<{
    blockId: string;
    type: SignatureFieldType;
  } | null>(null);
  const [vaultFor, setVaultFor] = useState<{
    blockId: string;
    type: SignatureFieldType;
  } | null>(null);
  const [vaultShown, setVaultShown] = useState(false);
  const [scopeBlockId, setScopeBlockId] = useState<string | null>(null);
  /** Aviso del baul, atado al firmante y a la etapa en que se dio (como en `SigningCeremony`). */
  const [vaultNoticeState, setVaultNoticeState] = useState<{
    notice: VaultNotice;
    signerId: string;
    stage: Stage;
  } | null>(null);
  /**
   * UNA sola region viva (siempre montada): el ultimo anuncio de alcance / bloque
   * y lo que queda por recoger tras cada trazo.
   */
  const [liveMessage, setLiveMessage] = useState("");
  const composeIdBase = useId();
  const vaultEnabled = useSignPdfFeatureFlag("signatureVault");
  /**
   * «Anadir bloque para X» se desmonta al resolverse el aviso de cobertura:
   * el foco va al balance de la ronda (siempre presente), que ya dice si
   * queda algo por firmar.
   */
  const balanceId = useId();
  const focusBalanceRef = useRef(false);
  const [addedBlocks, setAddedBlocks] = useState(0);
  useEffect(() => {
    if (!focusBalanceRef.current) return;
    focusBalanceRef.current = false;
    document.getElementById(balanceId)?.focus({ preventScroll: true });
  }, [addedBlocks, balanceId]);

  const current = queue[position] ?? null;
  const headingRef = useCeremonyFocus(stage, position);

  const keysReady = docIds.every((id) => Boolean(keys[id]));
  if (!keysReady) {
    return (
      <section className="space-y-4">
        <h3 className="ui-label text-muted-foreground">{strings.ceremonyTitle}</h3>
        <div className="surface-card rounded-ios flex items-center gap-3 p-6">
          <Spinner />
          <p className="text-sm text-muted-foreground">{strings.checkingDocument}</p>
        </div>
      </section>
    );
  }

  const pending = pendingBlockSigners(blocks, ctx, docIds);
  const issues = coverageIssues(
    signers,
    docIds,
    Object.fromEntries(
      docIds.map((id) => [id, { fields: fieldsOfDoc(ctx, id) }]),
    ),
    blocks,
  );
  const nameOf = (signer: Signer) => signerLabel(signers, signer.id, strings);
  const currentName = current ? nameOf(current) : "";
  const staleReasonOf = new Map(stale.map((item) => [item.signerId, item.reason]));
  const staleNotes = stale.map((item) => ({
    signerId: item.signerId,
    text: strings.staleSignature(signerLabel(signers, item.signerId, strings), item.reason),
  }));
  const staleAnnouncement = staleNotes.map((note) => note.text).join(" ");
  // Los bloques con algo que firmar, en el orden en que se muestran.
  const currentBlocks = current
    ? signerBlocks(blocks, current.id).filter(
        (block) => blockRequiredTypes(block, ctx).length > 0,
      )
    : [];
  const ready = currentBlocks.every((block) => isBlockComplete(block, ctx));
  const progress = current ? turnProgress(blocks, current.id, ctx) : [];
  const missing = progress.filter((item) => !item.done);
  const itemLabel = (item: (typeof progress)[number]) =>
    turnItemLabel(item, blocks, docs, strings, currentBlocks.length > 1);
  const composeIdOf = (item: (typeof progress)[number]) =>
    `${composeIdBase}-${item.blockId}-${item.type}`;
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
  const announceProgress = (nextBlocks: SignerBlock[]) => {
    if (!current) return;
    const left = turnProgress(nextBlocks, current.id, ctx).filter((item) => !item.done);
    setLiveMessage(
      left.length === 0
        ? strings.ceremonyAllCaptured
        : strings.ceremonyMissing(
            left.map((item) =>
              turnItemLabel(item, nextBlocks, docs, strings, currentBlocks.length > 1),
            ),
          ),
    );
  };
  const scopeBlock = blocks.find((block) => block.id === scopeBlockId) ?? null;
  const composerBlock = composer
    ? (blocks.find((block) => block.id === composer.blockId) ?? null)
    : null;
  const vaultBlock = vaultFor
    ? (blocks.find((block) => block.id === vaultFor.blockId) ?? null)
    : null;

  const blockTitle = (block: SignerBlock): string =>
    strings.blockName(signerBlocks(blocks, block.signerId).findIndex((b) => b.id === block.id) + 1);

  const showVaultNotice = (signerId: string, atStage: Stage, notice: VaultNotice) =>
    setVaultNoticeState({ notice, signerId, stage: atStage });
  const vaultNotice =
    vaultNoticeState &&
    current &&
    vaultNoticeState.signerId === current.id &&
    vaultNoticeState.stage === stage
      ? vaultNoticeState.notice
      : null;
  const vaultOpen = vaultShown && vaultFor !== null && vaultBlock !== null && current !== null;

  const saveDraft = (blockId: string, type: SignatureFieldType, draft: SignatureDraft) => {
    const next = captureForBlock(blocks, blockId, { [type]: draft }, ctx);
    onBlocksChange(next);
    announceProgress(next);
  };

  /**
   * Aplica una firma guardada al bloque elegido (sus dos imagenes) y, con la
   * casilla, a los demas bloques VACIOS del firmante. El sello de cada
   * documento se calcula aqui, en el clic, con las huellas y los huecos de
   * ahora. `touchVaultEntry` se llama una sola vez por aplicacion.
   */
  const applyVaultEntry = (entry: VaultEntry, applyToAll: boolean) => {
    if (!current || !vaultFor) return;
    const saved = {
      signature: entry.signature
        ? { dataUrl: vaultImageToDataUrl(entry.signature), ratio: entry.signature.ratio }
        : null,
      initials: entry.initials
        ? { dataUrl: vaultImageToDataUrl(entry.initials), ratio: entry.initials.ratio }
        : null,
    };
    const result = applySavedToBlocks(blocks, vaultFor.blockId, saved, applyToAll, ctx);
    onBlocksChange(result.blocks);
    announceProgress(result.blocks);
    void touchVaultEntry(entry.id);
    setVaultShown(false);
    showVaultNotice(current.id, stage, {
      text:
        result.missing.length > 0
          ? strings.vaultAppliedPartial(entry.signerName, result.missing)
          : applyToAll
            ? strings.vaultAppliedAll(entry.signerName, result.filledOthers)
            : strings.vaultApplied(entry.signerName),
      tone: result.missing.length > 0 ? "info" : "success",
    });
  };

  const editScope = (blockId: string, scope: DocId[]) => {
    const edit = changeBlockScope(blocks, blockId, scope, docs, strings);
    if (edit.blocks === blocks) return;
    onBlocksChange(edit.blocks);
    setLiveMessage(edit.message);
  };

  const addBlockFor = (signerId: string, docId: DocId) => {
    const added = addBlock(blocks, signerId, docIds, docId);
    if (added.addedBlockId === null) return;
    onBlocksChange(added.blocks);
    focusBalanceRef.current = true;
    setAddedBlocks((count) => count + 1);
    setLiveMessage(
      strings.blockAdded(
        signerLabel(signers, signerId, strings),
        signerBlocks(added.blocks, signerId).findIndex(
          (block) => block.id === added.addedBlockId,
        ) + 1,
      ),
    );
  };

  /** Resumen «Aplica a: …» de un bloque y el boton para cambiarlo. */
  const scopeLine = (block: SignerBlock) => (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <p className="min-w-0 flex-1 text-footnote text-muted-foreground [overflow-wrap:anywhere]">
        {strings.blockAppliesTo(scopeSummary(block, docs, strings))}
      </p>
      <Button
        variant="ghost"
        size="sm"
        className="pointer-coarse:h-11 pointer-coarse:before:hidden"
        aria-label={strings.blockChangeScopeFor(blockTitle(block), currentName)}
        onClick={() => setScopeBlockId(block.id)}
      >
        {strings.blockChangeScope}
      </Button>
    </div>
  );

  const showHeadings = currentBlocks.length > 1;
  const slotCountFor = (block: SignerBlock) =>
    blockSlotDocs(block, ctx).reduce(
      (sum, docId) =>
        sum +
        fieldsOfDoc(ctx, docId).filter((field) => field.signerId === block.signerId).length,
      0,
    );
  const reviewSlots = currentBlocks.reduce((sum, block) => sum + slotCountFor(block), 0);
  const reviewDocs = new Set(currentBlocks.flatMap((block) => blockSlotDocs(block, ctx))).size;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="ui-label text-muted-foreground">{strings.ceremonyTitle}</h3>
        {current ? (
          <span className="text-footnote font-medium text-foreground tabular-nums">
            {strings.turnOf(position + 1, queue.length)}
          </span>
        ) : null}
      </div>

      <VaultNoticeLine notice={vaultNotice} />

      {/*
       * Region viva UNICA de la ceremonia, siempre montada: alcance editado, bloques anadidos y lo que falta por
       * recoger. `StatusRegion` la encamina a la region unica de PDF Pro cuando la ceremonia vive dentro de el.
       */}
      <StatusRegion as="p" text={liveMessage || staleAnnouncement} className="sr-only">
        {liveMessage || staleAnnouncement}
      </StatusRegion>

      <StaleSignatureNotice items={staleNotes} />

      {current && stage === "handoff" ? (
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
            {strings.handoffTitle(currentName)}
          </h4>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            {strings.handoffBody(currentName)}
          </p>
          <div className="mt-5 flex justify-center">
            <Button size="lg" onClick={() => setStage("capture")}>
              {strings.handoffReady}
            </Button>
          </div>
        </div>
      ) : null}

      {current && stage === "capture" ? (
        <div className="surface-card rounded-ios p-5">
          <h4
            ref={headingRef}
            tabIndex={-1}
            className={cn("text-headline text-foreground", CEREMONY_HEADING_CLASS)}
          >
            {strings.captureTitle(currentName)}
          </h4>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {strings.blockCaptureBody}
          </p>

          {progress.length > 1 ? (
            <TurnProgressList
              label={strings.ceremonyProgressLabel(currentName)}
              doneText={strings.ceremonyItemDone}
              missingText={strings.ceremonyItemMissing}
              staleText={strings.ceremonyItemStale}
              items={progress.map((item) => ({
                key: `${item.blockId}-${item.type}`,
                label: itemLabel(item),
                done: item.done,
                // Ya estaba hecho (hay trazo guardado) pero su sello por documento dejo de valer.
                stale: !item.done && blocks.find((block) => block.id === item.blockId)?.[item.type] != null,
              }))}
            />
          ) : null}

          <ul className="mt-4 space-y-4">
            {currentBlocks.map((block) => (
              <li
                key={block.id}
                aria-label={blockTitle(block)}
                className="rounded-ios space-y-3 border border-white/10 p-3"
              >
                {showHeadings ? (
                  <p className="text-footnote font-semibold text-foreground">
                    {blockTitle(block)}
                  </p>
                ) : null}
                {scopeLine(block)}
                <ul className="space-y-3">
                  {blockRequiredTypes(block, ctx).map((type) => (
                    <CaptureRow
                      key={type}
                      type={type}
                      draft={visibleDraft(block, type, ctx)}
                      strings={strings}
                      context={showHeadings ? blockTitle(block) : undefined}
                      composeId={composeIdOf({ blockId: block.id, type, done: false })}
                      onCompose={() => setComposer({ blockId: block.id, type })}
                      onOpenVault={
                        vaultEnabled
                          ? () => {
                              setVaultNoticeState(null);
                              setVaultFor({ blockId: block.id, type });
                              setVaultShown(true);
                            }
                          : undefined
                      }
                    />
                  ))}
                </ul>
              </li>
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
                  {strings.ceremonyMissing(missing.map(itemLabel))}
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

      {current && stage === "review" ? (
        <div className="surface-card rounded-ios p-5">
          <h4
            ref={headingRef}
            tabIndex={-1}
            className={cn("text-headline text-foreground", CEREMONY_HEADING_CLASS)}
          >
            {strings.reviewTitle(currentName)}
          </h4>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {strings.blockReviewBody(currentBlocks.length, reviewDocs)}
            {reviewSlots > 0 ? ` ${strings.reviewBody(reviewSlots)}` : ""}
          </p>

          <div className="mt-4 space-y-3">
            {currentBlocks.map((block) => (
              <div key={block.id} className="space-y-2">
                {showHeadings ? (
                  <p className="text-footnote font-semibold text-foreground">
                    {blockTitle(block)}
                  </p>
                ) : null}
                <p className="text-footnote text-muted-foreground [overflow-wrap:anywhere]">
                  {strings.blockAppliesTo(scopeSummary(block, docs, strings))}
                </p>
                <div className="flex flex-wrap gap-3">
                  {blockRequiredTypes(block, ctx).map((type) => {
                    const draft = visibleDraft(block, type, ctx);
                    return draft ? (
                      <ReviewFigure key={type} type={type} draft={draft} strings={strings} />
                    ) : null;
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <Button size="md" wrap onClick={advance}>
              {othersPending ? strings.reviewNext : strings.reviewFinish}
            </Button>
            <Button variant="secondary" size="md" wrap onClick={() => setStage("capture")}>
              {strings.reviewRedo}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Estado de la ronda */}
      <ul className="space-y-2">
        {queue.map((signer, index) => {
          const done = isSignerDone(blocks, signer.id, ctx);
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
                {nameOf(signer)}
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

      <CoverageNotices
        issues={issues}
        signers={signers}
        docs={docs}
        onAddBlock={addBlockFor}
        strings={strings}
      />

      <div className="surface-card rounded-ios p-5">
        <h4
          // Sin turno a la vista (todos pasaron), el foco va al balance de la ronda.
          id={balanceId}
          ref={current ? undefined : headingRef}
          tabIndex={-1}
          className={cn("text-headline text-foreground", CEREMONY_HEADING_CLASS)}
        >
          {pending.length === 0 && !blocked ? strings.allSignedTitle : strings.ceremonyTitle}
        </h4>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {pending.length === 0 && !blocked
            ? strings.batchReadyBody(docs.length)
            : pending.length > 0
              ? strings.pendingBody(pending.length)
              : strings.deliveryBlockedTitle}
        </p>
        {blocked && blockerMessages.length > 0 ? (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-footnote text-destructive-text">
            {blockerMessages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="lg"
            wrap
            disabled={blocked || pending.length > 0 || queue.length === 0 || busy}
            onClick={onFinish}
          >
            {strings.applyAndDownload}
          </Button>
          <Button
            variant="ghost"
            size="lg"
            wrap
            onClick={() => {
              let cleared = blocks;
              for (const block of blocks) cleared = clearBlock(cleared, block.id);
              onBlocksChange(cleared);
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

      <BlockScopeSheet
        open={scopeBlockId !== null}
        onClose={() => setScopeBlockId(null)}
        block={scopeBlock}
        blocks={blocks}
        signerName={scopeBlock ? signerLabel(signers, scopeBlock.signerId, strings) : ""}
        docs={docs}
        strings={strings}
        closeLabel={strings.confirmClose}
        onApply={editScope}
      />

      {current && composer && composerBlock ? (
        <SignatureComposer
          open
          onClose={() => setComposer(null)}
          strings={strings}
          variant={composer.type === "initials" ? "initials" : "signature"}
          title={
            composer.type === "initials"
              ? strings.composerInitialsFor(currentName)
              : strings.composerFor(currentName)
          }
          onSave={(draft) => saveDraft(composer.blockId, composer.type, draft)}
          signerName={current.name}
          onRemember={
            vaultEnabled
              ? (draft, who) => {
                  // Firma e iniciales de la misma persona van en UNA entrada.
                  const other = visibleDraft(
                    composerBlock,
                    composer.type === "signature" ? "initials" : "signature",
                    ctx,
                  );
                  const signerId = current.id;
                  const atStage = stage;
                  void rememberDrafts(strings, {
                    signerName: who.signerName,
                    sourceDocument: rememberSource(composerBlock, docs, strings),
                    signature: composer.type === "signature" ? draft : other,
                    initials: composer.type === "initials" ? draft : other,
                    created: composer.type,
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
          offerApplyAll={signerBlocks(blocks, current.id).length > 1}
          onUse={(entry, options) => applyVaultEntry(entry, options?.applyToAll === true)}
        />
      ) : null}
    </section>
  );
}
