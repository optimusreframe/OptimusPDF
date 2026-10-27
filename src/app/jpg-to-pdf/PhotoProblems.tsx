"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useI18n } from "@/lib/i18n";
import { IMAGE_QUALITY_STRINGS, fillCopy } from "@/lib/image/qualityStrings";
import type { ImageProblemEntry } from "@/lib/image/useImageProblems";
import { cn } from "@/lib/cn";

export type PhotoProblemsProps = {
  problems: readonly ImageProblemEntry[];
  /** Quita las fotos inservibles de la lista y deja continuar con las demas. */
  onRemove: () => void;
  className?: string;
};

/**
 * Aviso ANTES de procesar: las fotos que no se pueden usar (vacias, que no son imagen, incompletas, danadas, HEIC que este
 * navegador no abre), cada una por su NOMBRE y con su motivo, y un solo boton «Quitar y continuar». Si la persona no las quita,
 * se omiten al procesar y el resultado las vuelve a nombrar: nunca sale un PDF con una foto rota sin que quede constancia.
 */
export function PhotoProblems({ problems, onRemove, className }: PhotoProblemsProps) {
  const { language } = useI18n();
  const copy = IMAGE_QUALITY_STRINGS[language];
  if (problems.length === 0) return null;
  const title = problems.length === 1 ? copy.problemsTitleOne : fillCopy(copy.problemsTitleMany, { n: problems.length });
  return (
    <section
      role="alert"
      aria-label={title}
      data-photo-problems=""
      className={cn("w-full rounded-ios border border-destructive/35 bg-destructive/10 p-4 text-left", className)}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <h3 className="text-subheadline font-semibold text-foreground">{title}</h3>
          <p className="mt-0.5 text-subheadline text-muted-foreground">{copy.problemsHint}</p>
          <ul className="mt-2 space-y-1 text-subheadline text-foreground" data-photo-problems-list="">
            {problems.map(({ file, problem }, index) => (
              <li key={`${file.name}:${file.size}:${file.lastModified}:${index}`} className="break-words">
                <span className="font-semibold">{file.name}</span> {copy.problemLine[problem]}
              </li>
            ))}
          </ul>
          <Button type="button" variant="secondary" size="md" className="mt-3" onClick={onRemove} data-photo-problems-remove="">
            {copy.removeAndContinue}
          </Button>
        </div>
      </div>
    </section>
  );
}
