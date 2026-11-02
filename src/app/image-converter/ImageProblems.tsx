"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { problemReason } from "@/app/image-converter/problemText";
import { STRINGS, fill } from "@/app/image-converter/strings";
import type { ConverterProblemEntry } from "@/app/image-converter/useConverterProblems";

export type ImageProblemsProps = {
  problems: readonly ConverterProblemEntry[];
  /** Quita las imagenes inservibles de la lista y deja continuar con las demas. */
  onRemove: () => void;
  className?: string;
};

/**
 * Aviso ANTES de convertir (y tras una conversion en la que ninguna salio): las imagenes que no se pueden convertir, cada una por
 * su NOMBRE y con su motivo, y un solo boton «Quitar y continuar». Si no se quitan, se omiten al convertir y el resultado las
 * vuelve a nombrar: nunca desaparece una imagen sin que quede constancia. Mismo patron que el aviso de «Imagen a PDF».
 */
export function ImageProblems({ problems, onRemove, className }: ImageProblemsProps) {
  const { language } = useI18n();
  const s = STRINGS[language];
  if (problems.length === 0) return null;
  const title = problems.length === 1 ? s.problemsTitleOne : fill(s.problemsTitleMany, { n: problems.length });
  return (
    <section
      role="alert"
      aria-label={title}
      data-image-problems=""
      className={cn("w-full rounded-ios border border-destructive/35 bg-destructive/10 p-4 text-left", className)}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <h3 className="text-subheadline font-semibold text-foreground">{title}</h3>
          <p className="mt-0.5 text-subheadline text-muted-foreground">{s.problemsHint}</p>
          <ul className="mt-2 space-y-1 text-subheadline text-foreground" data-image-problems-list="">
            {problems.map(({ file, problem }, index) => (
              <li key={`${file.name}:${file.size}:${file.lastModified}:${index}`} className="break-words">
                <span className="font-semibold">{file.name}</span> {problemReason(language, problem)}
              </li>
            ))}
          </ul>
          <Button type="button" variant="secondary" size="md" className="mt-3" onClick={onRemove} data-image-problems-remove="">
            {s.removeAndContinue}
          </Button>
        </div>
      </div>
    </section>
  );
}
