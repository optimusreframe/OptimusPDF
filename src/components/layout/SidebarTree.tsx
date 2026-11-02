"use client";

import { GuardedLink as Link } from "@/components/layout/GuardedLink";
import { useId, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import {
  DisabledEntry,
  SidebarLink,
  sidebarRowClasses,
  ActivePill,
} from "@/components/layout/SidebarLink";
import { requestSection } from "@/components/layout/activeSection";
import { Badge } from "@/components/ui/Badge";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import {
  ACCENT_TEXT,
  CATEGORY_ICON,
  CATEGORY_ORDER,
  GROUP_ICON,
  DOWNLOADER_PLATFORMS,
  GROUP_ORDER,
  SUITE_ICON,
  getToolsByCategory,
  getToolsByGroup,
  getToolsBySuite,
  toolHref,
  type SectionId,
  type Tool,
  type ToolSuite,
} from "@/lib/tools-registry";

/** La ruta actual es la de esta herramienta (o una subruta suya). */
export function matchesRoute(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/* ------------------------------------------------------------------ *
 * Secciones desplegadas. Mismo patron de almacen externo que el colapso
 * de la barra: el snapshot del servidor es fijo («nada elegido») y el
 * cliente se sincroniza con el almacenamiento de SESION (sessionStorage:
 * sobrevive a recargar la pestana, no a cerrarla; deliberadamente no es un
 * ajuste del paquete de copia de seguridad) sin setState en un efecto. Lo
 * guardado es SOLO la eleccion explicita de la persona ({id: boolean});
 * sin eleccion, una seccion se abre sola cuando contiene la pagina
 * actual (eso se deriva de la ruta, tambien en el servidor: sin parpadeo).
 * ------------------------------------------------------------------ */

export const SECTIONS_STORAGE_KEY = "optimuspdf.sidebarSections";
const EMPTY_SECTIONS = "{}";

let cachedSections: string | null = null;
const sectionListeners = new Set<() => void>();

function normalizeSections(raw: string | null): string {
  if (!raw) return EMPTY_SECTIONS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY_SECTIONS;
    const clean: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) if (typeof value === "boolean") clean[key] = value;
    return JSON.stringify(clean);
  } catch {
    return EMPTY_SECTIONS;
  }
}

function getSectionsSnapshot(): string {
  if (cachedSections === null) {
    try {
      cachedSections = normalizeSections(window.sessionStorage.getItem(SECTIONS_STORAGE_KEY));
    } catch {
      cachedSections = EMPTY_SECTIONS;
    }
  }
  return cachedSections;
}

function getSectionsServerSnapshot(): string {
  return EMPTY_SECTIONS;
}

function subscribeSections(listener: () => void): () => void {
  sectionListeners.add(listener);
  return () => {
    sectionListeners.delete(listener);
  };
}

function writeSection(id: string, open: boolean): void {
  const next = { ...(JSON.parse(getSectionsSnapshot()) as Record<string, boolean>), [id]: open };
  cachedSections = JSON.stringify(next);
  try {
    window.sessionStorage.setItem(SECTIONS_STORAGE_KEY, cachedSections);
  } catch {
    // Se mantiene en memoria aunque no se pueda persistir.
  }
  for (const listener of sectionListeners) listener();
}

/** Solo para pruebas: olvida lo leido del almacenamiento para que el siguiente render vuelva a leerlo. */
export function resetSidebarSectionsForTests(): void {
  cachedSections = null;
}

/* ------------------------------------------------------------------ */

type TreeProps = {
  pathname: string;
  collapsed: boolean;
  /** Seccion de Inicio a la vista (scroll-spy); solo cuenta en Inicio. */
  spySection: SectionId | null;
  isHome: boolean;
};

/**
 * Arbol «CATEGORIAS» de la barra lateral: tres suites (OptimusPDF con sus seis categorias, OptimusSCAN y OptimusTOOLS con
 * sus grupos). Cada categoria/grupo es un enlace a su ancla de Inicio MAS un boton que despliega sus herramientas; cada
 * herramienta se muestra segun su `status` (live = enlace normal, soon = enlace con «Pronto» a su pagina provisional).
 * Plegada la barra (riel de iconos) solo quedan los iconos-enlace de cada seccion.
 */
