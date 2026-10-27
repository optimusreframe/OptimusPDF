"use client";

import { CircleAlert, X } from "lucide-react";
import type { ImportProblem } from "@/app/scan-to-pdf/importProblems";
import type { ScanToPdfStrings } from "@/app/scan-to-pdf/strings";

const SHOWN = 5;

/**
 * Aviso de las fotos que NO se anadieron: cuantas, cuales (por nombre) y por que, con plural correcto. No usa `role` propio:
 * el anuncio a lectores de pantalla lo hace la region viva unica (`ScanLive`) en el momento del fallo.
 */
export function ImportProblemsBanner({ s, problems, onDismiss, onRetry, onReload }: { s: ScanToPdfStrings; problems: ImportProblem[]; onDismiss: () => void; onRetry?: () => void; onReload?: () => void }) {
  if (problems.length === 0) return null;
  const copy = s.importProblems;
  // «No se pudo cargar el escaner» (sin red) NO es un defecto de las fotos: un solo mensaje claro con «Reintentar», nunca «dañada».
  const engine = problems.some((problem) => problem.kind === "engine");
  const photos = problems.filter((problem) => problem.kind !== "engine");
  const pending = problems.filter((problem) => problem.kind === "engine" && (problem.name !== "" || problem.blob));
  const shown = photos.slice(0, SHOWN);
  const hidden = photos.length - shown.length;
  return (
    <div data-banner="import-problems" className="mt-3 flex items-start gap-2 rounded-ios border border-accent-edit/50 bg-accent-edit/10 px-3 py-2">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-edit" />
      <div className="min-w-0 flex-1">
        {engine ? (
          <div data-import-engine-unavailable="">
            <p className="text-footnote font-semibold text-foreground">{copy.engineUnavailable}</p>
            {/* Las fotos que no se procesaron se pierden al recargar (viven en memoria): se dice, con sus nombres. */}
            <p data-import-reload-hint="" className="mt-1 text-footnote text-muted-foreground">
              {copy.engineReload(pending.length)}
            </p>
            {pending.length > 0 ? (
              <ul className="mt-1 flex flex-col gap-0.5 text-footnote text-foreground">
                {pending.slice(0, SHOWN).map((problem, index) => (
                  <li key={`${problem.name}-${index}`} data-import-pending="" className="min-w-0 break-words font-medium">
                    {problem.name || copy.camera}
                  </li>
                ))}
                {pending.length > SHOWN ? <li className="text-muted-foreground">{copy.more(pending.length - SHOWN)}</li> : null}
              </ul>
            ) : null}
            <div className="mt-1.5 flex flex-wrap gap-2">
              {/* La accion PRINCIPAL es recargar: un reintento sin recargar no recupera un trozo de codigo que el cargador ya dio por fallido. */}
              {onReload ? (
                <button
                  type="button"
                  data-import-action="reload"
                  onClick={onReload}
                  className="inline-flex min-h-11 items-center rounded-ios-sm bg-signal px-4 text-footnote font-semibold text-[var(--color-on-signal)] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
                >
                  {copy.reload}
                </button>
              ) : null}
              {/* «Reintentar» solo cuando puede funcionar (hay conexion y el motor no pide recargar). */}
              {onRetry ? (
                <button
                  type="button"
                  data-import-action="retry"
                  onClick={onRetry}
                  className="inline-flex min-h-11 items-center rounded-ios-sm border border-hairline-strong bg-white/5 px-4 text-footnote font-semibold text-foreground outline-none hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
                >
                  {copy.retry}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        {photos.length > 0 ? (
          <div className={engine ? "mt-2" : undefined}>
            <p className="text-footnote font-semibold text-foreground">{copy.title(photos.length)}</p>
            <ul className="mt-1 flex flex-col gap-0.5 text-footnote text-foreground">
              {shown.map((problem, index) => (
                <li key={`${problem.kind}-${problem.name}-${index}`} data-import-problem={problem.kind} className="min-w-0 break-words">
                  <span className="font-medium">{problem.name || copy.camera}</span>
                  <span className="text-muted-foreground">{`: ${copy.kinds[problem.kind]}`}</span>
                </li>
              ))}
              {hidden > 0 ? <li className="text-muted-foreground">{copy.more(hidden)}</li> : null}
            </ul>
            <p className="mt-1 text-footnote text-muted-foreground">{copy.rest}</p>
          </div>
        ) : null}
      </div>
      <button
        type="button"
        data-icon-action="dismiss-import-problems"
        aria-label={copy.dismiss}
        title={copy.dismiss}
        onClick={onDismiss}
        className="-my-1 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-full text-foreground outline-none hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
      >
        <X aria-hidden="true" className="size-5" />
      </button>
    </div>
  );
}
