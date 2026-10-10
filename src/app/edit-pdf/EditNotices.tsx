"use client";

import Link from "next/link";
import { AlertTriangle, Info, X } from "lucide-react";
import { Button, buttonClasses } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

/*
 * Avisos discretos del editor (Wave 5 · U5): cifrado, firmas digitales,
 * formularios, borrador recuperado... Nunca modales: son filas en el flujo de la
 * pagina, con una accion opcional (enlace o boton) y, si se puede descartar, un
 * boton de cierre de 44 px.
 *
 * Los lectores de pantalla no anuncian una region viva que nace ya con
 * contenido, asi que las filas visibles NO son la region viva: hay una unica
 * region `role="status"` SIEMPRE montada (oculta) que repite los textos y cuyo
 * contenido es lo unico que cambia.
 */

export type EditNotice = {
  id: string;
  tone: "info" | "warning";
  text: string;
  action?: { label: string; href?: string; onClick?: () => void };
  onDismiss?: () => void;
};

export type EditNoticesProps = {
  notices: readonly EditNotice[];
  dismissLabel: string;
  className?: string;
};

export function EditNotices({ notices, dismissLabel, className }: EditNoticesProps) {
  return (
    <div data-edit-notices="" className={className}>
      <p role="status" className="sr-only">
        {notices.map((notice) => notice.text).join(" ")}
      </p>
      {notices.length > 0 ? (
        <ul className="space-y-2">
          {notices.map((notice) => {
            const Icon = notice.tone === "warning" ? AlertTriangle : Info;
            return (
              <li
                key={notice.id}
                data-notice={notice.id}
                className={cn(
                  "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-ios border px-3 py-2.5",
                  notice.tone === "warning"
                    ? "border-accent-edit/45 bg-accent-edit/10"
                    : "border-hairline bg-white/5",
                )}
              >
                <Icon
                  aria-hidden="true"
                  className={cn(
                    "size-4 shrink-0",
                    notice.tone === "warning" ? "text-accent-edit" : "text-muted-foreground",
                  )}
                />
                <p className="min-w-0 flex-1 basis-60 text-footnote text-foreground">{notice.text}</p>
                {notice.action?.href ? (
                  <Link
                    href={notice.action.href}
                    className={buttonClasses("secondary", "sm", "pointer-coarse:h-11 pointer-coarse:before:hidden")}
                  >
                    {notice.action.label}
                  </Link>
                ) : notice.action ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="pointer-coarse:h-11 pointer-coarse:before:hidden"
                    onClick={notice.action.onClick}
                  >
                    {notice.action.label}
                  </Button>
                ) : null}
                {notice.onDismiss ? (
                  <button
                    type="button"
                    aria-label={dismissLabel}
                    onClick={notice.onDismiss}
                    className="group -my-1.5 -mr-1.5 flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-6px] focus-visible:outline-signal"
                  >
                    <span className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color] duration-[var(--duration-fast)] group-hover:bg-white/10 group-hover:text-foreground">
                      <X aria-hidden="true" className="size-4" />
                    </span>
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
