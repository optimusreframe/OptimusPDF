"use client";

import Link from "next/link";
import { Clock, FileText } from "lucide-react";
import { Button, buttonClasses } from "@/components/ui/Button";
import { GlassCard } from "@/components/ui/GlassCard";
import { useRecentEntries } from "@/hooks/useRecentEntries";
import { useI18n, localeTag } from "@/lib/i18n";
import { clearRecentEntries } from "@/lib/recent";
import { TOOL_SLUGS, toolHref, type ToolSlug } from "@/lib/tools-registry";

function isKnownSlug(slug: string): slug is ToolSlug {
  return (TOOL_SLUGS as readonly string[]).includes(slug);
}

export function RecentView() {
  const { t, language } = useI18n();
  const entries = useRecentEntries();

  const formatter = new Intl.DateTimeFormat(localeTag(language), {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <div className="mx-auto max-w-[800px] px-4 pt-10 pb-16 md:px-6 md:pt-16">
      <header className="mb-8">
        <h1 className="text-4xl font-black tracking-[-0.025em] text-foreground md:text-5xl">
          {t.recent.title}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {t.recent.subtitle}
        </p>
      </header>

      {entries.length === 0 ? (
        <GlassCard className="flex flex-col items-center px-6 py-14 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-white/6">
            <Clock aria-hidden="true" className="size-5 text-muted-foreground" />
          </span>
          <p className="mt-4 text-sm text-muted-foreground">{t.recent.empty}</p>
          <Link
            href="/tools"
            className={`${buttonClasses("secondary", "md")} mt-6`}
          >
            {t.recent.emptyCta}
          </Link>
        </GlassCard>
      ) : (
        <>
          <ul className="space-y-2">
            {entries.map((entry) => {
              const known = isKnownSlug(entry.slug);
              const name = known
                ? t.tools[entry.slug].name
                : entry.slug;
              return (
                <li key={entry.id}>
                  <GlassCard className="flex items-center gap-3 p-4">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-ios-sm bg-white/6">
                      <FileText
                        aria-hidden="true"
                        className="size-4 text-signal"
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {entry.fileName}
                      </p>
                      <p className="hud-label text-[10px] text-muted-foreground">
                        {name} · {formatter.format(new Date(entry.date))}
                      </p>
                    </div>
                    {known ? (
                      <Link
                        href={toolHref(entry.slug)}
                        className={buttonClasses("ghost", "sm")}
                      >
                        {t.common.continueLabel}
                      </Link>
                    ) : null}
                  </GlassCard>
                </li>
              );
            })}
          </ul>

          <Button
            variant="destructive"
            size="sm"
            className="mt-6"
            onClick={() => clearRecentEntries()}
          >
            {t.recent.clear}
          </Button>
        </>
      )}
    </div>
  );
}
