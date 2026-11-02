"use client";

import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type Ref,
} from "react";
import { motion } from "motion/react";
import { Plus, ShieldCheck, Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { FileAdmissionContext } from "@/components/tool/fileAdmission";
import { formatLimit } from "@/components/tool/formatLimit";
import { useI18n, localeTag } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { springs } from "@/lib/motion";
import { MAX_SAFE_FILE_SIZE, matchesAccept } from "@/lib/pdf/core";
import type { PdfErrorCode } from "@/lib/pdf/core";
import type { Tool } from "@/lib/tools-registry";

export type FileDropzoneProps = {
  tool: Tool;
  files: File[];
  onFilesChange: (files: File[]) => void;
  onError: (code: PdfErrorCode) => void;
  /**
   * Archivos descartados por formato cuando OTROS si valian. Si se pasa, el
   * aviso es no bloqueante (el shell lo muestra junto a los archivos); si
   * no, se mantiene el comportamiento anterior (`onError("invalidType")`).
   */
  onSkipped?: (skipped: File[]) => void;
  /** Ref al boton de seleccionar: ToolShell le da el foco al volver a empezar. */
  buttonRef?: Ref<HTMLButtonElement>;
  className?: string;
  compact?: boolean;
  /** Texto de la fila `compact` (por defecto «Añadir más archivos»): p. ej. «Añadir documento B». */
  addLabel?: string;
  /**
   * Peso maximo que se dice en «Acepta ... · hasta X». Por defecto el de los PDF (`MAX_SAFE_FILE_SIZE`, 100 MB). Una herramienta
   * con otro tope real (convertidor de imagenes: 64 MB, 32 MB en iPhone/iPad; de video: 4 GB, 1 GB en movil) lo pasa para no
   * prometer una cifra falsa; `null` quita la cifra cuando no hay un tope unico que decir. Solo cambia el texto: lo que se
   * admite lo decide la propia herramienta (`FileAdmissionContext`).
   */
  maxBytes?: number | null;
};

function hasFiles(event: DragEvent | globalThis.DragEvent): boolean {
  const types = event.dataTransfer?.types;
  return !!types && Array.from(types).includes("Files");
}

/**
 * Zona de carga con estados vivos:
 *   - reposo: superficie solida, icono en el azul de marca, accion primaria;
 *   - arrastre sobre la pagina: la zona se ofrece (anillo tenue + copy
 *     "Suelta para añadir") en cuanto un archivo entra en la ventana;
 *   - arrastre encima: anillo de marca y escala 1.01 con spring, vuelve
 *     al salir o soltar;
 *   - error: lo publica el shell en lenguaje llano (`onError`).
 * Toda la superficie abre el selector (el boton es el control enfocable);
 * la validacion de tipo/tamaño es la de siempre (`matchesAccept`).
 * `compact` es la fila "Añadir mas archivos" bajo la lista.
 */
export function FileDropzone({
  tool,
  files,
  onFilesChange,
  onError,
  onSkipped,
  buttonRef,
  className,
  compact = false,
  addLabel,
  maxBytes = MAX_SAFE_FILE_SIZE,
}: FileDropzoneProps) {
  const { t, language } = useI18n();
  /** Puerta opcional de la herramienta (topes propios); sin proveedor, null. */
  const admission = useContext(FileAdmissionContext);
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [windowDragging, setWindowDragging] = useState(false);
  /* Contador de dragenter/dragleave: los hijos disparan ambos al cruzarlos. */
  const depthRef = useRef(0);

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
      const skipped = candidates.filter((file) => !valid.includes(file));

      // Con puerta de admision (una herramienta con topes propios de
      // documentos y peso) manda ella; sin ella, el pase libre de siempre y
      // el peso solo se avisa.
      const gated = !!admission && tool.multiple;
      let toAdd = valid;
      let notice: string | null = null;
      if (gated) {
        const decision = admission.admit(files, valid);
        toAdd = decision.accepted;
        notice = decision.notice;
      }
      const oversized =
        !gated && valid.some((file) => file.size > MAX_SAFE_FILE_SIZE);

      if (toAdd.length > 0) {
        onFilesChange(tool.multiple ? [...files, ...toAdd] : [toAdd[0]]);
      }
      // Los avisos van DESPUES de `onFilesChange`: el shell limpia el error y
      // los avisos al cambiar los archivos, y estos tienen que sobrevivir a
      // ese mismo cambio (antes se publicaban antes y se borraban en el acto).
      if (skipped.length > 0) {
        if (onSkipped) onSkipped(skipped);
        else onError("invalidType");
      }
      if (oversized) onError("tooLarge");
      if (gated) admission.onNotice(notice);
    },
    [admission, files, onError, onFilesChange, onSkipped, tool.accept, tool.extensions, tool.multiple],
  );

  // Un archivo arrastrado a cualquier punto de la ventana: la zona se ofrece.
  useEffect(() => {
    let depth = 0;
    const onEnter = (event: globalThis.DragEvent) => {
      if (!hasFiles(event)) return;
      depth += 1;
      setWindowDragging(true);
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setWindowDragging(false);
    };
    const onDrop = () => {
      depth = 0;
      setWindowDragging(false);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depthRef.current += 1;
    setOver(true);
  };
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = () => {
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (depthRef.current === 0) setOver(false);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    depthRef.current = 0;
    setOver(false);
    acceptFiles(event.dataTransfer.files);
  };

  const openPicker = () => inputRef.current?.click();
  const onSurfaceClick = (event: MouseEvent<HTMLDivElement>) => {
    // El boton interno ya abre el selector por su cuenta (y su click
    // burbujea hasta aqui): solo se actua cuando el click no viene de el.
    if ((event.target as HTMLElement).closest("button")) return;
    openPicker();
  };

  const input = (
    <input
      ref={inputRef}
      type="file"
      accept={accept}
      multiple={tool.multiple}
      aria-label={
        compact
          ? (addLabel ?? t.tool.addMore)
          : tool.multiple
            ? t.tool.dropButtonMultiple
            : t.tool.dropButton
      }
      className="sr-only"
      tabIndex={-1}
      onChange={(event) => {
        acceptFiles(event.target.files);
        event.target.value = "";
      }}
    />
  );

  if (compact) {
    return (
      <motion.div
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        animate={{ scale: over ? 1.01 : 1 }}
        transition={springs.snappy}
        className={cn(
          "rounded-ios border border-dashed transition-[border-color,background-color] duration-[var(--duration-fast)]",
          over
            ? "border-signal bg-signal/10"
            : windowDragging
              ? "border-signal/50 bg-signal/5"
              : "border-hairline-strong",
          className,
        )}
      >
        {input}
        <Button
          ref={buttonRef}
          variant="ghost"
          size="md"
          fullWidth
          onClick={openPicker}
          className="h-14 rounded-ios text-subheadline"
        >
          <Plus aria-hidden="true" className="size-4" />
          {over || windowDragging ? t.tool.dropActive : (addLabel ?? t.tool.addMore)}
        </Button>
      </motion.div>
    );
  }

  const title = over || windowDragging
    ? t.tool.dropActive
    : tool.multiple
      ? t.tool.dropTitleMultiple
      : t.tool.dropTitle;

  return (
    <motion.div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={onSurfaceClick}
      animate={{ scale: over ? 1.01 : 1 }}
      transition={springs.snappy}
      className={cn(
        "surface-card flex cursor-pointer flex-col items-center justify-center rounded-ios-lg px-6 py-14 text-center md:py-20",
        "transition-[border-color,background-color,box-shadow] duration-[var(--duration-fast)]",
        over
          ? "border-signal bg-signal/8 shadow-[0_0_0_3px_var(--color-signal)]"
          : windowDragging
            ? "border-signal/50 bg-signal/5"
            : "",
        className,
      )}
    >
      {input}

      <span
        className={cn(
          "flex size-16 items-center justify-center rounded-full bg-signal/12 text-signal",
          "transition-[scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
          over && "scale-110",
        )}
      >
        <Upload aria-hidden="true" className="size-7" />
      </span>

      <h2 className="mt-5 text-title-3 text-foreground">{title}</h2>
      <p className="mt-1 max-w-sm text-subheadline text-muted-foreground">
        {t.tool.dropSubtitle}
      </p>

      {/* `wrap`: con la letra grande «Seleccionar archivos» no cabia en una linea (324 px en una tarjeta de 288) y salia de la pantalla. */}
      <Button ref={buttonRef} size="lg" wrap className="mt-6" onClick={openPicker}>
        {tool.multiple ? t.tool.dropButtonMultiple : t.tool.dropButton}
      </Button>

      <p className="mt-5 text-caption text-muted-foreground tabular-nums">
        {t.tool.accepts} {tool.extensions.join(", ")}
        {maxBytes === null ? null : (
          // El tope no se parte («hasta 4 / GB»): si no cabe en la linea, baja entero.
          <>
            {" "}
            <span className="whitespace-nowrap">
              · {t.tool.upTo} {formatLimit(maxBytes, localeTag(language))}
            </span>
          </>
        )}
      </p>
      <p className="mt-2 inline-flex items-center gap-1.5 text-footnote text-muted-foreground">
        <ShieldCheck aria-hidden="true" className="size-3.5 text-success" />
        {t.tool.localNotice}
      </p>
    </motion.div>
  );
}
