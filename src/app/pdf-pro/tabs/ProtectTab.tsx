"use client";

import { KeyRound } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { ProtectionNotice } from "@/app/unlock-pdf/ProtectionNotice";
import { getProStrings } from "@/app/pdf-pro/proStrings";
import { useProWorkingDoc } from "@/app/pdf-pro/useProWorkingDoc";
import { DocToolRunner } from "@/app/pdf-pro/tabs/DocToolRunner";
import { getDocTool } from "@/app/pdf-pro/tabs/docToolDefinitions";
import { ProtectPanel } from "@/app/pdf-pro/tabs/ProtectPanel";

/**
 * Pestaña «Proteger» (Wave 7 · U5): «Guardar con contraseña…» como opcion de exportacion (no es un paso del
 * historial) y «Quitar protección» (restricciones de firma; el documento de trabajo ya esta sin cifrar).
 */
export function ProtectTab() {
  const { language } = useI18n();
  const s = getProStrings(language).docTools.protect;
  const { document } = useProWorkingDoc();
  if (!document) return null;

  return (
    <div className="space-y-8" data-doc-tab="protect">
      <div>
        <h2 className="text-headline text-foreground">{s.title}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{s.intro}</p>
      </div>

      {document.wasEncrypted ? (
        <ProtectionNotice icon={KeyRound} tone="security" title={s.encryptedOriginTitle} body={s.encryptedOriginBody} />
      ) : null}

      <ProtectPanel />

      <div className="border-t border-hairline pt-6">
        <DocToolRunner tool={getDocTool("unlock")} />
      </div>
    </div>
  );
}
