"use client";

import { AlertTriangle, Info } from "lucide-react";
import { cn } from "@/lib/cn";
import type { PlanIssue } from "@/lib/media/video/plan";
import { fillTemplate, type VideoConverterStrings } from "@/app/video-converter/strings";

const ORDER = { block: 0, warn: 1, info: 2 } as const;

export type IssueParams = Record<string, string | number>;

/**
 * Avisos del plan sobre el video elegido. El estado se dice con TEXTO («No se puede convertir», «Aviso», «Nota») ademas del
 * icono y del color: nunca solo color. Los bloqueos son una region viva (se anuncian al aparecer).
 */
export function IssueList({
  issues,
  strings,
  paramsFor,
}: {
  issues: PlanIssue[];
  strings: VideoConverterStrings;
  paramsFor: (issue: PlanIssue) => IssueParams;
}) {
  if (issues.length === 0) return null;
  const sorted = [...issues].sort((a, b) => ORDER[a.level] - ORDER[b.level]);
  const label = { block: strings.levelBlock, warn: strings.levelWarn, info: strings.levelInfo } as const;
  return (
    <ul className="mt-4 space-y-2" data-video-issues="">
      {sorted.map((issue) => {
        const Icon = issue.level === "block" ? AlertTriangle : Info;
        return (
          <li
            key={issue.code}
            data-issue={issue.code}
            data-level={issue.level}
            role={issue.level === "block" ? "alert" : undefined}
            className={cn(
              "flex items-start gap-3 rounded-ios border p-3",
              issue.level === "block" ? "border-destructive/35 bg-destructive/10" : "border-hairline bg-white/5",
            )}
          >
            <Icon
              aria-hidden="true"
              className={cn("mt-0.5 size-5 shrink-0", issue.level === "block" ? "text-destructive" : "text-muted-foreground")}
            />
            <div className="min-w-0 flex-1">
              <p className="text-footnote font-semibold text-foreground">{label[issue.level]}</p>
              <p className="mt-0.5 break-words text-subheadline text-muted-foreground">
                {fillTemplate(strings.issues[issue.code], paramsFor(issue))}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
