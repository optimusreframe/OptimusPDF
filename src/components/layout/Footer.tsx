"use client";

import { GuardedLink as Link } from "@/components/layout/GuardedLink";
import { Logo } from "@/components/layout/Logo";
import { Badge } from "@/components/ui/Badge";
import { useT } from "@/lib/i18n";

/**
 * La navegacion principal ya vive en `Sidebar` (escritorio) y
 * `MobileTabBar` (movil): el footer no la repite, solo cierra la pagina
 * con la marca, la garantia de privacidad y los enlaces legales, en voz
 * baja (footnote, color atenuado, un hairline arriba).
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
    <footer data-chrome="footer" className="mt-24 border-t border-hairline">
      <div className="mx-auto flex max-w-[1200px] flex-col items-center gap-5 py-10 pl-[max(1rem,env(safe-area-inset-left,0px))] pr-[max(1rem,env(safe-area-inset-right,0px))] text-center md:flex-row md:justify-between md:gap-6 md:pl-[max(1.5rem,env(safe-area-inset-left,0px))] md:pr-[max(1.5rem,env(safe-area-inset-right,0px))] md:text-left">
        <div className="flex flex-col items-center gap-3 md:flex-row md:gap-4">
          <Logo />
          <Badge variant="live" dot>
            {t.common.localAndZeroUploads}
          </Badge>
        </div>

        <nav
          aria-label={t.footer.legal}
          className="flex flex-wrap items-center justify-center gap-x-1 gap-y-1"
        >
          <FooterInlineLink href="/pricing">{t.nav.pricing}</FooterInlineLink>
          <FooterInlineLink href="/about">{t.nav.about}</FooterInlineLink>
          {LEGAL_LINKS.map((link) => (
            <FooterInlineLink key={link.labelKey} href={link.href}>
              {t.footer[link.labelKey]}
            </FooterInlineLink>
          ))}
        </nav>

        <span className="text-caption text-muted-foreground">
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
      className="inline-flex h-11 items-center rounded-ios-sm px-1 text-footnote text-muted-foreground transition-colors after:ml-2 after:text-muted-foreground/40 after:content-['·'] last:after:content-none hover:text-foreground"
    >
      {children}
    </Link>
  );
}
