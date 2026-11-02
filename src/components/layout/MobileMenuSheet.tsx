"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { LayoutGroup } from "motion/react";
import { Search } from "lucide-react";
import { LanguageToggle } from "@/components/layout/LanguageToggle";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { SidebarLink } from "@/components/layout/SidebarLink";
import { SidebarNavBody } from "@/components/layout/SidebarNavBody";
import { matchesRoute } from "@/components/layout/SidebarTree";
import {
  MOBILE_MENU_CONTENT_ID,
  closeMobileMenu,
  focusMenuTrigger,
  useMobileMenuOpen,
} from "@/components/layout/mobileMenu";
import { fold, searchTools } from "@/components/layout/navSearch";
import { Sheet } from "@/components/ui/Sheet";
import { Badge } from "@/components/ui/Badge";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useT } from "@/lib/i18n";
import { DESKTOP_QUERY } from "@/lib/touch/viewportTier";
import { ACCENT_TEXT, toolHref } from "@/lib/tools-registry";

/** Telefono horizontal (o cualquier pantalla de menos de 30 rem de alto): la hoja pasa a pantalla completa para no perder alto. */
const SHORT_QUERY = "(max-height: 479.98px)";

/*
 * Medidas de la hoja. `Sheet` fija `max-h-[88vh]` y su ancho de tarjeta en `md`; aqui se sustituyen (`!`) por alturas en `dvh`
 * (el alto REAL visible, sin la barra de direcciones del navegador movil) y la zona segura de arriba:
 *  - telefono (<768): casi toda la pantalla, con el borde superior de la pagina asomando bajo el velo (detente «grande» de iOS).
 *  - tablet (>=768): hoja de formulario centrada (la forma de iPadOS), de alto fijo para que desplegar una seccion no mueva el marco.
 */
const SHEET_SIZE = [
  "h-[calc(100dvh-env(safe-area-inset-top,0px)-0.75rem)]! max-h-[calc(100dvh-env(safe-area-inset-top,0px)-0.75rem)]!",
  "md:h-[min(46rem,calc(100dvh-4rem))]! md:max-h-[min(46rem,calc(100dvh-4rem))]!",
].join(" ");

/**
 * Hoja del menu de movil y tablet: el MISMO contenido y orden que la barra lateral de escritorio (`SidebarNavBody`), con
 * buscador arriba y, al pie, el idioma y el tema. La abren la quinta pestaña de `MobileTabBar` (<768 px) y el boton «Menu» de
 * `Header` (768-1023 px); por encima de 1024 px manda `Sidebar` y la hoja se cierra sola.
 *
 * Todo el comportamiento de hoja (arrastre para cerrar con la velocidad del dedo, velo, Escape, foco atrapado, scroll del
 * fondo bloqueado, `overscroll-behavior: contain`, zona segura, reduced motion) viene de `Sheet`: no hay un segundo sistema.
 * Ademas: el resto de la pagina queda `inert`, el foco vuelve al disparador que se vea y la hoja se cierra al navegar. No
 * toca el historial: «Atras» del navegador navega como siempre y, al cambiar la ruta, la hoja se cierra.
 */
export function MobileMenuSheet() {
  const t = useT();
  const open = useMobileMenuOpen();
  const pathname = usePathname();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const short = useMediaQuery(SHORT_QUERY);

  // Cerrar al navegar (Atras/Adelante o un enlace que no pasa por la hoja). Solo cuando la ruta CAMBIA, no al montar.
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    closeMobileMenu();
  }, [pathname]);

  // A partir de 1024 px la barra lateral hace de menu: una hoja que quedara abierta tapando la pagina no tiene sentido.
  useEffect(() => {
    if (desktop) closeMobileMenu();
  }, [desktop]);

  return (
    <Sheet
      open={open && !desktop}
      onClose={closeMobileMenu}
      title={t.nav.menu}
      closeLabel={t.nav.closeMenu}
      inertBackground
      mobileFullscreen={short}
      // El foco vuelve al disparador visible (el de la pestaña o el de la cabecera, segun el giro); si no hay ninguno, `Sheet` decide.
      restoreFocusOnClose={() => !focusMenuTrigger()}
      className={short ? undefined : SHEET_SIZE}
    >
      <MenuContent />
    </Sheet>
  );
}

