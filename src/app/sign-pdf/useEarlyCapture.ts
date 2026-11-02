"use client";

import { useState } from "react";
import type { SignatureDraft } from "@/app/sign-pdf/SignatureComposer";
import type { SignerCaptureApi } from "@/app/sign-pdf/SignerCapture";
import { earlyStatusText } from "@/app/sign-pdf/SignerCapture";
import {
  applySavedEarly,
  applySavedSingle,
  clearSignerBlocks,
  clearSingle,
  collectSingle,
  currentCapture,
  earlyStatusBlocks,
  earlyStatusSingle,
  type EarlyGroup,
} from "@/app/sign-pdf/earlyCapture";
import {
  captureForBlock,
  rememberSource,
  signerBlocks,
  signerLabel,
  visibleDraft,
  type BlockContext,
  type DocRef,
  type SavedDrafts,
} from "@/app/sign-pdf/blockModel";
import { blockGroups } from "@/app/sign-pdf/assignment";
import { groupDocsText } from "@/app/sign-pdf/assignmentUi";
import type { DocId } from "@/app/sign-pdf/docSet";
import type { SignSession } from "@/app/sign-pdf/signSession";
import type { SessionBridge } from "@/app/sign-pdf/useSessionBridge";
import type { SignToolOptions } from "@/app/sign-pdf/SignToolClient";
import type { SignStrings } from "@/app/sign-pdf/strings";
import type { SignatureFieldType } from "@/lib/pdf/sign";

/** Lo que el hook necesita cuando hay MAS de un documento (bloques, huellas y puente de escritura de la sesion). */
export type EarlyCaptureMulti = {
  session: SignSession;
  bridge: SessionBridge;
  docs: readonly DocRef[];
  /** Huella con la que se sella cada documento (archivo + ediciones de texto); `null` = aun calculandose. */
  stampKeys: Readonly<Record<DocId, string | null>>;
};

export type EarlyCaptureArgs = {
  options: Pick<SignToolOptions, "signers" | "captures">;
  setOptions: (patch: Partial<SignToolOptions>) => void;
  /** Un documento: huella con la que se sellan las capturas (`stampKeyOf`); `null` = aun calculandose. */
  stampKey: string | null;
  /** Nombre del archivo (un documento): solo se usa para anotar de donde viene una firma guardada en el baul. */
  fileName?: string;
  multi?: EarlyCaptureMulti;
  strings: SignStrings;
};

/**
 * Recoger la firma e iniciales de cada firmante en el paso «Firmantes»: une el modelo (`earlyCapture.ts`) con las opciones del
 * documento (`captures`) o, con varios, con los bloques de la sesion, y devuelve lo que pinta `SignerManager`. No guarda estado
 * propio salvo la frase de la region viva: lo recogido vive en lo mismo que lo recogido por la ceremonia.
 */
