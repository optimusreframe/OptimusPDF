"use client";

import { GuardedLink as Link } from "@/components/layout/GuardedLink";
import { Menu } from "lucide-react";
import { Logo } from "@/components/layout/Logo";
import { LanguageToggle } from "@/components/layout/LanguageToggle";
import { MobileMenuSheet } from "@/components/layout/MobileMenuSheet";
import { useMenuTrigger } from "@/components/layout/mobileMenu";
import { useScrollEdge } from "@/components/layout/useScrollEdge";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";

/**
 * Cabecera fija por debajo de 1024px (a partir de ahi manda el Sidebar).
 * Material grueso con el contenido pasando por debajo; el borde inferior
 * no es un divisor fijo sino el efecto de borde de scroll (aparece solo
 * cuando hay contenido desplazado). En tablet (>=768px) lleva el boton
 * «Menu», que abre la MISMA hoja que la quinta pestaña de la barra inferior
 * del telefono (`MobileMenuSheet`: el contenido y el orden de la barra
 * lateral). Sustituye al popover «Herramientas»: era un desplegable de 640 px
 * con solo el catalogo (sin buscador, Recientes, Documentos, Ajustes, idioma
 * ni tema), de alto no acotado a la ventana y con dos columnas que con la fuente
 * del sistema al 150 % no cabian; la hoja es de un solo sistema de foco, scroll
 * y cierre para telefono y tablet.
 */
export function Header() {
  const t = useT();
  const scrolled = useScrollEdge("top");
  const trigger = useMenuTrigger();

  return (
    <header
      data-site-header=""
      data-scrolled={scrolled ? "true" : "false"}
      className="material-thick scroll-edge-bottom safe-top sticky top-0 z-40 lg:hidden"
      /* El material trae borde en los cuatro lados; una barra pegada al
         viewport no debe dibujar ninguno: el hairline lo pone el borde de
         scroll cuando toca. Inline porque `border-0` pierde en la cascada
         frente al shorthand del material. */
      style={{ borderWidth: 0 }}
    >
      <div className="@container mx-auto flex h-14 max-w-[1200px] items-center gap-4 pl-[max(1rem,env(safe-area-inset-left,0px))] pr-[max(1rem,env(safe-area-inset-right,0px))] md:h-16 md:pl-[max(1.5rem,env(safe-area-inset-left,0px))] md:pr-[max(1.5rem,env(safe-area-inset-right,0px))]">
        <Logo />

        <div className="hidden flex-1 md:block">
          <button
            type="button"
            {...trigger}
            className={cn(
              "flex h-9 items-center gap-2 rounded-full px-3 text-subheadline font-medium whitespace-nowrap select-none pointer-coarse:h-11",
              "transition-[color,background-color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
              "active:scale-[0.97] active:duration-[80ms]",
              "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal",
              trigger["aria-expanded"] ? "bg-white/10 text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Menu aria-hidden="true" className="size-4" />
            {t.nav.menu}
          </button>
        </div>

        {/* Enlaces secundarios: solo si caben. Con la fuente del sistema al 150 % en un iPad de 834 px sumaban 118 px de desborde
            horizontal; el umbral esta en rem (consulta de contenedor), asi que se adapta a cualquier tamano de fuente. */}
        <div className="ml-auto flex items-center gap-1 md:ml-0">
          <Link
            href="/documents"
            className="hidden h-9 items-center rounded-full px-3 text-subheadline text-muted-foreground transition-colors pointer-coarse:h-11 hover:text-foreground md:@min-[42rem]:flex"
          >
            {t.nav.documents}
          </Link>
          <Link
            href="/pricing"
            className="hidden h-9 items-center rounded-full px-3 text-subheadline text-muted-foreground transition-colors pointer-coarse:h-11 hover:text-foreground md:@min-[42rem]:flex"
          >
            {t.nav.pricing}
          </Link>
          <Link
            href="/about"
            className="hidden h-9 items-center rounded-full px-3 text-subheadline text-muted-foreground transition-colors pointer-coarse:h-11 hover:text-foreground md:@min-[42rem]:flex"
          >
            {t.nav.about}
          </Link>
          <LanguageToggle className="md:ml-2" />
        </div>
      </div>
      {/* Una sola hoja para telefono y tablet (la abre este boton o la pestaña «Menu»); va en un portal, aqui solo se monta. */}
      <MobileMenuSheet />
    </header>
  );
}
