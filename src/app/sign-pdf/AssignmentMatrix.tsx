"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Minus, Plus, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { cn } from "@/lib/cn";
import {
  allSameGroup,
  applyMatrix,
  groupsMatrix,
  matrixEqual,
  oneGroupPerDocument,
  summarize,
  type AssignmentMatrix as Matrix,
  type MatrixApplication,
} from "@/app/sign-pdf/assignment";
import {
  cycleCell,
  describeImpacts,
  groupsInHalves,
  signModeFor,
  stepAllCopies,
  stepCopies,
  totalFiles,
  uniformCopies,
  type ImpactLine,
} from "@/app/sign-pdf/assignmentUi";
import { issueText } from "@/app/sign-pdf/assignmentIssues";
import type { Issue } from "@/app/sign-pdf/assignmentValidation";
import { docLabel, signerLabel, type DocRef } from "@/app/sign-pdf/blockModel";
import type { DocId, SignMode, SignerBlock } from "@/app/sign-pdf/docSet";
import type { SignStrings } from "@/app/sign-pdf/strings";
import { MAX_COPIES, MAX_OUTPUT_FILES } from "@/lib/pdf/signCopies";
import type { Signer } from "@/lib/pdf/sign";

/*
 * «¿Quien firma que?» (Firma agil · Fase 1 · U1.2): sustituye a «Mismas / Distintas» con varios documentos. Una tabla
 * documentos x firmantes en la que cada celda es un chip con la letra del grupo de firma (A, B...) o «—» (no firma ahi);
 * tocar la celda pasa a la siguiente opcion. Los atajos de arriba dejan la tabla hecha de un toque, la columna «Copias»
 * dice cuantos archivos se entregan de cada documento y debajo hay un resumen en lenguaje natural.
 *
 * La tabla no guarda nada propio: se DERIVA de los bloques (`groupsMatrix`) y cada cambio los reescribe
 * (`applyMatrix`), asi que borradores, sesiones y la ceremonia siguen hablando de bloques. Si un cambio se llevaria
 * trazos ya recogidos, se pide confirmacion. «Deshacer» recuerda los ultimos cambios (pila corta).
 *
 * Una celda es un boton de 44 px; las flechas mueven el foco entre celdas (rejilla ARIA con un unico punto de tabulacion)
 * y con ancho estrecho cada fila se convierte en una tarjeta (nombre del documento, una celda por firmante con su nombre
 * al lado, copias) sin desplazamiento horizontal. Los anuncios van a la region viva de quien la monta (`onAnnounce`).
 */

/** Cuantos cambios recuerda «Deshacer». */
const UNDO_DEPTH = 5;

/** Cambio que la tabla pide al anfitrion; todo lo que trae se escribe junto (un solo guardado). */
export type AssignmentChange = {
  blocks: SignerBlock[];
  signMode: SignMode;
  /** Copias por documento (solo cuando cambiaron). */
  copies?: Record<DocId, number>;
};

type Snapshot = {
  blocks: readonly SignerBlock[];
  copies: Readonly<Record<DocId, number>>;
  /** El modo de la sesion en ese momento: «Deshacer» lo devuelve tal cual (un borrador antiguo puede traer uno que la tabla no deduciria). */
  signMode: SignMode;
};
type UndoEntry = { before: Snapshot; after: Snapshot };

type PendingChange = {
  application: MatrixApplication;
  matrix: Matrix;
  lines: ImpactLine[];
  announce: string;
};

export type AssignmentMatrixProps = {
  signers: readonly Signer[];
  /** Documentos de la ronda en el orden de la cola. */
  docs: readonly DocRef[];
  blocks: readonly SignerBlock[];
  /** `signMode` de la sesion ahora mismo (ver `Snapshot.signMode`). */
  signMode: SignMode;
  /** Copias de cada documento (1..5). */
  copies: Readonly<Record<DocId, number>>;
  /** Problemas de `validateAssignment` que se ensenan aqui (huecos sin firmante, documentos sin firmante, exceso de archivos...). */
  issues: readonly Issue[];
  onChange: (change: AssignmentChange) => void;
  onAnnounce: (text: string) => void;
  strings: SignStrings;
};

