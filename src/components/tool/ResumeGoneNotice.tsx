"use client";

import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import type { ResumeLinkState } from "@/lib/useResumeLink";

/**
 * El selector de PDF de la zona de carga y el boton que lo abre. Se distingue por `accept`: Firmar trae ademas otro
 * selector (el .zip de «Importar configuracion») que NO es el que hay que abrir.
 */
function findDropzone(): { input: HTMLInputElement; button: HTMLButtonElement | null } | null {
  const input = document.querySelector<HTMLInputElement>('input[type="file"][accept*="pdf"]');
  if (!input) return null;
  return { input, button: input.parentElement?.querySelector<HTMLButtonElement>("button") ?? null };
}

/**
 * «Este trabajo ya no se puede recuperar en este navegador (se borro o caduco)» + «Abrir de nuevo» (U0.6): lo muestra
 * una herramienta cuando `?resume=` apunta a un borrador que ya no existe. «Abrir de nuevo» abre el selector de
 * archivos de la propia herramienta (la persona vuelve a elegir el PDF); «Cerrar» solo retira el aviso y deja el foco
 * en la zona de carga (el control que lo tenia desaparece).
 *
 * Por defecto (`region="status"`) es una region viva SIEMPRE montada (asi se anuncia). PDF Pro tiene UNA sola region
 * viva (`role=status`) en toda la pagina: alli se usa `region="alert"`, que solo existe mientras hay aviso.
 */
export function ResumeGoneNotice({
  state,
  className,
  region = "status",
}: {
  state: ResumeLinkState;
  className?: string;
  region?: "status" | "alert";
}) {
  const { t } = useI18n();
  if (region === "alert" && !state.gone) return null;
  const regionProps = region === "alert" ? { role: "alert" } : { role: "status", "aria-live": "polite" as const };
  return (
    <div {...regionProps} data-resume-gone={state.gone ? "" : undefined} className={state.gone ? className : "sr-only"}>
      {state.gone ? (
        <div className={cn("surface-card rounded-ios-sm flex flex-wrap items-center gap-3 p-3")}>
          <p className="min-w-0 flex-1 basis-60 text-subheadline text-foreground">{t.resume.gone}</p>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="md" onClick={() => findDropzone()?.input.click()}>
              {t.resume.reopen}
            </Button>
            <Button
              variant="ghost"
              size="md"
              onClick={() => {
                const zone = findDropzone();
                state.dismiss();
                zone?.button?.focus({ preventScroll: true });
              }}
            >
              {t.common.close}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
