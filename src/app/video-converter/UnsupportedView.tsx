"use client";

import Link from "next/link";
import { Info } from "lucide-react";
import { buttonClasses } from "@/components/ui/Button";
import { ToolCard } from "@/components/tool/ToolCard";
import { ToolHeader } from "@/components/tool/ToolHeader";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";
import type { NoWebCodecsReason } from "@/lib/media/video/capabilities";
import { getRelatedTools, type Tool } from "@/lib/tools-registry";
import type { VideoConverterStrings } from "@/app/video-converter/strings";

/**
 * Navegador sin WebCodecs (o pagina servida sin conexion segura): una pagina informativa con el motivo y las salidas, NO un
 * error de la herramienta ni del archivo. No se pide archivo alguno.
 */
export function UnsupportedView({
  tool,
  name,
  description,
  reason,
  strings,
}: {
  tool: Tool;
  name: string;
  description: string;
  reason: NoWebCodecsReason;
  strings: VideoConverterStrings;
}) {
  const t = useT();
  const alternatives = getRelatedTools(tool.slug, 3).filter((candidate) => candidate.status === "live");
  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 pt-6 pb-16 md:px-6 md:pt-10" data-video-unsupported={reason}>
      <ToolHeader tool={tool} name={name} description={description} />

      <section className="surface-card rounded-ios-lg p-6 md:p-8" aria-labelledby="video-unsupported-title">
        <div className="flex items-start gap-3">
          <Info aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 max-w-2xl">
            <h2 id="video-unsupported-title" className="text-headline text-foreground">
              {strings.unsupportedTitle}
            </h2>
            <p className="mt-2 text-subheadline text-muted-foreground">{strings.unsupported[reason]}</p>
            <p className="mt-2 text-subheadline text-muted-foreground">{strings.unsupportedBrowsers}</p>
            <p className="mt-2 text-footnote text-muted-foreground">{strings.unsupportedLocal}</p>
          </div>
        </div>
        <Link href="/" className={cn(buttonClasses("secondary", "md"), "mt-6")}>
          {t.soon.backHome}
        </Link>
      </section>

      {alternatives.length > 0 ? (
        <section className="mt-10" aria-labelledby="video-alternatives-title">
          <h2 id="video-alternatives-title" className="ui-label mb-3 text-muted-foreground">
            {t.soon.alternativesTitle}
          </h2>
          <ul className="grid gap-3 sm:grid-cols-3">
            {alternatives.map((candidate) => (
              <li key={candidate.slug}>
                <ToolCard tool={candidate} compact />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
