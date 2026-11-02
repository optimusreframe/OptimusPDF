"use client";

import Link from "next/link";
import { Clock, ServerOff } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { buttonClasses } from "@/components/ui/Button";
import { ToolCard } from "@/components/tool/ToolCard";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import {
  ACCENT_BG_SOFT,
  ACCENT_TEXT,
  DOWNLOADER_PLATFORMS,
  getTool,
  type ToolSlug,
} from "@/lib/tools-registry";

/**
 * Alternativas que SI son locales, en este orden. Cada tarjeta respeta el `status` real de la herramienta (si una aun no
 * esta lista lleva su insignia «Próximamente»): la pagina no promete nada que el registro no diga. Las disponibles van antes.
 */
const ALTERNATIVES: ToolSlug[] = [
  "audio-extractor",
  "image-converter",
  "audio-converter",
  "video-converter",
  "scan-to-pdf",
];

/**
 * `/downloader`: pagina honesta. Descargar de una red social necesita un servidor que consulte la plataforma, y eso no cabe
 * en la promesa de OptimusPDF (tus archivos no salen de tu dispositivo). Dice por que, nombra las plataformas, no da
 * fechas y ofrece lo que si funciona en local.
 */
export function DownloaderView() {
  const t = useT();
  const tool = getTool("downloader");
  const Icon = tool.icon;
  const copy = t.tools.downloader;
  const page = t.downloaderPage;
  const alternatives = ALTERNATIVES.map((slug) => getTool(slug)).sort(
    (a, b) => Number(b.status === "live") - Number(a.status === "live"),
  );

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 pt-6 pb-16 md:px-6 md:pt-10">
      <div className="surface-card flex flex-col items-center rounded-ios-lg px-6 py-12 text-center md:py-16">
        <span
          className={cn(
            "flex size-14 items-center justify-center rounded-ios opacity-70",
            ACCENT_BG_SOFT[tool.accent],
          )}
        >
          <Icon aria-hidden="true" className={cn("size-7", ACCENT_TEXT[tool.accent])} />
        </span>

        <Badge variant="soon" className="mt-5">
          <Clock aria-hidden="true" className="size-3" />
          {t.soon.badge}
        </Badge>

        <h1 className="mt-4 text-title-1 text-foreground">{copy.name}</h1>
        <p className="mt-2 max-w-xl text-callout text-muted-foreground">{page.lead}</p>

        <div className="mt-8 max-w-xl rounded-ios border border-hairline bg-white/5 p-5 text-left">
          <h2 className="flex items-center gap-2 text-headline text-foreground">
            <ServerOff aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
            {page.whyTitle}
          </h2>
          <p className="mt-1.5 text-subheadline text-muted-foreground">{page.whyBody}</p>
        </div>

        <section className="mt-8 w-full max-w-xl text-left" aria-labelledby="downloader-platforms-title">
          <h2 id="downloader-platforms-title" className="ui-label text-muted-foreground">
            {page.platformsTitle}
          </h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {DOWNLOADER_PLATFORMS.map((name) => (
              <li key={name}>
                <Badge variant="soon" className="px-3 py-1.5 text-caption">
                  {name}
                </Badge>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-subheadline text-muted-foreground">{page.platformsBody}</p>
        </section>

        <Link href="/" className={cn(buttonClasses("secondary", "md"), "mt-8")}>
          {page.back}
        </Link>
      </div>

      <section className="mt-10" aria-labelledby="downloader-alternatives-title">
        <h2 id="downloader-alternatives-title" className="text-title-3 text-foreground">
          {page.alternativesTitle}
        </h2>
        <p className="mt-1 mb-4 text-subheadline text-muted-foreground">{page.alternativesBody}</p>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {alternatives.map((candidate) => (
            <li key={candidate.slug}>
              <ToolCard tool={candidate} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
