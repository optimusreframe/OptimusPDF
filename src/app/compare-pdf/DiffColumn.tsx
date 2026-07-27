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
 * verde (token `success`) y las eliminaciones en rojo (`destructive`).
 */
export function DiffColumn({ title, tokens, emptyMessage }: DiffColumnProps) {
  const hasText = tokens.some((token) => token.text.trim().length > 0);

  return (
    <div className="min-w-0">
      <h4 className="hud-label mb-2 text-[10px] text-muted-foreground">
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
                  token.op === "insert" &&
                    "rounded-[4px] bg-success/15 px-0.5 font-medium text-success",
                  token.op === "delete" &&
                    "rounded-[4px] bg-destructive/15 px-0.5 font-medium text-destructive line-through",
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