function sameCopies(a: Readonly<Record<DocId, number>>, b: Readonly<Record<DocId, number>>, ids: readonly DocId[]): boolean {
  return ids.every((id) => (a[id] ?? 1) === (b[id] ?? 1));
}

/** Documento y firmante de una celda -> clave estable para refs y atributos. */
const cellKey = (row: number, col: number) => `${row}:${col}`;

export function AssignmentMatrix({
  signers,
  docs,
  blocks,
  signMode,
  copies,
  issues,
  onChange,
  onAnnounce,
  strings,
}: AssignmentMatrixProps) {
  const text = strings.assignment;
  const titleId = useId();
  const hintId = useId();
  const groupsHintId = useId();
  const docIds = docs.map((doc) => doc.id);
  const matrix = groupsMatrix(blocks, docIds, signers);
  const nameOf = (signer: Signer) => signerLabel(signers, signer.id, strings);
  const docName = (docId: DocId) => docLabel(docs.find((doc) => doc.id === docId)?.name ?? docId);

  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [focusCell, setFocusCell] = useState({ row: 0, col: 0 });
  const [copiesNote, setCopiesNote] = useState("");
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  const copiesRef = useRef<HTMLDivElement>(null);

  const current: Snapshot = { blocks, copies, signMode };
  const top = undoStack[undoStack.length - 1];
  const canUndo =
    top !== undefined && top.after.blocks === blocks && sameCopies(top.after.copies, copies, docIds);

  const files = totalFiles(copies, docIds);
  const uniform = uniformCopies(copies, docIds);

  /** Escribe un cambio y lo recuerda para «Deshacer». */
  const commit = (next: Pick<Snapshot, "blocks" | "copies">, announce: string) => {
    const stale = top !== undefined && !canUndo;
    const nextMode = signModeFor(groupsMatrix(next.blocks, docIds, signers));
    setUndoStack((stack) =>
      [...(stale ? [] : stack), { before: current, after: { ...next, signMode: nextMode } }].slice(-UNDO_DEPTH),
    );
    const copiesChanged = !sameCopies(next.copies, copies, docIds);
    onChange({
      blocks: next.blocks as SignerBlock[],
      signMode: nextMode,
      ...(copiesChanged ? { copies: { ...next.copies } } : {}),
    });
    if (announce) onAnnounce(announce);
  };

  /** Aplica una tabla nueva; si se llevaria trazos ya recogidos, antes pide confirmacion. */
  const applyTable = (nextMatrix: Matrix, announce: string) => {
    if (matrixEqual(nextMatrix, matrix)) return;
    const application = applyMatrix(blocks, nextMatrix, signers);
    const lines = describeImpacts(application.impacts, blocks, docIds, signers);
    if (lines.length > 0) {
      setPending({ application, matrix: nextMatrix, lines, announce });
      return;
    }
    commit({ blocks: application.blocks, copies }, announce);
  };

  const tapCell = (docId: DocId, signer: Signer) => {
    const { matrix: next, lastCell } = cycleCell(matrix, docId, signer.id);
    if (lastCell) {
      onAnnounce(text.lastSignerCell(nameOf(signer)));
      return;
    }
    const row = next.docIds.indexOf(docId);
    const col = next.signerIds.indexOf(signer.id);
    const group = next.cells[row]?.[col] ?? null;
    applyTable(next, text.cellChanged(nameOf(signer), docName(docId), group === null ? null : text.group(group)));
  };

  const shortcut = (label: string, build: (m: Matrix) => Matrix) =>
    applyTable(build(matrix), text.shortcutApplied(label));

  const stepDoc = (docId: DocId, delta: 1 | -1) => {
    const step = stepCopies(copies, docIds, docId, delta);
    if (step.blocked !== "none") {
      const note = step.blocked === "perDocument" ? text.copiesAtMax(MAX_COPIES) : text.filesAtMax(MAX_OUTPUT_FILES);
      setCopiesNote(note);
      onAnnounce(note);
      return;
    }
    setCopiesNote("");
    commit({ blocks, copies: { ...copies, [docId]: step.value } }, text.copiesChanged(docName(docId), step.value));
  };

  const stepAll = (delta: 1 | -1) => {
    const step = stepAllCopies(copies, docIds, delta);
    if (step.blocked !== "none") {
      const note = step.blocked === "perDocument" ? text.copiesAtMax(MAX_COPIES) : text.filesAtMax(MAX_OUTPUT_FILES);
      setCopiesNote(note);
      onAnnounce(note);
      return;
    }
    setCopiesNote("");
    commit({ blocks, copies: step.copies }, text.allCopiesChanged(step.value));
  };

  const undo = () => {
    if (!top || !canUndo) return;
    setUndoStack((stack) => stack.slice(0, -1));
    setCopiesNote("");
    const copiesChanged = !sameCopies(top.before.copies, copies, docIds);
    onChange({
      blocks: top.before.blocks as SignerBlock[],
      signMode: top.before.signMode,
      ...(copiesChanged ? { copies: { ...top.before.copies } } : {}),
    });
    onAnnounce(text.undone);
  };

  const confirmPending = () => {
    if (!pending) return;
    const { application, announce } = pending;
    setPending(null);
    commit({ blocks: application.blocks, copies }, announce);
  };

  const cancelPending = () => {
    if (!pending) return;
    setPending(null);
    onAnnounce(text.cancelled);
  };

  /** Flechas, Inicio y Fin entre las celdas; Espacio e Intro los da el propio boton. */
  const onGridKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-cell]");
    if (!target) return;
    const [rowText, colText] = (target.dataset.cell ?? "0:0").split(":");
    let row = Number(rowText);
    let col = Number(colText);
    const lastRow = docIds.length - 1;
    const lastCol = signers.length - 1;
    switch (event.key) {
      case "ArrowUp":
        row = Math.max(0, row - 1);
        break;
      case "ArrowDown":
        row = Math.min(lastRow, row + 1);
        break;
      case "ArrowLeft":
        col = Math.max(0, col - 1);
        break;
      case "ArrowRight":
        col = Math.min(lastCol, col + 1);
        break;
      case "Home":
        col = 0;
        break;
      case "End":
        col = lastCol;
        break;
      default:
        return;
    }
    event.preventDefault();
    setFocusCell({ row, col });
    cellRefs.current.get(cellKey(row, col))?.focus();
  };

  const focusIssue = (issue: Issue) => {
    const row = issue.docId ? Math.max(0, docIds.indexOf(issue.docId)) : 0;
    const col = issue.signerId ? Math.max(0, signers.findIndex((signer) => signer.id === issue.signerId)) : 0;
    if (issue.kind === "tooManyFiles") {
      copiesRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
      return;
    }
    setFocusCell({ row, col });
    cellRefs.current.get(cellKey(row, col))?.focus();
  };

  const summary = summarize(
    matrix,
    signers.map((signer) => ({ id: signer.id, name: nameOf(signer) })),
    docs.map((doc) => ({ id: doc.id, name: docLabel(doc.name) })),
    copies,
  );
  const issueNames = { signers, docs, blocks };
  const cols = `minmax(0,1fr) repeat(${Math.max(1, signers.length)}, 4.5rem) 9rem`;

  if (signers.length === 0) {
    return (
      <section aria-labelledby={titleId} className="surface-card rounded-ios space-y-2 p-4 sm:p-5">
        <h3 id={titleId} className="ui-label text-muted-foreground">
          {text.title}
        </h3>
        <p className="text-footnote leading-relaxed text-muted-foreground">{text.summaryNoSigners}</p>
      </section>
    );
  }

  return (
    <section aria-labelledby={titleId} className="surface-card rounded-ios space-y-4 p-4 sm:p-5">
      <div>
        <h3 id={titleId} className="ui-label text-muted-foreground">
          {text.title}
        </h3>
        <p id={hintId} className="mt-2 text-footnote leading-relaxed text-muted-foreground">
          {text.hint}
        </p>
      </div>

      <div role="group" aria-label={text.shortcutsLabel} className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="md" wrap onClick={() => shortcut(text.shortcutAll, (m) => allSameGroup(m))}>
          {text.shortcutAll}
        </Button>
        <Button
          variant="secondary"
          size="md"
          wrap
          onClick={() => shortcut(text.shortcutPerDoc, (m) => oneGroupPerDocument(m))}
        >
          {text.shortcutPerDoc}
        </Button>
        <Button
          variant="secondary"
          size="md"
          wrap
          aria-describedby={groupsHintId}
          disabled={docIds.length < 2}
          onClick={() => shortcut(text.shortcutGroups, (m) => groupsInHalves(m))}
        >
          {text.shortcutGroups}
        </Button>
        <span id={groupsHintId} className="sr-only">
          {text.shortcutGroupsHint}
        </span>
        {/* Solo cuando hay algo que deshacer: un «Deshacer» apagado seria ruido (y se confundiria con otros «Deshacer» de la pantalla). */}
        {canUndo ? (
          <Button variant="ghost" size="md" wrap onClick={undo}>
            <Undo2 aria-hidden="true" className="size-4" />
            {text.undo}
          </Button>
        ) : null}
      </div>

      <div
        role="group"
        aria-label={text.allCopiesLabel}
        ref={copiesRef}
        className="flex flex-wrap items-center gap-x-3 gap-y-1"
      >
        <span className="text-footnote font-medium text-foreground">{text.allCopiesLabel}</span>
        <Stepper
          value={uniform}
          onLess={() => stepAll(-1)}
          onMore={() => stepAll(1)}
          lessLabel={text.allCopiesLess}
          moreLabel={text.allCopiesMore}
          lessDisabled={uniform === 1}
        />
      </div>

      <div
        role="grid"
        aria-label={text.tableLabel}
        aria-describedby={hintId}
        aria-rowcount={docIds.length + 1}
        aria-colcount={signers.length + 2}
        onKeyDown={onGridKeyDown}
        className="space-y-2"
        style={{ ["--assignment-cols" as string]: cols }}
      >
        {/* Cabecera: solo con tabla ancha; en tarjetas cada celda lleva el nombre de su firmante. */}
        <div
          role="row"
          className="hidden items-end gap-x-3 px-0 text-caption font-semibold text-muted-foreground sm:grid sm:grid-cols-(--assignment-cols)"
        >
          <div role="columnheader" className="min-w-0">
            {text.docColumn}
          </div>
          {signers.map((signer) => (
            <div key={signer.id} role="columnheader" className="flex min-w-0 flex-col items-center gap-1 text-center">
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-full"
                /* Color del firmante: dato del documento, no un token del tema. */
                style={{ backgroundColor: signer.color }}
              />
              <span className="max-w-full truncate" title={nameOf(signer)}>
                {nameOf(signer)}
              </span>
            </div>
          ))}
          <div role="columnheader" className="text-center">
            {text.copiesColumn}
          </div>
        </div>

        {docs.map((doc, row) => (
          <div
            key={doc.id}
            role="row"
            aria-rowindex={row + 2}
            className="rounded-ios-sm flex flex-col gap-2 border border-white/10 bg-white/5 p-3 sm:grid sm:grid-cols-(--assignment-cols) sm:items-center sm:gap-x-3 sm:rounded-none sm:border-0 sm:border-t sm:bg-transparent sm:px-0 sm:py-2"
          >
            <div
              role="rowheader"
              className="min-w-0 text-callout font-medium text-foreground [overflow-wrap:anywhere] sm:truncate"
              title={doc.name}
            >
              {docLabel(doc.name)}
            </div>
            {signers.map((signer, col) => {
              const group = matrix.cells[row]?.[col] ?? null;
              const label = text.cellLabel(nameOf(signer), docName(doc.id), group === null ? null : text.group(group));
              const focusable = focusCell.row === row && focusCell.col === col;
              return (
                <div
                  key={signer.id}
                  role="gridcell"
                  className="flex items-center justify-between gap-3 sm:justify-center"
                >
                  <span className="flex min-w-0 items-center gap-2 text-footnote text-muted-foreground sm:hidden">
                    <span
                      aria-hidden="true"
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: signer.color }}
                    />
                    <span className="[overflow-wrap:anywhere]">{nameOf(signer)}</span>
                  </span>
                  <button
                    ref={(node) => {
                      if (node) cellRefs.current.set(cellKey(row, col), node);
                      else cellRefs.current.delete(cellKey(row, col));
                    }}
                    type="button"
                    data-cell={cellKey(row, col)}
                    data-cell-doc={doc.id}
                    data-cell-signer={signer.id}
                    data-group={group ?? ""}
                    tabIndex={focusable ? 0 : -1}
                    aria-label={label}
                    title={group === null ? text.noSign : text.group(group)}
                    onFocus={() => setFocusCell({ row, col })}
                    onClick={() => tapCell(doc.id, signer)}
                    className={cn(
                      "inline-flex size-11 shrink-0 items-center justify-center rounded-ios-sm border text-callout font-semibold tabular-nums text-foreground select-none",
                      "transition-[scale,background-color,border-color] duration-[var(--duration-fast)] ease-[var(--ease-spring)] active:scale-[0.97] active:duration-[80ms]",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
                      "forced-colors:border-[ButtonText]",
                      group === null && "border-dashed border-white/25 text-muted-foreground",
                    )}
                    style={
                      group === null
                        ? undefined
                        : /* Color del firmante: dato del documento, no un token del tema. */
                          { borderColor: signer.color, backgroundColor: `${signer.color}33` }
                    }
                  >
                    <span aria-hidden="true">{group ?? "—"}</span>
                  </button>
                </div>
              );
            })}
            <div role="gridcell" className="flex items-center justify-between gap-2 sm:justify-center">
              <span className="text-footnote text-muted-foreground sm:hidden">{text.copiesColumn}</span>
              <Stepper
                value={copies[doc.id] ?? 1}
                onLess={() => stepDoc(doc.id, -1)}
                onMore={() => stepDoc(doc.id, 1)}
                lessLabel={text.copiesLess(docName(doc.id))}
                moreLabel={text.copiesMore(docName(doc.id))}
                valueLabel={text.copiesValue(docName(doc.id), copies[doc.id] ?? 1)}
                lessDisabled={(copies[doc.id] ?? 1) <= 1}
              />
            </div>
          </div>
        ))}
      </div>

      <p className="text-caption text-muted-foreground">{text.cellHint}</p>
      {copiesNote ? <p className="text-footnote text-foreground">{copiesNote}</p> : null}

      {issues.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-footnote font-semibold text-foreground">{text.issueTitleBlocking}</h4>
          <ul className="space-y-2">
            {issues.map((issue, index) => (
              <li
                key={`${issue.kind}|${issue.signerId ?? ""}|${issue.docId ?? ""}|${index}`}
                className="rounded-ios-sm flex flex-wrap items-center justify-between gap-2 border border-destructive/30 bg-destructive/10 px-3 py-2"
              >
                <span className="min-w-0 flex-1 text-footnote text-destructive-text [overflow-wrap:anywhere]">
                  {issueText(issue, issueNames, strings)}
                </span>
                <Button variant="secondary" size="sm" className="pointer-coarse:h-11 pointer-coarse:before:hidden" onClick={() => focusIssue(issue)}>
                  {text.fixIt}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="space-y-1.5 border-t border-white/10 pt-3">
        <h4 className="ui-label text-muted-foreground">{text.summaryTitle}</h4>
        <ul className="space-y-1">
          {summary.signers.map((signer) => (
            <li key={signer.signerId} className="text-subheadline leading-relaxed text-foreground [overflow-wrap:anywhere]">
              {text.summarySigner(
                signer.name,
                signer.documentCount,
                signer.groups.map((group) => ({ letter: group.group, docs: group.docNames })),
              )}
            </li>
          ))}
          {summary.unassignedDocIds.length > 0 ? (
            <li className="text-subheadline leading-relaxed text-foreground [overflow-wrap:anywhere]">
              {text.summaryNobody(summary.unassignedDocIds.map(docName))}
            </li>
          ) : null}
          <li className="text-subheadline font-medium leading-relaxed text-foreground">
            {text.summaryFiles(files)}
          </li>
        </ul>
      </div>

      <Sheet open={pending !== null} onClose={cancelPending} title={text.confirmTitle} closeLabel={strings.confirmClose}>
        <div className="space-y-3 pb-2">
          <p className="text-subheadline text-muted-foreground">{text.confirmIntro}</p>
          <ul className="list-disc space-y-1.5 pl-5 text-subheadline text-foreground">
            {(pending?.lines ?? []).map((line, index) => {
              const signer = signers.find((candidate) => candidate.id === line.signerId);
              const who = signer ? nameOf(signer) : "";
              return (
                <li key={`${line.kind}|${line.signerId}|${line.group}|${index}`}>
                  {line.kind === "lost"
                    ? text.lostLine(text.group(line.group), who, line.docs, line.strokes)
                    : text.reconfirmLine(text.group(line.group), who, line.docs)}
                </li>
              );
            })}
          </ul>
          <div className="flex flex-col gap-2 pt-1">
            <Button
              variant={pending?.lines.some((line) => line.kind === "lost") ? "destructive" : "primary"}
              size="md"
              fullWidth
              onClick={confirmPending}
            >
              {text.confirmContinue}
            </Button>
            <Button variant="secondary" size="md" fullWidth onClick={cancelPending}>
              {text.confirmCancel}
            </Button>
          </div>
        </div>
      </Sheet>
    </section>
  );
}

type StepperProps = {
  /** `null` = no todos iguales (solo el de «Copias de todos»). */
  value: number | null;
  onLess: () => void;
  onMore: () => void;
  lessLabel: string;
  moreLabel: string;
  /** Texto accesible del numero (p. ej. «Contrato: 2 copias»). */
  valueLabel?: string;
  lessDisabled?: boolean;
};

/** − / número / + de 44 px. El numero no es una region viva: los cambios se anuncian por la region unica de la herramienta. */
function Stepper({ value, onLess, onMore, lessLabel, moreLabel, valueLabel, lessDisabled }: StepperProps) {
  const button =
    "inline-flex size-11 shrink-0 items-center justify-center rounded-ios-sm border border-white/14 text-foreground " +
    "material-thin transition-[scale,background-color] duration-[var(--duration-fast)] ease-[var(--ease-spring)] active:scale-[0.97] " +
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:pointer-events-none disabled:opacity-50 " +
    "forced-colors:border-[ButtonText] forced-colors:disabled:border-[GrayText]";
  return (
    <div className="flex items-center gap-1">
      <button type="button" className={button} aria-label={lessLabel} disabled={lessDisabled} onClick={onLess}>
        <Minus aria-hidden="true" className="size-4" />
      </button>
      <span className="min-w-8 text-center text-callout font-semibold tabular-nums text-foreground">
        <span aria-hidden="true">{value ?? "·"}</span>
        {valueLabel ? <span className="sr-only">{valueLabel}</span> : null}
      </span>
      <button type="button" className={button} aria-label={moreLabel} onClick={onMore}>
        <Plus aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}
