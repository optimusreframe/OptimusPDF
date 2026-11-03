"use client";

import { useMemo } from "react";
import type { SignatureFieldType } from "@/lib/pdf/sign";
import { useSignatureVault } from "@/app/sign-pdf/useSignatureVault";
import { pickVaultEntry, type QuickProposal } from "@/app/sign-pdf/quickSign/quickSignModel";

/**
 * La firma guardada que se propone al firmante del turno (ver `pickVaultEntry`), leida del baul. `null` mientras el baul carga,
 * si esta apagado o no disponible, o si no hay nada que ofrecer. No escribe nada.
 */
export function useQuickSign({
  enabled,
  signerName,
  need,
  excludeIds,
}: {
  enabled: boolean;
  signerName: string;
  need: readonly SignatureFieldType[];
  excludeIds?: ReadonlySet<string>;
}): QuickProposal | null {
  const vault = useSignatureVault(enabled);
  const needKey = need.join("|");
  const excludeKey = excludeIds ? [...excludeIds].sort().join("|") : "";
  return useMemo(
    () => (enabled && vault.status === "ready" ? pickVaultEntry(vault.entries, signerName, need, excludeIds) : null),
    // `need`/`excludeIds` se resumen en sus claves: llegan como arrays/sets nuevos en cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, vault.status, vault.entries, signerName, needKey, excludeKey],
  );
}
