"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, KeyRound, Signature } from "lucide-react";
import { Checkbox } from "@/components/ui/Checkbox";
import { useI18n } from "@/lib/i18n";
import { inspectProtection } from "@/lib/pdf/unlock";
import { ProtectionNotice } from "@/app/unlock-pdf/ProtectionNotice";
import { asPdfFile } from "@/app/pdf-pro/ops/opUtils";
import type { ProUnlockOptions } from "@/app/pdf-pro/ops/docOperations";
import type { DocPanelProps } from "@/app/pdf-pro/tabs/docToolTypes";
import { getProStrings } from "@/app/pdf-pro/proStrings";

/**
 * Panel de «Quitar protección». El documento de trabajo NUNCA esta cifrado (si el archivo lo estaba, se
 * descifro en memoria al abrirlo): aqui se explica eso y, si ademas hay firmas que restringen cambios,
 * se ofrece quitarlas con consentimiento explicito (las firmas dejan de ser validas).
 */
export function UnlockPanel({ options, setOptions, ctx }: DocPanelProps<ProUnlockOptions>) {
  const { language } = useI18n();
  const s = getProStrings(language).docTools.unlock;
  const [inspectedFor, setInspectedFor] = useState("");
  const setOptionsRef = useRef(setOptions);
  useEffect(() => {
    setOptionsRef.current = setOptions;
  });

  useEffect(() => {
    let cancelled = false;
    setOptionsRef.current({ inspected: "pending", acknowledgeSignatureInvalidation: false });
    inspectProtection(asPdfFile(ctx.bytes))
      .then((result) => {
        if (cancelled) return;
        setOptionsRef.current({
          inspected: result.kind === "ready" && result.profile.hasSignatureRestrictions ? "restricted" : result.kind === "ready" ? "none" : "failed",
        });
      })
      .catch(() => {
        if (!cancelled) setOptionsRef.current({ inspected: "failed" });
      })
      .finally(() => {
        if (!cancelled) setInspectedFor(ctx.snapshotId);
      });
    return () => {
      cancelled = true;
    };
  }, [ctx.bytes, ctx.snapshotId]);

  const checking = options.inspected === "pending" || inspectedFor !== ctx.snapshotId;

  return (
    <section aria-label={s.title} className="space-y-4">
      {ctx.wasEncrypted ? (
        <ProtectionNotice icon={KeyRound} tone="security" title={s.decryptedTitle} body={`${s.decryptedBody} ${s.reprotectHint}`} />
      ) : null}

      {checking ? (
        <p aria-busy="true" className="text-sm text-muted-foreground">
          {s.checking}
        </p>
      ) : options.inspected === "failed" ? (
        <p className="text-sm text-destructive">{s.inspectFailed}</p>
      ) : options.inspected === "restricted" ? (
        <>
          <ProtectionNotice icon={Signature} tone="warning" title={s.title} body={s.restrictionsFound} />
          <Checkbox
            label={s.consent}
            hint={s.consentHint}
            checked={options.acknowledgeSignatureInvalidation === true}
            onChange={(checked) => setOptions({ acknowledgeSignatureInvalidation: checked })}
          />
        </>
      ) : (
        <ProtectionNotice icon={CheckCircle2} tone="neutral" title={s.title} body={s.noRestrictions} />
      )}
    </section>
  );
}