/** Lo que recibe el foco con Tab (los `tabindex="-1"` de un control con tabindex itinerante, como el selector de tema, no). */
const TABBABLE = [
  'a[href]:not([tabindex="-1"])',
  'button:not([disabled]):not([tabindex="-1"])',
  'input:not([disabled]):not([type="hidden"]):not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * Tab cicla dentro de la hoja. `Sheet` atrapa el foco con el primer y el ultimo control del DOM, pero el selector de tema
 * (tabindex itinerante: solo la opcion elegida es tabulable) acaba la hoja con una opcion que NO recibe el foco con Tab: desde
 * la ultima tabulable el foco se escapaba a la barra del navegador. Aqui se calcula el ultimo y el primero TABULABLES de verdad
 * y, desde ellos, se salta al otro extremo; `Sheet` ya no encuentra nada que corregir.
 */
function wrapTab(event: ReactKeyboardEvent<HTMLElement>): void {
  if (event.key !== "Tab") return;
  const dialog = event.currentTarget.closest<HTMLElement>('[role="dialog"]');
  if (!dialog) return;
  const tabbable = Array.from(dialog.querySelectorAll<HTMLElement>(TABBABLE)).filter((element) => element.getClientRects().length > 0);
  if (tabbable.length === 0) return;
  const current = document.activeElement;
  const first = tabbable[0];
  const last = tabbable[tabbable.length - 1];
  if (event.shiftKey ? current === first || current === dialog : current === last) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

/** Contenido de la hoja. Se monta con la hoja: al cerrarla el buscador vuelve a estar vacio. */
function MenuContent() {
  const t = useT();
  // La ruta se congela al abrir: al elegir un resultado la ruta cambia mientras la hoja se retira, y una pastilla activa nueva
  // (con `layoutId`) dentro del contenido que sale deja la salida sin completar y la hoja, ya fuera de pantalla, sin desmontar.
  const [pathname] = useState(usePathname());
  const [query, setQuery] = useState("");
  const results = searchTools(t, query);
  const searching = fold(query.trim()).length > 0;

  return (
    // Los indicadores animados de la fila activa comparten `layoutId` con los de la barra lateral (que sigue montada, oculta):
    // sin un grupo propio, motion intentaria animar la pastilla de una a otra al abrir la hoja.
    <LayoutGroup id="mobile-menu">
      <div id={MOBILE_MENU_CONTENT_ID} onKeyDown={wrapTab} className="flex min-h-full flex-col">
        <div role="search" className="pt-1.5 pb-3">
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // Escape con texto limpia la busqueda (como en la barra lateral); con el campo vacio cierra la hoja (lo hace `Sheet`).
                if (event.key === "Escape" && query) {
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery("");
                }
              }}
              placeholder={t.nav.searchPlaceholder}
              aria-label={t.nav.searchPlaceholder}
              enterKeyHint="search"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className="h-10 w-full rounded-ios-sm border border-hairline pointer-coarse:h-11 bg-white/5 pr-3 pl-9 text-subheadline text-foreground placeholder:text-muted-foreground focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
            />
          </div>
        </div>

        <nav aria-label={t.nav.menu} className="flex-1">
          {searching ? (
            <div>
              <p role="status" className="ui-label px-2.5 pb-1.5 text-caption text-muted-foreground">
                {results.length === 0
                  ? t.nav.searchEmpty
                  : `${results.length} ${results.length === 1 ? t.home.resultOne : t.home.resultMany}`}
              </p>
              {results.length > 0 ? (
                <ul aria-label={t.nav.searchResults} className="space-y-0.5">
                  {results.map((tool) => (
                    <SidebarLink
                      key={tool.slug}
                      href={toolHref(tool.slug)}
                      icon={tool.icon}
                      iconClassName={ACCENT_TEXT[tool.accent]}
                      label={t.tools[tool.slug].name}
                      active={matchesRoute(pathname, toolHref(tool.slug))}
                      collapsed={false}
                      soon={tool.status === "soon"}
                      onClick={closeMobileMenu}
                    />
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <SidebarNavBody onNavigate={closeMobileMenu} />
          )}
        </nav>
        <Badge variant="live" dot className="mt-5 max-w-full self-start">
          {t.common.localAndZeroUploads}
        </Badge>

        {/*
         * Idioma y tema a la vista, como al pie de la barra lateral: pegajoso abajo del desplazamiento de la hoja (solo con
         * 41 rem de alto o mas: en un iPhone SE o un telefono horizontal el pie se llevaria un cuarto de la pantalla y pasa al
         * final de la lista). `Sheet` le deja al contenido 1.25 rem a los lados (o la zona segura) y 1.5 rem + zona segura
         * abajo; aqui se anulan con margenes negativos para que el pie llegue de borde a borde y quede en el mismo sitio pegado
         * que sin pegar (sin salto al final). Fondo OPACO (el del material, sin transparencia): la lista pasa por debajo y un
         * pie translucido dejaria ver sus textos.
         */}
        <div
          data-menu-footer=""
          className="[@media(min-height:41rem)]:sticky z-10 mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-hairline bg-surface"
          style={{
            backgroundColor: "oklch(from var(--material-thick-bg) l c h / 1)",
            marginLeft: "calc(-1 * max(1.25rem, env(safe-area-inset-left, 0px)))",
            marginRight: "calc(-1 * max(1.25rem, env(safe-area-inset-right, 0px)))",
            marginBottom: "calc(-1 * (1.5rem + env(safe-area-inset-bottom, 0px)))",
            // Chromium pega lo `sticky` al borde del CONTENIDO del desplazamiento (descuenta su padding): se compensa para llegar al borde.
            bottom: "calc(-1 * (1.5rem + env(safe-area-inset-bottom, 0px)))",
            paddingLeft: "max(1.25rem, env(safe-area-inset-left, 0px))",
            paddingRight: "max(1.25rem, env(safe-area-inset-right, 0px))",
            paddingTop: "0.375rem",
            paddingBottom: "calc(0.375rem + env(safe-area-inset-bottom, 0px))",
          }}
        >
          <LanguageToggle />
          <ThemeToggle className="min-w-0 flex-1 basis-40" />
        </div>
      </div>
    </LayoutGroup>
  );
}
