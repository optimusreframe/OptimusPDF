"use client";

import Link from "next/link";
import { Logo } from "@/components/layout/Logo";
import { Badge } from "@/components/ui/Badge";
import { useT } from "@/lib/i18n";
import { getLiveTools, toolHref } from "@/lib/tools-registry";

/**
 * En movil hay una tab bar fija (Inicio/Herramientas/Recientes/Ajustes,
 * ver `MobileTabBar`) que ya cubre esa navegacion: el footer compacto no
 * la repite, solo añade lo que la tab bar no tiene (Precios, legal).
 */
const MOBILE_LINKS = [
  { href: "/about", labelKey: "about" as const },
  { href: "/pricing", labelKey: "pricing" as const },
] as const;

export function Footer() {
  const t = useT();
  const featured = getLiveTools().slice(0, 6);

  return (
    <footer className="mt-24 border-t border-white/10 bg-surface/60">
      <div className="mx-auto max-w-[1200px] px-4 py-8 md:px-6 md:py-16">
        {/* Movil: compacto, sin duplicar la tab bar fija. */}
        <div className="flex flex-col items-center gap-4 text-center md:hidden">
          <Logo className="text-base" />
          <Badge variant="live" dot>
            {t.common.localAndZeroUploads}
          </Badge>
          <nav
            aria-label={t.footer.legal}
            className="flex flex-wrap items-center justify-center gap-x-1 gap-y-1.5"
          >
            {MOBILE_LINKS.map((link) => (
              <FooterInlineLink key={link.href} href={link.href}>
                {t.nav[link.labelKey]}
              </FooterInlineLink>
            ))}
            <FooterInlineLink href="/privacy">
              {t.footer.privacy}
            </FooterInlineLink>
            <FooterInlineLink href="/about">{t.footer.terms}</FooterInlineLink>
            <FooterInlineLink href="/about">
              {t.footer.cookies}
            </FooterInlineLink>
            <FooterInlineLink href="/about">
              {t.footer.licenses}
            </FooterInlineLink>
          </nav>
          <span className="hud-label text-[9px] text-muted-foreground">
            {t.footer.rights}
          </span>
        </div>

        {/* Escritorio: columnas completas. */}
        <div className="hidden gap-10 md:grid md:grid-cols-[1.4fr_repeat(4,1fr)]">
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

        <div className="mt-12 hidden flex-col gap-3 border-t border-white/10 pt-6 md:flex md:flex-row md:items-center md:justify-between">
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

function FooterInlineLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="hud-label text-[10px] text-muted-foreground transition-colors after:ml-1 after:text-muted-foreground/30 after:content-['·'] last:after:content-none hover:text-foreground"
    >
      {children}
    </Link>
  );
}
