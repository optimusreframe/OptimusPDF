"use client";

import { useEffect, useRef, useState, type Ref } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { cn } from "@/lib/cn";
import { BlockScopeSheet } from "@/app/sign-pdf/BlockScopeSheet";
import {
  docLabel,
  scopeSummary,
  signerBlocks,
  signerLabel,
  type DocRef,
} from "@/app/sign-pdf/blockModel";
import type { CoverageIssue, DocId, SignMode, SignerBlock } from "@/app/sign-pdf/docSet";
import type { SignStrings } from "@/app/sign-pdf/strings";
import type { Signer } from "@/lib/pdf/sign";

/*
 * Piezas de la interfaz de bloques de la Wave 4 (U3): el control global
 * «mismas firmas / firmas distintas», la lista de bloques de un firmante
 * (se pinta DENTRO de su tarjeta en `SignerManager`) y los avisos de
 * cobertura. Solo aparecen con mas de un documento.
 */

/** Objetivo de toque de 44 px con puntero grueso (el `sm` mide 36 px). */
const COARSE_TALL = "pointer-coarse:h-11 pointer-coarse:before:hidden";

/* ------------------------------------------------------------------ *
 * Control global
 * ------------------------------------------------------------------ */

export type SignModeControlProps = {
  /** Para llevar el foco al segmento activo (p. ej. tras «Deshacer»). */
  containerRef?: Ref<HTMLElement>;
  value: SignMode;
  onChange: (mode: SignMode) => void;
  strings: SignStrings;
};

