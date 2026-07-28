"use client";

import Link from "next/link";
import { Logo } from "@/components/layout/Logo";
import { Badge } from "@/components/ui/Badge";
import { useT } from "@/lib/i18n";
import { getLiveTools, toolHref } from "@/lib/tools-registry";

export function Footer() {
  const t = useT();
  const featured = getLiveTools().slice(0, 6);

  return (
    <footer className="mt-24 border-t border-white/10 bg-surface/60">
      <div className="mx-auto max-w-[1200px] px-4 py-12 md:px-6 md:py-16">
        <div className="grid gap-10 md:grid-cols-[1.4fr_repeat(4,1fr)]">
          <div>
            <Logo className="text-lg" />
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-muted-foreground">
              {t.footer.tagline}
            </p>
            <Badge variant="live" dot className="mt-4">
              {t.common.localAndZeroUploads}
            </Badge>
          </div>

          <FooterColumn title={t.footer.product}>
            <FooterLink href="/">{t.nav.home}</FooterLink>
            <FooterLink href="/tools">{t.nav.tools}</FooterLink>
            <FooterLink href="/pricing">{t.nav.pricing}</FooterLink>
            <FooterLink href="/recent">{t.nav.recent}</FooterLink>
          </FooterColumn>

          <FooterColumn title={t.footer.toolsColumn}>
            {featured.map((tool) => (
              <FooterLink key={tool.slug} href={toolHref(tool.slug)}>
                {t.tools[tool.slug].name}
              </FooterLink>
            ))}
          </FooterColumn>

          <FooterColumn title={t.footer.company}>
            <FooterLink href="/about">{t.nav.about}</FooterLink>
            <FooterLink href="/settings">{t.nav.settings}</FooterLink>
          </FooterColumn>

          <FooterColumn title={t.footer.legal}>
            <FooterLink href="/privacy">{t.footer.privacy}</FooterLink>
            <FooterLink href="/about">{t.footer.terms}</FooterLink>
            <FooterLink href="/about">{t.footer.cookies}</FooterLink>
            <FooterLink href="/about">{t.footer.licenses}</FooterLink>
          </FooterColumn>
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-white/10 pt-6 md:flex-row md:items-center md:justify-between">
          <span className="hud-label text-[10px] text-muted-foreground">
            {t.footer.rights}
          </span>
          <span className="hud-label text-[10px] text-muted-foreground">
            {t.common.brandFirst}
            {t.common.brandSecond}
          </span>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="hud-label text-[10px] text-foreground">{title}</h3>
      <ul className="mt-4 space-y-2.5">{children}</ul>
    </div>
  );
}

function FooterLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <li>
      <Link
        href={href}
        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        {children}
      </Link>
    </li>
  );
}
