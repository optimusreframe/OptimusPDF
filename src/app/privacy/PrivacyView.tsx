"use client";

import Link from "next/link";
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
        <h1 className="mt-5 text-title-1 text-foreground">
          {s.title}
        </h1>
        <p className="mt-3 text-base text-muted-foreground md:text-lg">
          {s.subtitle}
        </p>
        <p className="mt-4 text-caption text-muted-foreground">
          {s.effectiveDate}
        </p>
      </header>

      <div className="mt-10 space-y-8">
        {s.sections.map((section) => (
          <section key={section.title}>
            <h2 className="mb-3 text-headline text-foreground">
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
              {section.key === "thirdParties" ? (
                <ul className="list-inside list-disc space-y-1">
                  {s.thirdPartyLinks.map((link) => (
                    <li key={link.href}>
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-foreground underline underline-offset-2 hover:text-muted-foreground md:text-base"
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </section>
        ))}
      </div>

      <GlassCard className="mt-10 p-7">
        <h2 className="text-headline text-foreground">
          {s.contactTitle}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {s.contactBody}{" "}
          <Link
            href="/about"
            className="text-foreground underline underline-offset-2 hover:text-muted-foreground"
          >
            {s.contactLinkLabel}
          </Link>
          .
        </p>
      </GlassCard>
    </div>
  );
}
