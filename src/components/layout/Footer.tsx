"use client";

import Link from "next/link";
import { Logo } from "@/components/layout/Logo";
import { Badge } from "@/components/ui/Badge";
import { useT } from "@/lib/i18n";

/**
 * La navegacion principal ya vive en `Sidebar` (escritorio) y
 * `MobileTabBar` (movil): el footer no la repite, solo cierra la pagina
 * con la marca, la garantia de privacidad y los enlaces legales.
 */
const LEGAL_LINKS = [
  { href: "/privacy", labelKey: "privacy" as const },
  { href: "/about", labelKey: "terms" as const },
  { href: "/about", labelKey: "cookies" as const },
  { href: "/about", labelKey: "licenses" as const },
] as const;

export function Footer() {
  const t = useT();

  return (
    <footer className="mt-24 border-t border-white/10 bg-surface/60">
      <div className="mx-auto flex max-w-[1200px] flex-col items-center gap-4 px-4 py-8 text-center md:flex-row md:justify-between md:gap-6 md:px-6 md:text-left">
        <div className="flex flex-col items-center gap-3 md:flex-row md:items-center md:gap-4">
          <Logo />
          <Badge variant="live" dot>
            {t.common.localAndZeroUploads}
          </Badge>
        </div>

        <nav
          aria-label={t.footer.legal}
          className="flex flex-wrap items-center justify-center gap-x-1 gap-y-1.5"
        >
          <FooterInlineLink href="/pricing">{t.nav.pricing}</FooterInlineLink>
          <FooterInlineLink href="/about">{t.nav.about}</FooterInlineLink>
          {LEGAL_LINKS.map((link) => (
            <FooterInlineLink key={link.labelKey} href={link.href}>
              {t.footer[link.labelKey]}
            </FooterInlineLink>
          ))}
        </nav>

        <span className="hud-label text-[9px] text-muted-foreground">
          {t.footer.rights}
        </span>
      </div>
    </footer>
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
