"use client";

import { GlassCard } from "@/components/ui/GlassCard";
import { Badge } from "@/components/ui/Badge";
import { useT } from "@/lib/i18n";

export function AboutView() {
  const t = useT();

  return (
    <div className="mx-auto max-w-[860px] px-4 pt-10 pb-16 md:px-6 md:pt-16">
      <header>
        <Badge variant="live" dot>
          {t.common.localAndZeroUploads}
        </Badge>
        <h1 className="mt-5 text-4xl font-black tracking-[-0.025em] text-foreground md:text-5xl">
          {t.about.title}
        </h1>
        <p className="mt-3 text-base text-muted-foreground md:text-lg">
          {t.about.subtitle}
        </p>
      </header>

      <div className="mt-8 space-y-5">
        {t.about.body.map((paragraph) => (
          <p
            key={paragraph.slice(0, 24)}
            className="text-sm leading-relaxed text-muted-foreground md:text-base"
          >
            {paragraph}
          </p>
        ))}
      </div>

      <GlassCard className="mt-10 p-7">
        <h2 className="hud-label text-[11px] text-foreground">
          {t.about.stackTitle}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {t.about.stackBody}
        </p>
      </GlassCard>

      <section className="mt-10">
        <h2 className="hud-label mb-4 text-[11px] text-muted-foreground">
          {t.about.valuesTitle}
        </h2>
        <div className="grid gap-3 md:grid-cols-3">
          {t.about.values.map((value) => (
            <GlassCard key={value.title} className="p-6">
              <h3 className="text-base font-semibold text-foreground">
                {value.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {value.body}
              </p>
            </GlassCard>
          ))}
        </div>
      </section>
    </div>
  );
}