export function SidebarTree({ pathname, collapsed, spySection, isHome }: TreeProps) {
  const t = useT();
  const stored = useSyncExternalStore(subscribeSections, getSectionsSnapshot, getSectionsServerSnapshot);
  const explicit = useMemo(() => JSON.parse(stored) as Record<string, boolean>, [stored]);
  const labelId = useId();

  const isOpen = (id: string, tools: Tool[]): boolean =>
    id in explicit ? explicit[id] : containsActive(tools);
  const containsActive = (tools: Tool[]): boolean =>
    tools.some((tool) => matchesRoute(pathname, toolHref(tool.slug)));

  const toolLink = (tool: Tool): ReactNode => (
    <SidebarLink
      key={tool.slug}
      href={toolHref(tool.slug)}
      icon={tool.icon}
      iconClassName={ACCENT_TEXT[tool.accent]}
      label={t.tools[tool.slug].name}
      active={!isHome && matchesRoute(pathname, toolHref(tool.slug))}
      collapsed={false}
      nested
      soon={tool.status === "soon"}
    />
  );

  const section = (
    id: SectionId,
    icon: LucideIcon,
    label: string,
    tools: Tool[],
    extra?: ReactNode,
    soon?: boolean,
  ): ReactNode => {
    const open = isOpen(id, tools);
    return (
      <SectionRow
        key={id}
        id={id}
        icon={icon}
        label={label}
        open={open}
        collapsed={collapsed}
        active={isHome && spySection === id}
        containsActive={containsActive(tools)}
        soon={soon}
      >
        {tools.map(toolLink)}
        {extra}
      </SectionRow>
    );
  };

  const scanTools = getToolsBySuite("scan");
  const pdfTools = (
    <>
      {CATEGORY_ORDER.map((category) =>
        section(category, CATEGORY_ICON[category], t.categories[category].label, getToolsByCategory(category)),
      )}
    </>
  );
  const scanEntries = (
    <>
      {scanTools.map((tool) => (
        <SidebarLink
          key={tool.slug}
          href={toolHref(tool.slug)}
          icon={tool.icon}
          iconClassName={ACCENT_TEXT[tool.accent]}
          label={t.tools[tool.slug].name}
          active={isHome ? spySection === "scan" : matchesRoute(pathname, toolHref(tool.slug))}
          collapsed={collapsed}
          soon={tool.status === "soon"}
        />
      ))}
    </>
  );
  const toolsEntries = (
    <>
      {GROUP_ORDER.map((group) => {
        const tools = getToolsByGroup(group);
        // El Downloader entero es «proximamente»: su fila lo dice aunque el desplegable tambien muestre cada entrada.
        const allSoon = tools.every((tool) => tool.status === "soon");
        return section(
          group,
          GROUP_ICON[group],
          t.groups[group].label,
          tools,
          group === "downloader"
            ? DOWNLOADER_PLATFORMS.map((name) => <DisabledEntry key={name} label={name} badge />)
            : null,
          allSoon && group === "downloader",
        );
      })}
      {collapsed ? null : <DisabledEntry label={t.nav.moreSoon} />}
    </>
  );

  const suites: { suite: ToolSuite; body: ReactNode }[] = [
    { suite: "pdf", body: pdfTools },
    { suite: "scan", body: scanEntries },
    { suite: "tools", body: toolsEntries },
  ];

  return (
    <div>
      {collapsed ? null : (
        <p id={labelId} className="ui-label px-2.5 pb-1.5 text-caption text-muted-foreground">
          {t.nav.categoriesLabel}
        </p>
      )}
      <ul aria-labelledby={collapsed ? undefined : labelId} aria-label={collapsed ? t.nav.categoriesLabel : undefined} className="space-y-3">
        {suites.map(({ suite, body }) => (
          <SuiteGroup key={suite} suite={suite} collapsed={collapsed}>
            {body}
          </SuiteGroup>
        ))}
      </ul>
    </div>
  );
}

function SuiteGroup({ suite, collapsed, children }: { suite: ToolSuite; collapsed: boolean; children: ReactNode }) {
  const t = useT();
  const Icon = SUITE_ICON[suite];
  const id = useId();
  return (
    <li className={collapsed ? "border-t border-hairline pt-2 first:border-t-0 first:pt-0" : undefined}>
      {collapsed ? null : (
        <p id={id} className="flex h-8 items-center gap-2 px-2.5 text-footnote font-semibold text-foreground">
          <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{t.suites[suite].label}</span>
        </p>
      )}
      <ul aria-labelledby={collapsed ? undefined : id} aria-label={collapsed ? t.suites[suite].label : undefined} className="space-y-0.5">
        {children}
      </ul>
    </li>
  );
}

type SectionRowProps = {
  id: SectionId;
  icon: LucideIcon;
  label: string;
  open: boolean;
  collapsed: boolean;
  /** Es la seccion que Inicio tiene a la vista (scroll-spy). */
  active: boolean;
  /** La pagina actual es una herramienta de esta seccion. */
  containsActive: boolean;
  soon?: boolean;
  children: ReactNode;
};

/**
 * Fila de seccion: enlace al ancla de Inicio (`/#id`, como siempre) + boton `aria-expanded` que despliega sus herramientas.
 * `aria-controls` solo existe con el panel montado (un idref colgado rompe `aria-valid-attr-value`).
 */
function SectionRow({ id, icon: Icon, label, open, collapsed, active, containsActive, soon, children }: SectionRowProps) {
  const t = useT();
  const panelId = useId();

  return (
    <li>
      <div className="flex items-center">
        <Link
          href={`/#${id}`}
          onClick={() => requestSection(id)}
          title={collapsed ? label : undefined}
          aria-current={active ? "page" : undefined}
          className={sidebarRowClasses({ active, collapsed, containsActive })}
        >
          {active ? <ActivePill /> : null}
          <Icon aria-hidden="true" className="size-[18px] shrink-0" />
          {collapsed ? null : <span className="truncate">{label}</span>}
          {soon && !collapsed ? (
            <Badge variant="soon" className="ml-auto shrink-0">
              {t.nav.soonShort}
            </Badge>
          ) : null}
          {soon && collapsed ? <span className="sr-only">{t.nav.soonShort}</span> : null}
        </Link>
        {collapsed ? null : (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            aria-label={`${t.nav.toggleSection} ${label}`}
            onClick={() => writeSection(id, !open)}
            className="group flex size-10 shrink-0 items-center justify-center rounded-ios-sm pointer-coarse:size-11 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "size-4 text-muted-foreground transition-[rotate,color] duration-[var(--duration-fast)] ease-[var(--ease-spring)] group-hover:text-foreground",
                open && "rotate-90",
              )}
            />
          </button>
        )}
      </div>
      {open && !collapsed ? (
        <ul id={panelId} className="mt-0.5 mb-1 ml-[1.375rem] space-y-0.5 border-l border-hairline pl-2">
          {children}
        </ul>
      ) : null}
    </li>
  );
}
