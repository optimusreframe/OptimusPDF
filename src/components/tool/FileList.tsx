"use client";

import { ArrowDown, ArrowUp, FileText, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { localeTag } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { MAX_SAFE_FILE_SIZE, formatFileSize } from "@/lib/pdf/core";

export type FileListProps = {
  files: File[];
  onChange: (files: File[]) => void;
  /** Permite reordenar (relevante en herramientas multi-archivo). */
  reorderable?: boolean;
  className?: string;
};

export function FileList({
  files,
  onChange,
  reorderable = false,
  className,
}: FileListProps) {
  const { t, language } = useI18n();
  const locale = localeTag(language);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= files.length) return;
    const next = [...files];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  };

  const remove = (index: number) => {
    onChange(files.filter((_, position) => position !== index));
  };

  return (
    <ul className={cn("space-y-2", className)}>
      {files.map((file, index) => {
        const oversized = file.size > MAX_SAFE_FILE_SIZE;
        return (
          <li
            key={`${file.name}-${file.lastModified}-${index}`}
            className="glass rounded-ios flex items-center gap-3 p-3"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-ios-sm bg-white/6">
              <FileText aria-hidden="true" className="size-4 text-signal" />
            </span>

            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">
                {file.name}
              </p>
              <p
                className={cn(
                  "hud-label text-[10px]",
                  oversized ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {formatFileSize(file.size, locale)}
                {oversized ? ` · ${t.tool.errors.tooLarge}` : ""}
              </p>
            </div>

            {reorderable && files.length > 1 ? (
              <div className="flex shrink-0 items-center gap-1">
                <IconButton
                  label={t.tool.moveUp}
                  disabled={index === 0}
                  onClick={() => move(index, index - 1)}
                >
                  <ArrowUp aria-hidden="true" className="size-4" />
                </IconButton>
                <IconButton
                  label={t.tool.moveDown}
                  disabled={index === files.length - 1}
                  onClick={() => move(index, index + 1)}
                >
                  <ArrowDown aria-hidden="true" className="size-4" />
                </IconButton>
              </div>
            ) : null}

            <IconButton label={t.tool.remove} onClick={() => remove(index)}>
              <X aria-hidden="true" className="size-4" />
            </IconButton>
          </li>
        );
      })}
    </ul>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}
