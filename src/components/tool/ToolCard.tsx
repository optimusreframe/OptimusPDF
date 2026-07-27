"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import {
  ACCENT_BG_SOFT,
  ACCENT_TEXT,
  toolHref,
  type Tool,
} from "@/lib/tools-registry";

export type ToolCardProps = {
  tool: Tool;
  compact?: boolean;
  className?: string;
};

export function ToolCard({ tool, compact = false, className }: ToolCardProps) {
  const t = useT();
  const Icon = tool.icon;
  const copy = t.tools[tool.slug];

  return (
    <Link
      href={toolHref(tool.slug)}
      className={cn(
        "glass rounded-ios group flex flex-col p-4 transition-all duration-200 ease-spring",
        "hover:-translate-y-0.5 hover:border-white/25 hover:bg-white/10",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span
          className={cn(
            "flex size-10 items-center justify-center rounded-ios-sm",
            ACCENT_BG_SOFT[tool.accent],
          )}
        >
          <Icon
            aria-hidden="true"
            className={cn("size-5", ACCENT_TEXT[tool.accent])}
          />
        </span>
        {tool.status === "soon" ? (
          <Badge variant="soon">{t.common.soon}</Badge>
        ) : null}
      </div>

      <h3 className="mt-3.5 text-[15px] font-semibold text-foreground">
        {copy.name}
      </h3>
      {!compact ? (
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
          {copy.description}
        </p>
      ) : null}
    </Link>
  );
}
