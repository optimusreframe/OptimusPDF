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
 *
 * Disposicion (responsive): en movil todo en una columna centrada (marca, enlaces, derechos). Desde `md` la marca y los
 * derechos comparten la primera fila y los enlaces ocupan la segunda, a todo el ancho y alineados con la marca. Antes
 * eran tres columnas en fila: en tableta (834 px) y con la barra lateral (1194 px) los enlaces se partian en dos lineas, el
 * ultimo de la primera se quedaba con su «·» colgando y «Proyecto de Optimus Reframe.» se partia. Los enlaces ya no llevan
 * el separador «·» (texto de color atenuado a 3,1:1, bajo AA): los separa el espacio, que se parte sin dejar signos sueltos.
 */
const LEGAL_LINKS = [
  { href: "/privacy", labelKey: "privacy" as const },
  { href: "/about", labelKey: "terms" as const },
  { href: "/about", labelKey: "cookies" as const },
  { href: "/licenses", labelKey: "licenses" as const },
] as const;

export function Footer() {
  const t = useT();

  return (
    <footer data-chrome="footer" className="mt-24 border-t border-hairline">
      <div className="mx-auto flex max-w-[1200px] flex-col items-center gap-5 py-10 pl-[max(1rem,env(safe-area-inset-left,0px))] pr-[max(1rem,env(safe-area-inset-right,0px))] text-center md:flex-row md:flex-wrap md:justify-between md:gap-x-6 md:gap-y-3 md:pl-[max(1.5rem,env(safe-area-inset-left,0px))] md:pr-[max(1.5rem,env(safe-area-inset-right,0px))] md:text-left">
        <div className="flex flex-col items-center gap-3 md:order-1 md:flex-row md:gap-4">
          <Logo />
          <Badge variant="live" dot>
            {t.common.localAndZeroUploads}
          </Badge>
        </div>

        <nav
          aria-label={t.footer.legal}
          // Movil: cuadricula de columnas por ancho minimo en rem (3 + 3 a 320-430 px; menos columnas si se agranda la letra), asi
          // ningun enlace se queda solo en una segunda linea. Desde `sm`, una fila que se parte.
          className="grid w-full max-w-md grid-cols-[repeat(auto-fit,minmax(5.5rem,1fr))] items-center justify-items-center gap-x-2 gap-y-2 sm:flex sm:w-auto sm:max-w-none sm:flex-wrap sm:justify-center sm:gap-y-2 md:order-3 md:-ml-1 md:basis-full md:justify-start"
        >
          <FooterInlineLink href="/pricing">{t.nav.pricing}</FooterInlineLink>
          <FooterInlineLink href="/about">{t.nav.about}</FooterInlineLink>
          {LEGAL_LINKS.map((link) => (
            <FooterInlineLink key={link.labelKey} href={link.href}>
              {t.footer[link.labelKey]}
            </FooterInlineLink>
          ))}
        </nav>

        <span className="text-caption text-muted-foreground md:order-2">
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
      className="inline-flex h-11 items-center rounded-ios-sm px-1 text-footnote text-muted-foreground hover:text-foreground"
    >
      {children}
    </Link>
  );
}
