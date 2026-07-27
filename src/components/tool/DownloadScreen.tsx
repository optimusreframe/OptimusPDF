"use client";

import { Check, Download, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ToolCard } from "@/components/tool/ToolCard";
import { useI18n, localeTag } from "@/lib/i18n";
import { formatFileSize } from "@/lib/pdf/core";
import { getRelatedTools, type ToolSlug } from "@/lib/tools-registry";

export type DownloadScreenProps = {
  slug: ToolSlug;
  filename: string;
  size: number;
  onDownload: () => void;
  onStartOver: () => void;
};

export function DownloadScreen({
  slug,
  filename,
  size,
  onDownload,
  onStartOver,
}: DownloadScreenProps) {
  const { t, language } = useI18n();
  const related = getRelatedTools(slug, 3);

  return (
    <div className="animate-rise-in">
      <div className="glass rounded-ios-lg flex flex-col items-center px-6 py-12 text-center md:py-16">
        <span className="flex size-14 items-center justify-center rounded-full bg-success/15">
          <Check aria-hidden="true" className="size-7 text-success" />
        </span>

        <h2 className="mt-5 text-2xl font-black tracking-[-0.025em] text-foreground md:text-3xl">
          {t.tool.doneTitle}
        </h2>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          {t.tool.doneSubtitle}
        </p>

        <p className="mt-6 max-w-full truncate text-sm font-medium text-foreground">
          {filename}
        </p>
        <p className="hud-label mt-1 text-[10px] text-muted-foreground">
          {t.tool.resultSize} · {formatFileSize(size, localeTag(language))}
        </p>

        <Button size="lg" className="mt-7" onClick={onDownload}>
          <Download aria-hidden="true" className="size-4" />
          {t.tool.download}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="mt-3"
          onClick={onStartOver}
        >
          <RotateCcw aria-hidden="true" className="size-3.5" />
          {t.tool.startOver}
        </Button>
      </div>

      <section className="mt-10">
        <h3 className="hud-label mb-4 text-[11px] text-muted-foreground">
          {t.tool.relatedTitle}
        </h3>
        <div className="grid gap-3 sm:grid-cols-3">
          {related.map((tool) => (
            <ToolCard key={tool.slug} tool={tool} compact />
          ))}
        </div>
      </section>
    </div>
  );
}
