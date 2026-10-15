"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { ResumeStrings } from "@/app/sign-pdf/strings";

export type TabNoticeKind = "newer" | "forked";

export type DraftHealthNoticeProps = {
  /** El navegador no deja guardar el borrador (cuota llena, almacenamiento bloqueado...): lo de pantalla NO esta a salvo. */
  failed: boolean;
  /**
   * Otra pestaña toco la misma sesion (F0-fix, D1): `newer` = guardo una version mas nueva (aun no se pisó nada; lo que se
   * cambie aqui se guardara aparte); `forked` = lo de esta pestaña ya se guardo aparte como copia.
   */
  tab: TabNoticeKind | null;
  strings: ResumeStrings;
  /** Texto del enlace a la lista de borradores («Ver borradores»). */
  viewDraftsLabel: string;
  onViewDrafts: () => void;
};

/**
 * El estado del borrador, dicho con honestidad y sin ruido (F0-fix, D1 y D2): mientras el navegador no deje guardar, «Sin
 * autoguardado: ... Descarga antes de salir»; cuando otra pestaña modifico la misma firma, que esta copia se guardo aparte
 * (o se guardara) con un enlace a «Ver borradores». Se retira solo cuando deja de ser verdad.
 *
 * La region viva esta siempre montada (solo cambia su contenido) para que el cambio se anuncie; sin nada que decir queda
 * reducida a texto para lectores de pantalla y vacia. No es un dialogo ni bloquea nada.
 */
export function DraftHealthNotice({ failed, tab, strings, viewDraftsLabel, onViewDrafts }: DraftHealthNoticeProps) {
  const messages = [
    failed ? strings.draftFailedNotice : null,
    tab === "forked" ? strings.tabForkedNotice : tab === "newer" ? strings.tabNewerNotice : null,
  ].filter((text): text is string => text !== null);
  const visible = messages.length > 0;
  return (
    <div
      data-draft-health=""
      data-draft-health-state={visible ? [failed ? "failed" : null, tab].filter(Boolean).join(" ") : "ok"}
      className={
        visible
          ? "rounded-ios-sm flex basis-full flex-wrap items-center gap-x-3 gap-y-2 border border-white/10 bg-white/5 px-3 py-2"
          : "sr-only"
      }
    >
      {visible && failed ? <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-destructive-text" /> : null}
      <p role="status" aria-live="polite" className={visible ? "min-w-0 flex-1 text-footnote text-foreground" : undefined}>
        {messages.join(" ")}
      </p>
      {tab ? (
        <Button variant="secondary" size="md" onClick={onViewDrafts}>
          {viewDraftsLabel}
        </Button>
      ) : null}
    </div>
  );
}