export function useEarlyCapture({ options, setOptions, stampKey, fileName, multi, strings }: EarlyCaptureArgs): SignerCaptureApi {
  const [liveMessage, setLiveMessage] = useState("");
  const signers = options.signers;
  const nameOf = (signerId: string) => signerLabel(signers, signerId, strings);

  const docIds = multi ? multi.docs.map((doc) => doc.id) : [];
  const ctx: BlockContext | null = multi ? { signers, docs: multi.session.docs, keys: multi.stampKeys } : null;
  const ready = multi ? docIds.length > 0 && docIds.every((id) => Boolean(multi.stampKeys[id])) : Boolean(stampKey);

  const statusOf: SignerCaptureApi["statusOf"] = (signerId) =>
    multi && ctx
      ? earlyStatusBlocks(multi.session.blocks, ctx, signerId)
      : earlyStatusSingle(options.captures, signerId, stampKey);

  const groupsOf: SignerCaptureApi["groupsOf"] = (signerId) => {
    if (multi && ctx) {
      const own = signerBlocks(multi.session.blocks, signerId);
      const letters = blockGroups(multi.session.blocks, docIds, signers);
      return own.map<EarlyGroup>((block) => {
        // Con un solo grupo no hace falta nombrarlo; con varios, «Firma A — para: Contrato, Anexo».
        const letter = letters[block.id];
        const title =
          own.length > 1 ? (letter ? strings.assignment.group(letter) : strings.blockName(own.indexOf(block) + 1)) : null;
        return {
          id: block.id,
          title,
          label: title ? strings.assignment.groupFor(title, groupDocsText(block, multi.docs)) : null,
          signature: visibleDraft(block, "signature", ctx),
          initials: visibleDraft(block, "initials", ctx),
        };
      });
    }
    const capture = currentCapture(options.captures, signerId, stampKey);
    return [{ id: "doc", title: null, label: null, signature: capture.signature, initials: capture.initials }];
  };

  /** Anuncia el estado en que queda el firmante tras una escritura. */
  const announce = (signerId: string, status: ReturnType<typeof statusOf>) =>
    setLiveMessage(strings.early.announceStatus(nameOf(signerId), earlyStatusText(status, strings)));

  const onSave = (signerId: string, groupId: string, type: SignatureFieldType, draft: SignatureDraft) => {
    if (multi && ctx) {
      let status = statusOf(signerId);
      multi.bridge.commit((current) => {
        const live: BlockContext = { ...ctx, signers: current.signers, docs: current.docs };
        const blocks = captureForBlock(current.blocks, groupId, { [type]: draft }, live);
        status = earlyStatusBlocks(blocks, live, signerId);
        return { blocks };
      });
      announce(signerId, status);
      return;
    }
    if (!stampKey) return;
    const captures = collectSingle(options.captures, signerId, stampKey, { [type]: draft });
    setOptions({ captures });
    announce(signerId, earlyStatusSingle(captures, signerId, stampKey));
  };

  const onUseSaved: SignerCaptureApi["onUseSaved"] = (signerId, groupId, saved: SavedDrafts, applyToAll) => {
    if (multi && ctx) {
      const outcome = { missing: [] as SignatureFieldType[], filledOthers: 0 };
      let status = statusOf(signerId);
      multi.bridge.commit((current) => {
        const live: BlockContext = { ...ctx, signers: current.signers, docs: current.docs };
        const result = applySavedEarly(current.blocks, groupId, saved, applyToAll, live);
        outcome.missing = result.missing;
        outcome.filledOthers = result.filledOthers;
        status = earlyStatusBlocks(result.blocks, live, signerId);
        return { blocks: result.blocks };
      });
      announce(signerId, status);
      return outcome;
    }
    if (!stampKey) return { missing: [], filledOthers: 0 };
    const result = applySavedSingle(options.captures, signerId, stampKey, saved);
    setOptions({ captures: result.captures });
    announce(signerId, earlyStatusSingle(result.captures, signerId, stampKey));
    return { missing: result.missing, filledOthers: 0 };
  };

  const onClear = (signerId: string) => {
    if (multi) multi.bridge.commit((current) => ({ blocks: clearSignerBlocks(current.blocks, signerId) }));
    else setOptions({ captures: clearSingle(options.captures, signerId) });
    setLiveMessage(strings.early.announceRemoved(nameOf(signerId)));
  };

  // Firmantes cuya firma YA recogida dejo de valer: la frase completa de siempre (`StaleSignatureNotice`), no solo el rotulo corto.
  const staleNotes = signers.flatMap((signer) => {
    if (!ready) return [];
    const status = statusOf(signer.id);
    return status.kind === "stale" && status.reason
      ? [{ signerId: signer.id, text: strings.staleSignature(nameOf(signer.id), status.reason) }]
      : [];
  });

  return {
    ready,
    statusOf,
    groupsOf,
    onSave,
    onUseSaved,
    onClear,
    sourceOf: (groupId) => {
      if (multi) {
        const block = multi.session.blocks.find((candidate) => candidate.id === groupId);
        return block ? rememberSource(block, multi.docs, strings) : "";
      }
      return fileName ?? "";
    },
    liveMessage,
    staleNotes,
  };
}
