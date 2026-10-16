import {
  EMPTY_DOC_STATE,
  docIdOf,
  ensureBlocks,
  nextBlockId,
  normalizeBlocks,
  type DocId,
  type DocState,
  type SignerBlock,
} from "@/app/sign-pdf/docSet";
import type { ImportedSignConfigSet } from "@/app/sign-pdf/signConfig";
import type { SignSession } from "@/app/sign-pdf/signSession";
import { DEFAULT_COPIES, normalizeCopies } from "@/lib/pdf/signCopies";

/**
 * Una configuracion importada (v1: un documento; v2: varios) convertida en el
 * patch de sesion que carga `ToolShell`. Pura, sin React.
 *
 *  - Cada documento queda sellado y con sus campos de texto "resueltos" para su
 *    huella (`keys[i]`), como al importar un solo documento: el efecto de
 *    deteccion no pisa lo importado.
 *  - La v3 trae ademas las copias de cada documento (`DocState.copies`).
 *  - Los bloques de la v2 llegan SIN trazos (una configuracion nunca lleva
 *    firmas): se les acuñan ids nuevos y se ajustan a firmantes y documentos.
 *    Con la v1 (sin bloques) los crea la propia sesion.
 *  - Siempre arranca en el paso de firmantes y con el primer documento activo.
 */
export function sessionFromConfigSet(
  set: ImportedSignConfigSet,
  files: readonly File[],
  keys: readonly (string | null)[],
): Partial<SignSession> {
  const liveIds = files.map(docIdOf);
  const liveOf = new Map<string, DocId>();
  const docs: Record<DocId, DocState> = {};
  set.documents.forEach((doc, index) => {
    const live = liveIds[index];
    if (live === undefined) return;
    liveOf.set(doc.id, live);
    const key = keys[index] ?? null;
    docs[live] = {
      ...EMPTY_DOC_STATE,
      fields: doc.fields,
      textFields: doc.textFields,
      textValues: doc.textValues,
      textFieldsDetectedFor: key,
      sealedKey: key ?? "",
      // v3: las copias de cada documento (la v1/v2 no las traen = 1: la forma de siempre).
      ...(normalizeCopies(doc.copies) > DEFAULT_COPIES ? { copies: normalizeCopies(doc.copies) } : {}),
    };
  });

  const imported: SignerBlock[] = set.blocks.flatMap((block): SignerBlock[] => {
    const appliesTo = block.appliesTo.flatMap((id) => {
      const live = liveOf.get(id);
      return live === undefined ? [] : [live];
    });
    if (appliesTo.length === 0) return [];
    return [
      {
        id: nextBlockId(),
        signerId: block.signerId,
        appliesTo,
        signature: null,
        initials: null,
        stamps: {},
        auto: block.auto,
      },
    ];
  });
  const blocks = ensureBlocks(
    set.signers,
    liveIds,
    set.signMode,
    normalizeBlocks(imported, liveIds).blocks,
  );

  return {
    mode: set.mode,
    signMode: set.signMode,
    signers: set.signers,
    blocks,
    docs,
    docOrder: liveIds,
    activeDocId: liveIds[0] ?? null,
    step: "signers",
  };
}
