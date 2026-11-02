"use client";

import { GuardedLink as Link } from "@/components/layout/GuardedLink";
import { usePathname } from "next/navigation";
import { Clock, FolderOpen, House, Settings } from "lucide-react";
import { SidebarLink } from "@/components/layout/SidebarLink";
import { SidebarTree, matchesRoute } from "@/components/layout/SidebarTree";
import { useActiveSection } from "@/components/layout/activeSection";
import { useT } from "@/lib/i18n";
import { ACCENT_TEXT, getFeaturedTools, toolHref } from "@/lib/tools-registry";

/** Clases de un enlace secundario (Precios, Proyecto, Licencias): fila baja y discreta, de 44 px con dedo. */
const SECONDARY_LINK =
  "flex h-9 items-center rounded-ios-sm px-2.5 text-footnote pointer-coarse:h-11 text-muted-foreground transition-colors hover:bg-white/8 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal";

type Props = {
  /** Riel de iconos de la barra lateral plegada (solo escritorio): oculta rotulos, anidados y enlaces secundarios. */
  collapsed?: boolean;
  /** Se llama al pulsar cualquier enlace: la hoja del menu movil se cierra con el. */
  onNavigate?: () => void;
};

/**
 * Cuerpo de la navegacion: lo que va dentro del `<nav>` de la barra lateral de escritorio Y de la hoja del menu movil/tablet
 * (`MobileMenuSheet`). Un solo componente para los dos, asi el contenido y el orden NO pueden separarse: arriba Inicio,
 * Recientes y PDF Pro; luego las tres suites (`SidebarTree`); debajo Exportar / Importar (Documentos) y Ajustes; y al final
 * Precios, Proyecto y Licencias. La entrada activa es unica: en Inicio manda la seccion a la vista (scroll-spy); fuera de
 * Inicio, PDF Pro o la pagina de Recientes/Documentos/Ajustes (las herramientas las marca `SidebarTree` por su ruta).
 */
export function SidebarNavBody({ collapsed = false, onNavigate }: Props) {
  const t = useT();
  const pathname = usePathname();
  const activeSection = useActiveSection();

  const isHome = pathname === "/";
  const isRecent = matchesRoute(pathname, "/recent");
  const isDocuments = matchesRoute(pathname, "/documents");
  const isSettings = matchesRoute(pathname, "/settings");
  const featuredActive = getFeaturedTools().find((tool) => matchesRoute(pathname, toolHref(tool.slug)));
  /* Una sola entrada activa. En Home manda la seccion visible (la resuelve SidebarTree); si aun no hay ninguna (arriba
     del todo), «Inicio». Fuera de Home: PDF Pro, o la pagina de Recientes/Documentos/Ajustes; las herramientas las marca
     SidebarTree por su ruta. */
  const activeKey = isHome
    ? (activeSection ? "section" : "home")
    : featuredActive
      ? featuredActive.slug
      : isDocuments
        ? "documents"
        : isRecent
          ? "recent"
          : isSettings
            ? "settings"
            : null;

  return (
    <>
      <ul className="space-y-0.5">
        <SidebarLink
          href="/"
          icon={House}
          label={t.nav.home}
          active={activeKey === "home"}
          collapsed={collapsed}
          onClick={onNavigate}
        />
        <SidebarLink
          href="/recent"
          icon={Clock}
          label={t.nav.recent}
          active={activeKey === "recent"}
          collapsed={collapsed}
          onClick={onNavigate}
        />
        {getFeaturedTools().map((tool) => (
          <SidebarLink
            key={tool.slug}
            href={toolHref(tool.slug)}
            icon={tool.icon}
            label={t.tools[tool.slug].name}
            active={activeKey === tool.slug}
            collapsed={collapsed}
            iconClassName={ACCENT_TEXT[tool.accent]}
            onClick={onNavigate}
          />
        ))}
      </ul>

      <div className="mt-5">
        <SidebarTree
          pathname={pathname}
          collapsed={collapsed}
          spySection={activeSection}
          isHome={isHome}
          onNavigate={onNavigate}
        />
      </div>

      <div className="mt-4 border-t border-hairline pt-3">
        {collapsed ? null : (
          <p className="ui-label px-2.5 pb-1.5 text-caption text-muted-foreground">{t.nav.backupLabel}</p>
        )}
        <ul className="space-y-0.5">
          <SidebarLink
            href="/documents"
            icon={FolderOpen}
            label={t.nav.documents}
            active={activeKey === "documents"}
            collapsed={collapsed}
            onClick={onNavigate}
          />
          <SidebarLink
            href="/settings"
            icon={Settings}
            label={t.nav.settings}
            active={activeKey === "settings"}
            collapsed={collapsed}
            onClick={onNavigate}
          />
        </ul>
      </div>

      {collapsed ? null : (
        <ul className="mt-4 space-y-0.5 border-t border-hairline pt-3">
          {(
            [
              ["/pricing", t.nav.pricing],
              ["/about", t.nav.about],
              ["/licenses", t.nav.licenses],
            ] as const
          ).map(([href, label]) => (
            <li key={href}>
              <Link
                href={href}
                onClick={onNavigate}
                aria-current={matchesRoute(pathname, href) ? "page" : undefined}
                className={SECONDARY_LINK}
              >
                {label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
