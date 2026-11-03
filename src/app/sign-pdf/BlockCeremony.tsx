"use client";

import { useId, useState } from "react";
import { ArrowRight, Check, ChevronDown, ChevronUp, Smartphone, X } from "lucide-react";
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
import { ReviewBeforeDownload, type ReviewIssueView } from "@/app/sign-pdf/ReviewBeforeDownload";
import { blockGroups } from "@/app/sign-pdf/assignment";
import { fixTargetOf, issueText, type FixTarget } from "@/app/sign-pdf/assignmentIssues";
import { validateAssignment, type Issue } from "@/app/sign-pdf/assignmentValidation";
import { orderedQueue, moveTurn } from "@/app/sign-pdf/turnOrder";
import { copiesMap, groupDocsText, totalFiles } from "@/app/sign-pdf/assignmentUi";
import {
  CEREMONY_HEADING_CLASS,
  CaptureRow,
  ReviewFigure,
  TurnProgressList,
} from "@/app/sign-pdf/SigningCeremony";
import {
  applySavedToBlocks,
  blockNumber,
  blockRequiredTypes,
  blockSlotDocs,
  captureForBlock,
  captureTypeLabel,
  ceremonyAt,
  ceremonyQueue,
  changeBlockScope,
  clearBlock,
  fieldsOfDoc,
  firstPendingTurn,
  isBlockComplete,
  isSignerDone,
  pendingBlockSigners,
  rememberSource,
  signerBlocks,
  signerLabel,
  staleSigners,
  turnProgress,
  visibleDraft,
  type BlockContext,
  type CeremonyState,
  type DocRef,
} from "@/app/sign-pdf/blockModel";
import {
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
import { CeremonySummary, QuickSignCard } from "@/app/sign-pdf/quickSign/QuickSignCard";
import { filledFieldCount, savedDraftsOf, signerSlotCounts } from "@/app/sign-pdf/quickSign/quickSignModel";
import { useQuickSign } from "@/app/sign-pdf/quickSign/useQuickSign";
import { useQuickSignStrings } from "@/app/sign-pdf/fillMode/fillStrings";
import type { SignatureFieldType, Signer } from "@/lib/pdf/sign";

type Stage = CeremonyState["stage"];

/** Flecha de orden de turno: 44 px de caja con cualquier puntero (los turnos se cambian con el dedo). */
const TURN_ARROW =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-ios-sm border border-white/14 text-foreground material-thin " +
  "transition-[scale,background-color] duration-[var(--duration-fast)] ease-[var(--ease-spring)] active:scale-[0.97] " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:pointer-events-none disabled:opacity-50 " +
  "forced-colors:border-[ButtonText] forced-colors:disabled:border-[GrayText]";

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
  /** Archivos de la cola (para las miniaturas de «Revisar antes de descargar»); sin ellos solo hay contadores. */
  files?: readonly File[];
  /** Orden de los turnos guardado en la sesion (ids de firmante); ausente = el de la lista de firmantes. */
  turnOrder?: readonly string[] | null;
  /** Escribe el orden nuevo (la sesion lo guarda). Sin esto los turnos no se pueden reordenar. */
  onTurnOrderChange?: (order: string[]) => void;
  /** «Ir a corregirlo» de lo que no se arregla en esta pantalla: la tabla de firmantes o un campo de texto. */
  onFix?: (target: Exclude<FixTarget, { step: "turn" }>) => void;
  /** Tocar una miniatura de la revision lleva a esa pagina de ese documento. */
  onGoToPage?: (docId: DocId, pageIndex: number) => void;
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
  files,
  turnOrder,
  onTurnOrderChange,
  onFix,
  onGoToPage,
}: BlockCeremonyProps) {
  const docIds = docs.map((doc) => doc.id);
  const ctx: BlockContext = { signers, docs: docStates, keys };
  const queue = orderedQueue(ceremonyQueue(ctx, docIds), turnOrder);
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
  /** Balance de la ronda (siempre presente): recibe el foco cuando ya no hay turno. */
  const balanceId = useId();

  const current = queue[position] ?? null;
  const headingRef = useCeremonyFocus(stage, position);
  const quick = useQuickSignStrings();
  /**
   * Con UNA sola persona que firma no hay a quien pasarle el dispositivo: el traspaso se salta y se dice por que (W3-B2).
   * Con varias se mantiene, como siempre. Es solo lo que se PINTA: el turno guardado en la sesion sigue siendo el de siempre.
   */
  const soleSigner = queue.length === 1;
  const shownStage: Stage = stage === "handoff" && soleSigner ? "capture" : stage;
  /** Firma guardada que se propone al firmante del turno (un toque coloca firma e iniciales en TODOS sus huecos). */
  const [usedEntries, setUsedEntries] = useState<Record<string, string>>({});
  /** Lo que habia antes de «Firmar todo con mi firma guardada», para «Deshacer». */
  const [quickUndo, setQuickUndo] = useState<{ signerId: string; blocks: SignerBlock[] } | null>(null);
  const needTypes: SignatureFieldType[] = current
    ? [...new Set(turnProgress(blocks, current.id, ctx).filter((item) => !item.done).map((item) => item.type))]
    : [];
  const proposal = useQuickSign({
    enabled: vaultEnabled && current !== null && shownStage !== "review",
    signerName: current?.name ?? "",
    need: needTypes,
    excludeIds: new Set(Object.entries(usedEntries).filter(([signerId]) => signerId !== current?.id).map(([, entryId]) => entryId)),
  });

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
  // Letra de cada grupo («Firma A», «Firma B»): son los bloques de siempre con nombre visible.
  const letters = blockGroups(blocks, docIds, signers);
  const groupTitle = (block: SignerBlock): string =>
    letters[block.id] ? strings.assignment.group(letters[block.id]) : strings.blockName(blockNumber(blocks, block.id));
  const nameOf = (signer: Signer) => signerLabel(signers, signer.id, strings);
  const fileCount = totalFiles(copiesMap(docStates, docIds), docIds);

  const currentName = current ? nameOf(current) : "";
  const staleReasonOf = new Map(stale.map((item) => [item.signerId, item.reason]));
  const staleNotes = stale.map((item) => ({
    signerId: item.signerId,
    text: strings.staleSignature(signerLabel(signers, item.signerId, strings), item.reason),
  }));
  const staleAnnouncement = staleNotes.map((note) => note.text).join(" ");

  /* --- Problemas de la asignacion («Revisar antes de descargar») --- */
  const roundIssues: Issue[] = [
    ...validateAssignment({ mode: "multi", signers, docs: docStates, docOrder: docIds, blocks }).filter((found) => {
      // Los trazos que faltan los cuenta la propia ceremonia (`pending`, con sus sellos vigentes); «firma sin hueco» no
      // avisa en el grupo automatico («una firma para todos»), donde es lo esperado.
      if (found.kind === "groupWithoutStroke") return false;
      if (found.kind === "signerWithoutSlot") {
        return blocks.find((block) => block.id === found.blockId)?.auto !== true;
      }
      return true;
    }),
  ];
  const fixFor = (issue: Issue): (() => void) | undefined => {
    const target = fixTargetOf(issue);
    if (target.step === "turn") {
      const index = queue.findIndex((signer) => signer.id === target.signerId);
      return index === -1 ? undefined : () => goToTurn(index, "capture");
    }
    return onFix ? () => onFix(target) : undefined;
  };
  const issueViews: ReviewIssueView[] = roundIssues.map((found, index) => ({
    key: `${found.kind}|${found.signerId ?? ""}|${found.docId ?? ""}|${found.blockId ?? ""}|${index}`,
    severity: found.severity,
    text: issueText(found, { signers, docs, blocks }, strings),
    onFix: fixFor(found),
  }));
  const hasBlockingIssue = issueViews.some((found) => found.severity === "blocking");
  const reviewVisible = queue.length > 0 && pending.length === 0;
  /**
   * Ultimo firmante y nada pendiente ni bloqueante: «Revisar» y «Descargar» son UNA sola pantalla (la tarjeta de abajo ya trae la
   * revision completa y el boton «Firmar y descargar»); la tarjeta de revision del turno solo duplicaria el toque (W3-B2).
   */
  const merged = current !== null && shownStage === "review" && !othersPending && pending.length === 0 && !blocked && !hasBlockingIssue;
  /** Lo que se va a firmar y rellenar, para el resumen del turno. */
  const turnCounts = current ? signerSlotCounts(docIds.map((docId) => fieldsOfDoc(ctx, docId)), current.id) : { signatures: 0, initials: 0 };
  const filledFields = filledFieldCount(docIds.map((docId) => ({ textFields: docStates[docId]?.textFields ?? [], textValues: docStates[docId]?.textValues ?? {} })));
  const editTurn = onFix && docs[0] ? () => onFix({ step: "document", docId: docs[0].id }) : undefined;
  const finishReasonId = `${composeIdBase}-finish-reason`;
  // Los bloques con algo que firmar, en el orden en que se muestran.
  const currentBlocks = current
    ? signerBlocks(blocks, current.id).filter(
        (block) => blockRequiredTypes(block, ctx).length > 0,
      )
    : [];
  const ready = currentBlocks.every((block) => isBlockComplete(block, ctx));
  const progress = current ? turnProgress(blocks, current.id, ctx) : [];
  const missing = progress.filter((item) => !item.done);
  /** «Firma A» / «Iniciales B»; con un solo grupo, «Firma» / «Iniciales». */
  const itemTextIn = (item: (typeof progress)[number], nextBlocks: readonly SignerBlock[]) => {
    const label = captureTypeLabel(item.type, strings);
    const letter = currentBlocks.length > 1 ? blockGroups(nextBlocks, docIds, signers)[item.blockId] : undefined;
    return letter ? `${label} ${letter}` : label;
  };
  const itemLabel = (item: (typeof progress)[number]) => itemTextIn(item, blocks);
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
        : strings.ceremonyMissing(left.map((item) => itemTextIn(item, nextBlocks))),
    );
  };
  const scopeBlock = blocks.find((block) => block.id === scopeBlockId) ?? null;
  const composerBlock = composer
    ? (blocks.find((block) => block.id === composer.blockId) ?? null)
    : null;
  const vaultBlock = vaultFor
    ? (blocks.find((block) => block.id === vaultFor.blockId) ?? null)
    : null;

  const blockTitle = groupTitle;

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

  /**
   * «Firmar todo con mi firma guardada»: con UN toque, firma e iniciales del baul van a TODOS los grupos del firmante (todos sus
   * huecos de todos los documentos). Solo se rellena lo que falta (lo ya vigente no se pisa) y lo que la entrada no trae se pide
   * aparte. Si no falta nada, la persona pasa a la revision: ve como queda antes de seguir. Nada se descarga aqui.
   */
  const applyQuick = (entry: VaultEntry) => {
    if (!current) return;
    const target = signerBlocks(blocks, current.id)
      .filter((block) => blockRequiredTypes(block, ctx).length > 0)
      .find((block) => !isBlockComplete(block, ctx));
    if (!target) return;
    const all = savedDraftsOf(entry);
    const saved = {
      signature: visibleDraft(target, "signature", ctx) ? null : all.signature,
      initials: visibleDraft(target, "initials", ctx) ? null : all.initials,
    };
    const result = applySavedToBlocks(blocks, target.id, saved, true, ctx);
    setQuickUndo({ signerId: current.id, blocks: [...blocks] });
    setUsedEntries((previous) => ({ ...previous, [current.id]: entry.id }));
    onBlocksChange(result.blocks);
    announceProgress(result.blocks);
    void touchVaultEntry(entry.id);
    const left = turnProgress(result.blocks, current.id, ctx).filter((item) => !item.done);
    const labels = [...new Set(left.map((item) => captureTypeLabel(item.type, strings)))];
    const nextStage: Stage = left.length === 0 ? "review" : "capture";
    showVaultNotice(current.id, nextStage, {
      text: left.length === 0 ? quick.applied(entry.signerName) : quick.appliedMissing(entry.signerName, labels),
      tone: left.length === 0 ? "success" : "info",
    });
    setStage(nextStage);
  };

  /** «Deshacer»: devuelve los trazos del firmante a como estaban antes del toque y vuelve a la captura. */
  const undoQuickSign = () => {
    if (!quickUndo || !current || quickUndo.signerId !== current.id) return;
    onBlocksChange(quickUndo.blocks);
    setUsedEntries((previous) => {
      const { [current.id]: removed, ...rest } = previous;
      void removed;
      return rest;
    });
    setQuickUndo(null);
    setLiveMessage(quick.undone);
    setStage("capture");
  };

  const editScope = (blockId: string, scope: DocId[]) => {
    const edit = changeBlockScope(blocks, blockId, scope, docs, strings);
    if (edit.blocks === blocks) return;
    onBlocksChange(edit.blocks);
    const edited = edit.blocks.find((candidate) => candidate.id === blockId);
    // Con grupos se dice «Firma A — para: ...», no «Bloque 1: aplica a ...».
    const letter = blockGroups(edit.blocks, docIds, signers)[blockId];
    setLiveMessage(
      edited && letter
        ? strings.assignment.groupFor(strings.assignment.group(letter), groupDocsText(edited, docs))
        : edit.message,
    );
  };

  /** Sube o baja el turno de un firmante; el turno de ahora sigue al primero pendiente del orden nuevo. */
  const moveSigner = (signerId: string, delta: -1 | 1) => {
    const next = moveTurn(
      queue.map((signer) => signer.id),
      signerId,
      delta,
    );
    if (!next || !onTurnOrderChange) return;
    onTurnOrderChange(next);
    const nextQueue = orderedQueue(queue, next);
    if (stage === "handoff") {
      onCeremonyChange?.(
        ceremonyAt(nextQueue, firstPendingTurn(nextQueue, (id) => isSignerDone(blocks, id, ctx)), "handoff"),
      );
    }
    const moved = signers.find((signer) => signer.id === signerId);
    if (moved) setLiveMessage(strings.assignment.orderMoved(nameOf(moved), next.indexOf(signerId) + 1, next.length));
  };

  /** «Firma A — para: Contrato, Anexo» y el boton para cambiar los documentos del grupo. */
  const scopeLine = (block: SignerBlock) => (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <p className="min-w-0 flex-1 text-footnote font-semibold text-foreground [overflow-wrap:anywhere]">
        {strings.assignment.groupFor(blockTitle(block), groupDocsText(block, docs))}
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

  const quickCard =
    proposal && current && shownStage !== "review" ? (
      <QuickSignCard
        proposal={proposal}
        signerName={currentName}
        counts={turnCounts}
        onApply={applyQuick}
        onChooseOther={
          vaultEnabled
            ? () => {
                const target = currentBlocks.find((block) => !isBlockComplete(block, ctx)) ?? currentBlocks[0];
                if (!target) return;
                const missingType = needTypes[0] ?? "signature";
                setVaultNoticeState(null);
                setVaultFor({ blockId: target.id, type: missingType });
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
            {strings.captureTitle(currentName)}
          </h4>
          {/* Lo primero: firmar con la firma guardada es el camino corto; crear una firma nueva queda debajo. */}
          {quickCard ? <div className="mt-3">{quickCard}</div> : null}
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {strings.blockCaptureBody}
          </p>
          {/* Con una sola persona no hay traspaso: se dice por que, y el resumen del turno deja corregir lo decidido. */}
          {soleSigner && stage === "handoff" ? (
            <p className="mt-2 text-footnote text-muted-foreground" data-sole-signer="">
              {quick.singleSigner}
            </p>
          ) : null}
          <CeremonySummary counts={turnCounts} fields={filledFields} onEdit={editTurn} className="mt-2" />

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

      {current && shownStage === "review" && !merged ? (
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
                <p className="text-footnote font-semibold text-foreground [overflow-wrap:anywhere]">
                  {strings.assignment.groupFor(blockTitle(block), groupDocsText(block, docs))}
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
            {quickUndo && quickUndo.signerId === current.id ? (
              <Button variant="secondary" size="md" wrap onClick={undoQuickSign} data-quick-sign-undo="">
                {quick.undo}
              </Button>
            ) : (
              <Button variant="secondary" size="md" wrap onClick={() => setStage("capture")}>
                {strings.reviewRedo}
              </Button>
            )}
          </div>
        </div>
      ) : null}

      {/* Estado de la ronda y orden de los turnos */}
      {queue.length > 1 && onTurnOrderChange ? (
        <div>
          <h4 className="ui-label text-muted-foreground">{strings.assignment.orderTitle}</h4>
          <p className="mt-1 text-footnote leading-relaxed text-muted-foreground">{strings.assignment.orderHint}</p>
        </div>
      ) : null}
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
                {queue.length > 1 && onTurnOrderChange ? (
                  <span className="mr-1.5 tabular-nums text-muted-foreground" aria-hidden="true">
                    {index + 1}.
                  </span>
                ) : null}
                {nameOf(signer)}
              </span>
              {queue.length > 1 && onTurnOrderChange ? (
                <span className="flex items-center gap-1 pointer-coarse:gap-2">
                  <button
                    type="button"
                    className={TURN_ARROW}
                    aria-label={strings.assignment.orderMoveUp(nameOf(signer))}
                    disabled={index === 0}
                    onClick={() => moveSigner(signer.id, -1)}
                  >
                    <ChevronUp aria-hidden="true" className="size-4" />
                  </button>
                  <button
                    type="button"
                    className={TURN_ARROW}
                    aria-label={strings.assignment.orderMoveDown(nameOf(signer))}
                    disabled={index === queue.length - 1}
                    onClick={() => moveSigner(signer.id, 1)}
                  >
                    <ChevronDown aria-hidden="true" className="size-4" />
                  </button>
                </span>
              ) : null}
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
          id={balanceId}
          ref={current && !merged ? undefined : headingRef}
          tabIndex={-1}
          className={cn("text-headline text-foreground", CEREMONY_HEADING_CLASS)}
        >
          {merged ? quick.finalTitle : pending.length === 0 && !blocked ? strings.allSignedTitle : strings.ceremonyTitle}
        </h4>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {merged
            ? quick.finalBody(docs.length)
            : pending.length === 0 && !blocked
              ? strings.batchReadyBody(docs.length)
              : pending.length > 0
                ? strings.pendingBody(pending.length)
                : strings.deliveryBlockedTitle}
        </p>
        {/* Pantalla unica «Revisar y descargar»: lo que firmo la persona del turno, a la vista junto al boton. */}
        {merged ? (
          <div className="mt-3 space-y-3" data-merged-review="">
            {currentBlocks.map((block) => (
              <div key={block.id} className="space-y-2">
                {showHeadings ? (
                  <p className="text-footnote font-semibold text-foreground [overflow-wrap:anywhere]">
                    {strings.assignment.groupFor(blockTitle(block), groupDocsText(block, docs))}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-3">
                  {blockRequiredTypes(block, ctx).map((type) => {
                    const draft = visibleDraft(block, type, ctx);
                    return draft ? <ReviewFigure key={type} type={type} draft={draft} strings={strings} /> : null;
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {/* Todo lo que hace falta ya esta recogido (quiza antes de poner los campos): se dice claro y no se pide nada. */}
        {pending.length === 0 && queue.length > 0 && !blocked ? (
          <p data-all-covered="" className="mt-2 text-footnote font-medium leading-relaxed text-foreground">
            {strings.early.allCovered}
          </p>
        ) : null}
        {blocked && blockerMessages.length > 0 ? (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-footnote text-destructive-text">
            {blockerMessages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : null}
        <ReviewBeforeDownload
          mode={reviewVisible ? "full" : "issues"}
          className="mt-4"
          strings={strings}
          signers={signers}
          docs={docs}
          docStates={docStates}
          blocks={blocks}
          ctx={ctx}
          files={files}
          issues={issueViews}
          fileCount={fileCount}
          onGoToPage={onGoToPage}
        />
        {hasBlockingIssue ? (
          <p id={finishReasonId} className="mt-3 text-footnote text-destructive-text">
            {strings.review.disabledBecause}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="lg"
            wrap
            disabled={blocked || pending.length > 0 || queue.length === 0 || busy || hasBlockingIssue}
            aria-describedby={hasBlockingIssue ? finishReasonId : undefined}
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
              let cleared = blocks;
              // Solo quien esta en la cola: lo recogido de quien aun no tiene campos no se toca.
              const inQueue = new Set(queue.map((signer) => signer.id));
              for (const block of blocks) if (inQueue.has(block.signerId)) cleared = clearBlock(cleared, block.id);
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
        titleOf={groupTitle}
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
