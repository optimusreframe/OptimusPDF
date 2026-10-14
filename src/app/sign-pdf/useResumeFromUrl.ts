"use client";

import { listAllDrafts, type DraftEntry } from "@/app/sign-pdf/signDrafts";
import { resumeKindsOfTool } from "@/lib/resumeLinks";
import { useResumeLink, type ResumeLinkState } from "@/lib/useResumeLink";

/** Firmar restaura el borrador de UN documento (`sign`) y la sesion de varios (`session`); ningun otro tipo. */
const KINDS = resumeKindsOfTool("sign-pdf");

/**
 * Punto de entrada de `/sign-pdf?resume=<tipo>:<id>` (U0.6): al montar, busca ese borrador en los de este navegador y,
 * si existe, lo retoma con `onResume` (el mismo camino que «Ver borradores» -> «Reanudar»: `handleResumeEntry`). Si ya
 * no existe devuelve `gone` para que la herramienta avise con `ResumeGoneNotice`. La URL se limpia al terminar.
 */
export function useResumeFromUrl(onResume: (entry: DraftEntry) => void): ResumeLinkState {
  return useResumeLink(KINDS, async (target) => {
    const entries = await listAllDrafts();
    const wantsSession = target.kind === "session";
    const entry = entries.find(
      (candidate) => candidate.meta.id === target.id && (candidate.kind === "session") === wantsSession,
    );
    if (!entry) return "gone";
    onResume(entry);
    return "restored";
  });
}
