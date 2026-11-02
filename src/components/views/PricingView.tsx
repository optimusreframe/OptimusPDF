"use client";

import Link from "next/link";
import { Check, Lock } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { buttonClasses } from "@/components/ui/Button";
import { GlassCard } from "@/components/ui/GlassCard";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";

export function PricingView() {
  const t = useT();

  return (
    <div className="mx-auto max-w-[1200px] px-4 pt-10 pb-16 md:px-6 md:pt-16">
      <header className="max-w-2xl">
        <h1 className="text-title-1 text-foreground">
          {t.pricing.title}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground md:text-base">
          {t.pricing.subtitle}
        </p>
      </header>

      <div className="mt-10 grid gap-4 md:grid-cols-2">
        {/* Plan local */}
        <GlassCard className="glow-signal relative flex min-w-0 flex-col p-7">
          <Badge variant="live" dot className="self-start">
            {t.common.localBadge}
          </Badge>
          <h2 className="mt-4 text-title-2 text-foreground">
            {t.pricing.freeName}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t.pricing.freeTagline}
          </p>
          <p className="mt-6 flex flex-wrap items-baseline gap-x-2">
            <span className="text-title-1 text-foreground tabular-nums">
              {t.pricing.freePrice}
            </span>
            <span className="text-caption text-muted-foreground">
              {t.pricing.freePeriod}
            </span>
          </p>

          <ul className="mt-7 flex-1 space-y-3">
            {t.pricing.freeFeatures.map((feature) => (
              <li key={feature} className="flex items-start gap-2.5">
                <Check
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-success"
                />
                <span className="text-sm text-muted-foreground">{feature}</span>
              </li>
            ))}
          </ul>

          <Link
            href="/"
            className={cn(buttonClasses("primary", "lg", undefined, true), "mt-8 w-full")}
          >
            {t.pricing.freeCta}
          </Link>
        </GlassCard>

        {/* Plan servidor (aun no existe) */}
        <GlassCard className="flex min-w-0 flex-col p-7 opacity-90">
          <Badge variant="soon" className="self-start">
            {t.common.soon}
          </Badge>
          <h2 className="mt-4 text-title-2 text-foreground">
            {t.pricing.proName}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t.pricing.proTagline}
          </p>
          <p className="mt-6 flex flex-wrap items-baseline gap-x-2">
            <span className="text-title-1 text-muted-foreground tabular-nums">
              {t.pricing.proPrice}
            </span>
            <span className="text-caption text-muted-foreground">
              {t.pricing.proPeriod}
            </span>
          </p>

          <ul className="mt-7 flex-1 space-y-3">
            {t.pricing.proFeatures.map((feature) => (
              <li key={feature} className="flex items-start gap-2.5">
                <Lock
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                />
                <span className="text-sm text-muted-foreground">{feature}</span>
              </li>
            ))}
          </ul>

          <span
            className={cn(
              buttonClasses("secondary", "lg", undefined, true),
              "mt-8 w-full cursor-not-allowed opacity-50",
            )}
            aria-disabled="true"
          >
            {t.pricing.proCta}
          </span>
        </GlassCard>
      </div>

      <section className="mt-12 grid gap-4 md:grid-cols-2">
        <GlassCard className="p-7">
          <h2 className="text-headline text-foreground">
            {t.pricing.honestyTitle}
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            {t.pricing.honestyBody}
          </p>
        </GlassCard>

        <GlassCard className="p-7">
          <h2 className="text-headline text-foreground">
            {t.pricing.faqTitle}
          </h2>
          <dl className="mt-4 space-y-4">
            {t.pricing.faq.map((item) => (
              <div key={item.q}>
                <dt className="text-sm font-semibold text-foreground">
                  {item.q}
                </dt>
                <dd className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  {item.a}
                </dd>
              </div>
            ))}
          </dl>
        </GlassCard>
      </section>
    </div>
  );
}
