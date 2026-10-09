"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Sheet } from "@/components/ui/Sheet";
import {
  blockNumber,
  docLabel,
  type DocRef,
} from "@/app/sign-pdf/blockModel";
import type { DocId, SignerBlock } from "@/app/sign-pdf/docSet";
import type { SignStrings } from "@/app/sign-pdf/strings";

export type BlockScopeSheetProps = {
  open: boolean;
  onClose: () => void;
  /** Bloque cuyo alcance se edita; `null` mientras la hoja esta cerrada. */
  block: SignerBlock | null;
  /** Todos los bloques (para avisar de que documentos le quitaria a otro bloque del mismo firmante). */
  blocks: readonly SignerBlock[];
  signerName: string;
  docs: readonly DocRef[];
  strings: SignStrings;
  closeLabel: string;
  /** Fija el alcance (la hoja se cierra despues). */
  onApply: (blockId: string, docIds: DocId[]) => void;
};

/**
 * Alcance de un bloque: casillas nativas por documento y «Todos». Se edita un
 * borrador y no se aplica hasta pulsar «Aplicar»: asi un alcance vacio (que no
 * existe) no llega a escribirse y se ve, antes de aplicar, que documentos le
 * quitaria a otro bloque del mismo firmante (el invariante «un documento, como
 * mucho un bloque por firmante»).
 */
export function BlockScopeSheet({
  open,
  onClose,
  block,
  blocks,
  signerName,
  docs,
  strings,
  closeLabel,
  onApply,
}: BlockScopeSheetProps) {
  return (
    <Sheet
      open={open && block !== null}
      onClose={onClose}
      title={
        block
          ? strings.scopeSheetTitle(
              strings.blockName(blockNumber(blocks, block.id)),
              signerName,
            )
          : undefined
      }
      closeLabel={closeLabel}
    >
      {block ? (
        <ScopeForm
          // Un borrador nuevo por bloque y por apertura.
          key={block.id}
          block={block}
          blocks={blocks}
          docs={docs}
          strings={strings}
          onCancel={onClose}
          onApply={(docIds) => {
            onApply(block.id, docIds);
            onClose();
          }}
        />
      ) : null}
    </Sheet>
  );
}

type ScopeFormProps = {
  block: SignerBlock;
  blocks: readonly SignerBlock[];
  docs: readonly DocRef[];
  strings: SignStrings;
  onCancel: () => void;
  onApply: (docIds: DocId[]) => void;
};

function ScopeForm({ block, blocks, docs, strings, onCancel, onApply }: ScopeFormProps) {
  const [selected, setSelected] = useState<ReadonlySet<DocId>>(
    () => new Set(block.appliesTo),
  );
  const allSelected = docs.every((doc) => selected.has(doc.id));

  const toggle = (docId: DocId, checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(docId);
      else next.delete(docId);
      return next;
    });
  };

  // Lo que este alcance le quitaria a OTRO bloque del mismo firmante.
  const previews: string[] = [];
  for (const doc of docs) {
    if (!selected.has(doc.id) || block.appliesTo.includes(doc.id)) continue;
    const owner = blocks.find(
      (other) =>
        other.id !== block.id &&
        other.signerId === block.signerId &&
        other.appliesTo.includes(doc.id),
    );
    if (owner) {
      previews.push(
        strings.scopeMovePreview(docLabel(doc.name), blockNumber(blocks, owner.id)),
      );
    }
  }

  const empty = selected.size === 0;

  return (
    <div className="space-y-4 pb-2">
      <p className="text-subheadline text-muted-foreground">
        {strings.scopeSheetIntro}
      </p>

      <fieldset className="space-y-1">
        <legend className="ui-label pb-1 text-muted-foreground">
          {strings.scopeDocsLabel}
        </legend>
        <Checkbox
          label={strings.scopeAllLabel}
          checked={allSelected}
          onChange={(checked) =>
            setSelected(checked ? new Set(docs.map((doc) => doc.id)) : new Set())
          }
        />
        <ul className="space-y-0.5 border-l border-white/10 pl-3">
          {docs.map((doc) => (
            <li key={doc.id}>
              <Checkbox
                label={docLabel(doc.name)}
                checked={selected.has(doc.id)}
                onChange={(checked) => toggle(doc.id, checked)}
              />
            </li>
          ))}
        </ul>
      </fieldset>

      {/* Region de estado siempre montada: solo cambia su contenido. */}
      <div role="status" aria-live="polite" className="space-y-1">
        {empty ? (
          <p className="text-footnote text-destructive-text">{strings.scopeEmpty}</p>
        ) : null}
        {previews.map((text) => (
          <p key={text} className="text-footnote text-muted-foreground">
            {text}
          </p>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          size="md"
          disabled={empty}
          onClick={() =>
            onApply(docs.filter((doc) => selected.has(doc.id)).map((doc) => doc.id))
          }
        >
          {strings.scopeApply}
        </Button>
        <Button variant="ghost" size="md" onClick={onCancel}>
          {strings.confirmCancel}
        </Button>
      </div>
    </div>
  );
}
