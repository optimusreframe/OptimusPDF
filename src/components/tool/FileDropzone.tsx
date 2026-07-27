"use client";

import { useCallback, useRef, useState, type DragEvent } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { matchesAccept } from "@/lib/pdf/core";
import type { PdfErrorCode } from "@/lib/pdf/core";
import type { Tool } from "@/lib/tools-registry";

export type FileDropzoneProps = {
  tool: Tool;
  files: File[];
  onFilesChange: (files: File[]) => void;
  onError: (code: PdfErrorCode) => void;
  className?: string;
  compact?: boolean;
};

export function FileDropzone({
  tool,
  files,
  onFilesChange,
  onError,
  className,
  compact = false,
}: FileDropzoneProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const accept = [...tool.accept, ...tool.extensions].join(",");

  const acceptFiles = useCallback(
    (incoming: FileList | null) => {
      if (!incoming || incoming.length === 0) return;
      const candidates = Array.from(incoming);
      const valid = candidates.filter((file) =>
        matchesAccept(file, tool.accept, tool.extensions),
      );

      if (valid.length === 0) {
        onError("invalidType");
        return;
      }
      if (valid.length < candidates.length) {
        onError("invalidType");
      }

      onFilesChange(
        tool.multiple ? [...files, ...valid] : [valid[0]],
      );
    },
    [files, onError, onFilesChange, tool.accept, tool.extensions, tool.multiple],
  );

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    acceptFiles(event.dataTransfer.files);
  };

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn(
        "glass rounded-ios-lg flex flex-col items-center justify-center text-center transition-all duration-200 ease-spring",
        compact ? "px-6 py-8" : "px-6 py-14 md:py-20",
        dragging && "border-signal/60 bg-signal/10 glow-signal",
        className,
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={tool.multiple}
        className="sr-only"
        onChange={(event) => {
          acceptFiles(event.target.files);
          event.target.value = "";
        }}
      />

      <span className="flex size-14 items-center justify-center rounded-full bg-signal/15">
        <Upload aria-hidden="true" className="size-6 text-signal" />
      </span>

      <h2 className="mt-5 text-lg font-bold text-foreground md:text-xl">
        {tool.multiple ? t.tool.dropTitleMultiple : t.tool.dropTitle}
      </h2>
      <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
        {t.tool.dropSubtitle}
      </p>

      <Button
        size="lg"
        className="mt-6"
        onClick={() => inputRef.current?.click()}
      >
        {tool.multiple ? t.tool.dropButtonMultiple : t.tool.dropButton}
      </Button>

      <p className="hud-label mt-5 text-[10px] text-muted-foreground">
        {t.tool.localNotice}
      </p>
    </div>
  );
}
