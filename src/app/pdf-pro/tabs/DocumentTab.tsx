"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { ChevronRight, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { useFocusTarget } from "@/components/tool/useFocusTarget";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { getTool, toolHref, type ToolSlug } from "@/lib/tools-registry";
import { ProHomePanel } from "@/app/pdf-pro/ProHomePanel";
import { getProStrings } from "@/app/pdf-pro/proStrings";
import { DocSummary } from "@/app/pdf-pro/tabs/DocSummary";
import { DocToolRunner } from "@/app/pdf-pro/tabs/DocToolRunner";
import { DOC_TOOLS } from "@/app/pdf-pro/tabs/docToolDefinitions";
import type { DocToolId } from "@/app/pdf-pro/tabs/docToolsStrings";

/** Herramientas sueltas que se abren aparte (el documento de trabajo sigue aqui). */
const LOOSE_TOOLS: readonly ToolSlug[] = ["merge-pdf", "split-pdf", "organize-pdf", "sign-pdf"];

/**
 * Pestaña «Inicio» (Wave 7 · U5): resumen del documento, herramientas de documento (cada una abre su panel
 * contextual con «Aplicar»), acciones rapidas con el historial (`ProHomePanel`) y accesos a otras
 * herramientas sueltas en otra pestaña del navegador.
 *
 * Foco: al abrir una herramienta va a su titulo; al volver, al boton de esa misma herramienta.
 */
export function DocumentTab() {
  const { t, language } = useI18n();
  const s = getProStrings(language).docTools;
  const [openId, setOpenId] = useState<DocToolId | null>(null);
  const buttonRefs = useRef(new Map<DocToolId, HTMLButtonElement>());
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const returnTo = useRef<DocToolId | null>(null);

  const tools = DOC_TOOLS.filter((tool) => tool.tab === "home");
  const open = DOC_TOOLS.find((tool) => tool.id === openId) ?? null;

  // Foco con destino logico (`useFocusTarget`): al abrir una herramienta, a su titulo; al volver, al boton de esa misma
  // herramienta. Se aplica en la fase de layout del commit que cambia el contenido: nunca pasa por <body>.
  const { request: askFocus } = useFocusTarget<"heading" | "return">((target) => ({
    candidates: [target === "heading" ? headingRef.current : returnTo.current ? (buttonRefs.current.get(returnTo.current) ?? null) : null],
  }));

  const openTool = useCallback(
    (id: DocToolId) => {
      setOpenId(id);
      askFocus("heading");
    },
    [askFocus],
  );

  const back = useCallback(() => {
    returnTo.current = openId;
    setOpenId(null);
    askFocus("return");
  }, [openId, askFocus]);

  if (open) {
    return <DocToolRunner key={open.id} tool={open} onBack={back} headingRef={headingRef} />;
  }

  return (
    <div className="space-y-6" data-doc-tab="home">
      <DocSummary />

      <section aria-labelledby="pro-doc-tools-title">
        <h2 id="pro-doc-tools-title" className="ui-label mb-1 text-muted-foreground">
          {s.launcher.title}
        </h2>
        <p className="mb-2 text-footnote text-muted-foreground">{s.launcher.hint}</p>
        <ul className="space-y-2">
          {tools.map((tool) => {
            const Icon = tool.icon;
            const text = s.tools[tool.id];
            return (
              <li key={tool.id}>
                <button
                  type="button"
                  ref={(node) => {
                    if (node) buttonRefs.current.set(tool.id, node);
                    else buttonRefs.current.delete(tool.id);
                  }}
                  data-doc-tool-open={tool.id}
                  aria-label={s.launcher.open(text.title)}
                  onClick={() => openTool(tool.id)}
                  className={cn(
                    "material-thin flex min-h-11 w-full items-center gap-3 rounded-ios-sm px-3 py-2 text-left",
                    "transition-colors duration-[var(--duration-fast)] hover:bg-white/10 forced-colors:border forced-colors:border-[ButtonText]",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
                  )}
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0 text-signal" />
                  <span className="min-w-0 flex-1">
                    {/* (M2 · VI-02) El titulo envuelve en vez de truncarse («Reco…» a 320 px) y la etiqueta de red baja bajo el. */}
                    <span className="block text-subheadline font-semibold break-words text-foreground">{text.title}</span>
                    {tool.needsNetwork ? (
                      <span className="mt-0.5 mb-0.5 block">
                        <Badge variant="neutral">{s.runner.networkBadge}</Badge>
                      </span>
                    ) : null}
                    <span className="block text-footnote text-muted-foreground">{text.description}</span>
                  </span>
                  <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <ProHomePanel />

      <section aria-labelledby="pro-loose-title">
        <h2 id="pro-loose-title" className="ui-label mb-1 text-muted-foreground">
          {s.launcher.looseTitle}
        </h2>
        <p className="mb-2 text-footnote text-muted-foreground">{s.launcher.looseHint}</p>
        <ul className="flex flex-wrap gap-2">
          {LOOSE_TOOLS.map((slug) => {
            const name = t.tools[slug].name;
            const ToolIcon = getTool(slug).icon;
            return (
              <li key={slug}>
                <Link
                  href={toolHref(slug)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={s.launcher.looseNewTab(name)}
                  className="surface-card inline-flex h-11 items-center gap-2 rounded-full px-4 text-subheadline font-medium text-foreground hover:bg-elevated focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
                >
                  <ToolIcon aria-hidden="true" className="size-4" />
                  {name}
                  <ExternalLink aria-hidden="true" className="size-3.5 text-muted-foreground" />
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
