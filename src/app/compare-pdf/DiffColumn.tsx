"use client";

import { cn } from "@/lib/cn";
import type { DiffToken } from "@/lib/pdf/compare";

export type DiffColumnProps = {
  title: string;
  tokens: DiffToken[];
  /** Mensaje cuando la página no existe o no tiene texto. */
  emptyMessage: string;
};

/**
 * Una de las dos columnas del contraste. Las inserciones se pintan en
 * verde (`success-text`) y las eliminaciones en rojo (`destructive-text`):
 * las variantes de texto de los tokens, porque van sobre su propio tinte.
 */
export function DiffColumn({ title, tokens, emptyMessage }: DiffColumnProps) {
  const hasText = tokens.some((token) => token.text.trim().length > 0);

  return (
    <div className="min-w-0">
      <h4 className="ui-label mb-2 text-muted-foreground">
        {title}
      </h4>
      <div className="rounded-ios-sm border border-white/10 bg-white/[0.03] p-3">
        {hasText ? (
          <p className="text-sm leading-relaxed break-words text-muted-foreground">
            {tokens.map((token, index) => (
              <span
                key={`${token.op}-${index}`}
                className={cn(
                  token.op === "equal" && "text-foreground/80",
                  // Insertado = verde + subrayado; eliminado = rojo + tachado: el significado no depende solo del color.
                  token.op === "insert" &&
                    "rounded-[4px] bg-success/15 px-0.5 font-medium text-success-text underline decoration-success-text decoration-2 underline-offset-2",
                  token.op === "delete" &&
                    "rounded-[4px] bg-destructive/15 px-0.5 font-medium text-destructive-text line-through",
                )}
              >
                {token.text}{" "}
              </span>
            ))}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        )}
      </div>
    </div>
  );
}
