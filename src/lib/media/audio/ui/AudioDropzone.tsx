"use client";

import { useRef, useState, type DragEvent, type Ref } from "react";
import { Plus, ShieldCheck, Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

/**
 * Zona de carga de las herramientas de audio y video. Mismo aspecto y comportamiento que `FileDropzone`, pero con el
 * tope REAL de cada herramienta en el texto (el de PDF, 100 MB, no vale para un video de 1 GB) y sin pasar por el
 * motor de PDF. Toda la superficie abre el selector; arrastrar y soltar tambien funciona.
 */

export type AudioDropzoneProps = {
  /** Valor del atributo `accept` del selector. */
  accept: string;
  multiple: boolean;
  title: string;
  /** Titulo cuando se esta arrastrando un archivo encima. */
  titleActive: string;
  subtitle: string;
  buttonLabel: string;
  /** Linea de formatos y tope: «Acepta .mp3, … · Hasta 300 MB». */
  limits: string;
  localNotice: string;
  /** Fila compacta «Añadir más» bajo la lista. */
  compact?: boolean;
  addLabel?: string;
  onFiles: (files: File[]) => void;
  buttonRef?: Ref<HTMLButtonElement>;
  className?: string;
};

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

export function AudioDropzone({
  accept,
  multiple,
  title,
  titleActive,
  subtitle,
  buttonLabel,
  limits,
  localNotice,
  compact = false,
  addLabel,
  onFiles,
  buttonRef,
  className,
}: AudioDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const [over, setOver] = useState(false);

  const pick = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    onFiles(Array.from(list));
  };
  const open = () => inputRef.current?.click();

  const handlers = {
    onDragEnter: (event: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      depth.current = 0;
      setOver(false);
      pick(event.dataTransfer.files);
    },
  };

  const input = (
    <input
      ref={inputRef}
      type="file"
      accept={accept}
      multiple={multiple}
      aria-label={compact ? (addLabel ?? buttonLabel) : buttonLabel}
      className="sr-only"
      tabIndex={-1}
      onChange={(event) => {
        pick(event.target.files);
        event.target.value = "";
      }}
    />
  );

  if (compact) {
    return (
      <div
        {...handlers}
        className={cn(
          "rounded-ios border border-dashed transition-[border-color,background-color] duration-[var(--duration-fast)]",
          over ? "border-signal bg-signal/10" : "border-hairline-strong",
          className,
        )}
      >
        {input}
        <Button ref={buttonRef} variant="ghost" size="md" fullWidth wrap onClick={open} className="min-h-14 rounded-ios text-subheadline">
          <Plus aria-hidden="true" className="size-4" />
          {over ? titleActive : (addLabel ?? buttonLabel)}
        </Button>
      </div>
    );
  }

  return (
    <div
      {...handlers}
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest("button")) open();
      }}
      className={cn(
        "surface-card flex cursor-pointer flex-col items-center justify-center rounded-ios-lg px-6 py-14 text-center md:py-20",
        "transition-[border-color,background-color,box-shadow] duration-[var(--duration-fast)]",
        over && "border-signal bg-signal/8 shadow-[0_0_0_3px_var(--color-signal)]",
        className,
      )}
    >
      {input}
      <span className="flex size-16 items-center justify-center rounded-full bg-signal/12 text-signal">
        <Upload aria-hidden="true" className="size-7" />
      </span>
      <h2 className="mt-5 text-title-3 text-foreground">{over ? titleActive : title}</h2>
      <p className="mt-1 max-w-sm text-subheadline text-muted-foreground">{subtitle}</p>
      <Button ref={buttonRef} size="lg" wrap className="mt-6" onClick={open}>
        {buttonLabel}
      </Button>
      <p className="mt-5 max-w-full text-caption break-words text-muted-foreground tabular-nums">{limits}</p>
      <p className="mt-2 inline-flex items-center gap-1.5 text-footnote text-muted-foreground">
        <ShieldCheck aria-hidden="true" className="size-3.5 shrink-0 text-success" />
        {localNotice}
      </p>
    </div>
  );
}
