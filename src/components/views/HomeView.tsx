"use client";

import Link from "next/link";
import { ArrowRight, Shield, WifiOff, Cpu } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { buttonClasses } from "@/components/ui/Button";
import { GlassCard } from "@/components/ui/GlassCard";
import { ToolCard } from "@/components/tool/ToolCard";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import {
  CATEGORY_ORDER,
  TOOLS,
  getLiveTools,
  getToolsByCategory,
} from "@/lib/tools-registry";

const PRIVACY_ICONS = [Cpu, Shield, WifiOff];

export function HomeView() {
  const t = useT();
  const liveCount = getLiveTools().length;

  return (
    <div className="pb-16">
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-white/10">
        <div
          aria-hidden="true"
          className="hud-grid pointer-events-none absolute inset-0 opacity-70 [mask-image:radial-gradient(ellipse_at_top,black,transparent_75%)]"
        />
        <div className="relative mx-auto max-w-[1200px] px-4 py-16 md:px-6 md:py-28">
          <Badge variant="live" dot>
            {t.home.badge}
          </Badge>

          <h1 className="mt-6 max-w-4xl text-[clamp(2.5rem,7vw,4rem)] leading-[1.02] font-black tracking-[-0.025em] text-foreground">
            {t.home.title}
            <br />
            <span className="text-signal">{t.home.titleAccent}</span>
          </h1>

          <p className="mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground md:text-lg">
            {t.home.subtitle}
          </p>

          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <Link href="/tools" className={buttonClasses("primary", "lg")}>
              {t.home.ctaPrimary}
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
            <Link href="/about" className={buttonClasses("secondary", "lg")}>
              {t.home.ctaSecondary}
            </Link>
          </div>

          <dl className="mt-14 grid grid-cols-3 gap-4 border-t border-white/10 pt-8 md:max-w-2xl">
            <Stat value={String(TOOLS.length)} label={t.home.statTools} />
            <Stat value="0" label={t.home.statUploads} />
            <Stat
              value={t.home.statAccountsValue}
              label={t.home.statAccounts}
            />
          </dl>
        </div>
      </section>

      {/* Catalogo */}
      <section className="mx-auto max-w-[1200px] px-4 py-16 md:px-6 md:py-24">
        <header className="mb-10">
          <h2 className="text-3xl font-black tracking-[-0.025em] text-foreground md:text-4xl">
            {t.home.toolsTitle}
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground md:text-base">
            {t.home.toolsSubtitle}
          </p>
          <Badge variant="signal" className="mt-4">
            {liveCount} {t.toolsPage.liveCount}
          </Badge>
        </header>

        <div className="space-y-14">
          {CATEGORY_ORDER.map((category) => (
            <div key={category}>
              <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-white/10 pb-3">
                <h3 className="hud-label text-[11px] text-foreground">
                  {t.categories[category].label}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {t.categories[category].description}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {getToolsByCategory(category).map((tool) => (
                  <ToolCard key={tool.slug} tool={tool} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Privacidad */}
      <section
        id="privacidad"
        className="border-y border-white/10 bg-surface/50"
      >
        <div className="mx-auto max-w-[1200px] px-4 py-16 md:px-6 md:py-24">
          <h2 className="max-w-3xl text-3xl font-black tracking-[-0.025em] text-foreground md:text-4xl">
            {t.home.privacyTitle}
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground md:text-base">
            {t.home.privacySubtitle}
          </p>

          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {t.home.privacyPoints.map((point, index) => {
              const Icon = PRIVACY_ICONS[index] ?? Shield;
              return (
                <GlassCard key={point.title} className="p-6">
                  <span className="flex size-10 items-center justify-center rounded-ios-sm bg-signal/12">
                    <Icon aria-hidden="true" className="size-5 text-signal" />
                  </span>
                  <h3 className="mt-4 text-base font-semibold text-foreground">
                    {point.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {point.body}
                  </p>
                </GlassCard>
              );
            })}
          </div>
        </div>
      </section>

      {/* CTA final */}
      <section className="mx-auto max-w-[1200px] px-4 py-16 md:px-6 md:py-24">
        <GlassCard className="glow-signal-lg relative overflow-hidden px-6 py-14 text-center md:py-20">
          <div
            aria-hidden="true"
            className="hud-grid pointer-events-none absolute inset-0 opacity-50"
          />
          <div className="relative">
            <h2 className="text-3xl font-black tracking-[-0.025em] text-foreground md:text-4xl">
              {t.home.ctaTitle}
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground md:text-base">
              {t.home.ctaBody}
            </p>
            <Link
              href="/merge-pdf"
              className={cn(buttonClasses("primary", "lg"), "mt-8")}
            >
              {t.home.ctaButton}
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          </div>
        </GlassCard>
      </section>
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <dt className="hud-label text-[10px] text-muted-foreground">{label}</dt>
      <dd className="mt-1.5 text-2xl font-black tracking-[-0.02em] text-foreground md:text-3xl">
        {value}
      </dd>
    </div>
  );
}