/** «Mismas firmas» / «Firmas distintas por documento», con su explicacion debajo. */
export function SignModeControl({
  containerRef,
  value,
  onChange,
  strings,
}: SignModeControlProps) {
  return (
    <section ref={containerRef} className="space-y-2">
      <SegmentedControl<SignMode>
        label={strings.signModeLabel}
        value={value}
        onChange={onChange}
        options={[
          { value: "same", label: strings.signModeSame },
          { value: "independent", label: strings.signModeIndependent },
        ]}
      />
      <p className="text-footnote leading-relaxed text-muted-foreground">
        {value === "same" ? strings.signModeSameHint : strings.signModeIndependentHint}
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Bloques de un firmante
 * ------------------------------------------------------------------ */

/** Lo que `SignerManager` necesita para pintar y editar los bloques (solo con varios documentos). */
export type SignerBlocksApi = {
  docs: readonly DocRef[];
  blocks: readonly SignerBlock[];
  /** Fija el alcance de un bloque (la logica del invariante vive en quien lo recibe). */
  onChangeScope: (blockId: string, docIds: DocId[]) => void;
  /** Con `docId` (cobertura), el bloque nuevo cubre ESE documento. */
  onAddBlock: (signerId: string, docId?: DocId) => void;
  /** Documentos con huecos del firmante que ningun bloque cubre (bloqueante). */
  issues?: readonly CoverageIssue[];
  onRemoveBlock: (blockId: string) => void;
};

export type SignerBlockListProps = {
  signer: Signer;
  signers: readonly Signer[];
  api: SignerBlocksApi;
  strings: SignStrings;
};

/**
 * Bloques de UN firmante: una fila por bloque con su resumen «Aplica a: …» y
 * «Cambiar» (abre la hoja de alcance), «Quitar bloque» (si hay mas de uno) y
 * «Añadir bloque». Un bloque sin documentos no existe: «Añadir» parte un
 * bloque con al menos dos documentos, y se desactiva cuando cada documento
 * ya tiene el suyo.
 */
export function SignerBlockList({
  signer,
  signers,
  api,
  strings,
}: SignerBlockListProps) {
  const own = signerBlocks(api.blocks, signer.id);
  const name = signerLabel(signers, signer.id, strings);
  const [scopeBlockId, setScopeBlockId] = useState<string | null>(null);
  const scopeBlock = own.find((block) => block.id === scopeBlockId) ?? null;
  // Se puede anadir si hay un bloque que partir o si falta cobertura (un
  // documento con huecos de este firmante sin bloque): en ese caso el bloque
  // nuevo cubre justo ese documento.
  const gap = api.issues?.find((issue) => issue.signerId === signer.id);
  const canAdd = gap !== undefined || own.some((block) => block.appliesTo.length >= 2);

  const rootRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  /** Lo que se hizo con el teclado/raton y exige llevar el foco (el boton pulsado cambia de sitio o desaparece). */
  const focusRequest = useRef<"added" | "removed" | null>(null);
  const knownIds = useRef<string[]>(own.map((block) => block.id));
  const ownIds = own.map((block) => block.id);
  const idsKey = ownIds.join("|");

  useEffect(() => {
    const previous = knownIds.current;
    knownIds.current = ownIds;
    const request = focusRequest.current;
    if (!request) return;
    focusRequest.current = null;
    const root = rootRef.current;
    if (!root) return;
    if (request === "added") {
      const fresh = ownIds.find((id) => !previous.includes(id));
      root
        .querySelector<HTMLElement>(`[data-block-scope="${fresh}"]`)
        ?.focus({ preventScroll: true });
      return;
    }
    const target =
      addRef.current && !addRef.current.disabled
        ? addRef.current
        : root.querySelector<HTMLElement>("[data-block-scope]");
    target?.focus({ preventScroll: true });
    // `ownIds` se deriva de `idsKey`: basta con la clave.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  return (
    <div ref={rootRef} role="group" aria-label={strings.signerBlocksLabel(name)} className="space-y-2">
      <ul className="space-y-2">
        {own.map((block, index) => (
          <li
            key={block.id}
            className="rounded-ios-sm border border-white/10 bg-white/5 p-3"
          >
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
              <div className="min-w-0 flex-1">
                <p className="text-footnote font-semibold text-foreground">
                  {strings.blockName(index + 1)}
                </p>
                <p className="text-footnote text-muted-foreground [overflow-wrap:anywhere]">
                  {strings.blockAppliesTo(scopeSummary(block, api.docs, strings))}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-1.5">
                <Button
                  variant="secondary"
                  size="sm"
                  className={COARSE_TALL}
                  data-block-scope={block.id}
                  aria-label={strings.blockChangeScopeFor(strings.blockName(index + 1), name)}
                  onClick={() => setScopeBlockId(block.id)}
                >
                  {strings.blockChangeScope}
                </Button>
                {own.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={COARSE_TALL}
                    aria-label={strings.blockRemoveFor(strings.blockName(index + 1), name)}
                    onClick={() => {
                      focusRequest.current = "removed";
                      api.onRemoveBlock(block.id);
                    }}
                  >
                    {strings.blockRemove}
                  </Button>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          ref={addRef}
          variant="ghost"
          size="sm"
          className={COARSE_TALL}
          disabled={!canAdd}
          aria-label={strings.blockAddFor(name)}
          onClick={() => {
            focusRequest.current = "added";
            api.onAddBlock(signer.id, gap?.docId);
          }}
        >
          <Plus aria-hidden="true" className="size-4" />
          {strings.blockAdd}
        </Button>
        {!canAdd ? (
          <p className="text-caption text-muted-foreground">{strings.blockAddFull}</p>
        ) : null}
      </div>

      <BlockScopeSheet
        open={scopeBlockId !== null}
        onClose={() => setScopeBlockId(null)}
        block={scopeBlock}
        blocks={api.blocks}
        signerName={name}
        docs={api.docs}
        strings={strings}
        closeLabel={strings.confirmClose}
        onApply={api.onChangeScope}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Cobertura
 * ------------------------------------------------------------------ */

export type CoverageNoticesProps = {
  issues: readonly CoverageIssue[];
  signers: readonly Signer[];
  docs: readonly DocRef[];
  onAddBlock: (signerId: string, docId: DocId) => void;
  strings: SignStrings;
  className?: string;
};

/**
 * «Falta el bloque de Ana para Contrato A» + «Añadir bloque para Contrato A».
 * Bloqueante: mientras haya alguno no se puede descargar. La region viva esta
 * siempre montada para que lo que aparece (o se resuelve) se anuncie.
 */
export function CoverageNotices({
  issues,
  signers,
  docs,
  onAddBlock,
  strings,
  className,
}: CoverageNoticesProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(issues.length > 0 ? "space-y-2" : "sr-only", className)}
    >
      {issues.map((issue) => {
        const doc = docLabel(docs.find((candidate) => candidate.id === issue.docId)?.name ?? issue.docId);
        return (
          <div
            key={`${issue.signerId}|${issue.docId}`}
            className="flex flex-wrap items-center justify-between gap-2 rounded-ios-sm border border-destructive/30 bg-destructive/10 px-3 py-2"
          >
            <p className="min-w-0 flex-1 text-footnote text-destructive-text [overflow-wrap:anywhere]">
              {strings.coverageMissing(signerLabel(signers, issue.signerId, strings), doc)}
            </p>
            <Button
              variant="secondary"
              size="sm"
              className={COARSE_TALL}
              onClick={() => onAddBlock(issue.signerId, issue.docId)}
            >
              {strings.coverageAddBlock(doc)}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
