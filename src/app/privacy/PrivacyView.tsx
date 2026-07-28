"use client";

import { Badge } from "@/components/ui/Badge";
import { GlassCard } from "@/components/ui/GlassCard";
import { useI18n } from "@/lib/i18n";
import { STRINGS } from "@/app/privacy/strings";

export function PrivacyView() {
  const { t, language } = useI18n();
  const s = STRINGS[language];

  return (
    <div className="mx-auto max-w-[860px] px-4 pt-10 pb-16 md:px-6 md:pt-16">
      <header>
        <Badge variant="live" dot>
          {t.common.localAndZeroUploads}
        </Badge>
        <h1 className="mt-5 text-4xl font-black tracking-[-0.025em] text-foreground md:text-5xl">
          {s.title}
        </h1>
        <p className="mt-3 text-base text-muted-foreground md:text-lg">
          {s.subtitle}
        </p>
        <p className="hud-label mt-4 text-[10px] text-muted-foreground">
          {s.effectiveDate}
        </p>
      </header>

      <div className="mt-10 space-y-8">
        {s.sections.map((section) => (
          <section key={section.title}>
            <h2 className="hud-label mb-3 text-[11px] text-foreground">
              {section.title}
            </h2>
            <div className="space-y-3">
              {section.body.map((paragraph) => (
                <p
                  key={paragraph.slice(0, 32)}
                  className="text-sm leading-relaxed text-muted-foreground md:text-base"
                >
                  {paragraph}
                </p>
              ))}
            </div>
          </section>
        ))}
      </div>

      <GlassCard className="mt-10 p-7">
        <h2 className="hud-label text-[11px] text-foreground">
          {s.contactTitle}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {s.contactBody}
        </p>
      </GlassCard>
    </div>
  );
}
