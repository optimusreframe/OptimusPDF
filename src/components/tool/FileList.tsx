"use client";

import { getThumbnailBlob } from "@/lib/image/thumbnail";
import { useProgressiveCount } from "@/lib/useProgressiveCount";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Reorder, useDragControls } from "motion/react";
import { ArrowDown, ArrowUp, FileText, GripVertical, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { localeTag } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { ButtonGroup } from "@/components/ui/ButtonGroup";
import { springs } from "@/lib/motion";
import {
  MAX_SAFE_FILE_SIZE,
  closePdfDocument,
  formatFileSize,
  isPdfFile,
  openPdfDocument,
  renderPageToDataUrl,
} from "@/lib/pdf/core";

export type FileListProps = {
  files: File[];
  onChange: (files: File[]) => void;
  /** Permite reordenar (relevante en herramientas multi-archivo). */
  reorderable?: boolean;
  className?: string;
  /**
   * No rasteriza la primera pagina de un PDF que trae fotos enormes (mas de 12 MP): pdf.js las decodificaria enteras (160 MB cada
   * una de 40 MP) solo para pintar una miniatura de 72 px. Queda el icono generico. Lo usa «Extraer elementos».
   */
  lightThumbnails?: boolean;
};

/*
 * Identidad estable por objeto File: dos archivos con el mismo nombre,
 * tamaño y fecha son entradas distintas de la lista (y `Reorder` necesita
 * valores unicos).
 */
const ids = new WeakMap<File, number>();
let nextId = 1;
function fileId(file: File): number {
  let id = ids.get(file);
  if (id === undefined) {
    id = nextId++;
    ids.set(file, id);
  }
  return id;
}

/**
 * Lista agrupada al estilo iOS: un contenedor con separadores hairline,
 * miniatura, nombre y peso. Con `reorderable` cada fila se arrastra desde
 * el asa (1:1, las demas se apartan con spring) y conserva los botones
 * Subir/Bajar como alternativa sin arrastre (WCAG 2.5.7). El asa es la
 * unica zona que captura el gesto, asi el dedo sigue haciendo scroll
 * sobre el resto de la fila.
 */
export function FileList({
  files,
  onChange,
  reorderable = false,
  className,
  lightThumbnails = false,
}: FileListProps) {
  const { t, language } = useI18n();
  const locale = localeTag(language);
  const canReorder = reorderable && files.length > 1;
  // Listas largas (40-117 fotos): las filas se pintan por trozos para no bloquear la pantalla (ver `useProgressiveCount`).
  const visibleCount = useProgressiveCount(files.length);
  const removeButtonsRef = useRef<(HTMLButtonElement | null)[]>([]);
  /* Indice cuyo boton "Quitar" debe recibir el foco tras el proximo render. */
  const pendingFocusRef = useRef<number | null>(null);

  // Tras quitar un archivo, el foco pasa al "Quitar" del archivo que ocupa
  // ahora esa posicion (o al ultimo). Si no queda ninguno, la lista se
  // desmonta y ToolShell lleva el foco a la zona de carga.
  // En fase de layout: el foco pasa al vecino en el mismo commit que retira la fila, sin pasar por <body>.
  useLayoutEffect(() => {
    const index = pendingFocusRef.current;
    if (index === null) return;
    pendingFocusRef.current = null;
    const target =
      removeButtonsRef.current[Math.min(index, files.length - 1)] ?? null;
    target?.focus();
  }, [files]);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= files.length) return;
    const next = [...files];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  };

  const remove = (index: number) => {
    pendingFocusRef.current = index;
    onChange(files.filter((_, position) => position !== index));
  };

  return (
    <Reorder.Group
      as="ul"
      axis="y"
      values={files}
      onReorder={onChange}
      className={cn(
        "surface-card divide-y divide-hairline overflow-hidden rounded-ios",
        className,
      )}
    >
      {files.slice(0, visibleCount).map((file, index) => (
        <FileRow
          key={fileId(file)}
          file={file}
          index={index}
          count={files.length}
          locale={locale}
          canReorder={canReorder}
          lightThumbnails={lightThumbnails}
          labels={{
            moveUp: t.tool.moveUp,
            moveDown: t.tool.moveDown,
            remove: t.tool.remove,
            drag: t.tool.dragToReorder,
            tooLarge: t.tool.errors.tooLarge,
          }}
          onMove={move}
          onRemove={remove}
          removeRef={(element) => {
            removeButtonsRef.current[index] = element;
          }}
        />
      ))}
    </Reorder.Group>
  );
}

function FileRow({
  file,
  index,
  count,
  locale,
  canReorder,
  lightThumbnails,
  labels,
  onMove,
  onRemove,
  removeRef,
}: {
  lightThumbnails: boolean;
  file: File;
  index: number;
  count: number;
  locale: string;
  canReorder: boolean;
  labels: {
    moveUp: string;
    moveDown: string;
    remove: string;
    drag: string;
    tooLarge: string;
  };
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
  removeRef: (element: HTMLButtonElement | null) => void;
}) {
  const controls = useDragControls();
  const oversized = file.size > MAX_SAFE_FILE_SIZE;

  return (
    <Reorder.Item
      as="li"
      value={file}
      drag={canReorder ? "y" : false}
      dragListener={false}
      dragControls={controls}
      layout="position"
      transition={springs.default}
      whileDrag={{
        scale: 1.02,
        boxShadow: "var(--shadow-elevation-3)",
        zIndex: 1,
      }}
      className="relative flex items-center gap-3 bg-surface py-2.5 pr-1.5 pl-3"
    >
      <span className="h-12 w-9 shrink-0 overflow-hidden rounded-[6px] bg-white/6">
        <FileThumbnail file={file} light={lightThumbnails} />
      </span>

      <div className="min-w-0 flex-1">
        {/* Hasta dos lineas (el nombre largo no pierde su extension, que es lo que se busca) y `title` con el nombre entero. */}
        <p
          data-file-name=""
          title={file.name}
          className="line-clamp-2 text-subheadline font-medium [overflow-wrap:anywhere] text-foreground"
        >
          {file.name}
        </p>
        <p
          className={cn(
            "text-footnote tabular-nums",
            oversized ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {formatFileSize(file.size, locale)}
          {oversized ? ` · ${labels.tooLarge}` : ""}
        </p>
      </div>

      {canReorder ? (
        // VI-07: «Subir», «Bajar» y el asa estaban pegados (0 px): `ButtonGroup` los separa 4 px con raton y 8 px con dedo.
        <ButtonGroup className="shrink-0">
          <IconButton
            label={labels.moveUp}
            disabled={index === 0}
            onClick={() => onMove(index, index - 1)}
          >
            <ArrowUp aria-hidden="true" className="size-4" />
          </IconButton>
          <IconButton
            label={labels.moveDown}
            disabled={index === count - 1}
            onClick={() => onMove(index, index + 1)}
          >
            <ArrowDown aria-hidden="true" className="size-4" />
          </IconButton>
          <span
            role="presentation"
            title={labels.drag}
            onPointerDown={(event) => controls.start(event)}
            className="hidden size-11 cursor-grab touch-none items-center justify-center rounded-full text-muted-foreground active:cursor-grabbing sm:flex"
          >
            <GripVertical aria-hidden="true" className="size-4" />
          </span>
        </ButtonGroup>
      ) : null}

      <IconButton
        label={labels.remove}
        onClick={() => onRemove(index)}
        buttonRef={removeRef}
      >
        <X aria-hidden="true" className="size-4" />
      </IconButton>
    </Reorder.Item>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
  buttonRef,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  buttonRef?: (element: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="group flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-6px] focus-visible:outline-signal disabled:pointer-events-none disabled:opacity-30"
    >
      <span className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)] group-hover:bg-white/10 group-hover:text-foreground group-active:scale-90 group-active:duration-[80ms]">
        {children}
      </span>
    </button>
  );
}

const THUMB_MAX_WIDTH = 72;

/**
 * Miniatura del archivo: primera pagina si es PDF, la propia imagen si es
 * una foto, o el icono generico como respaldo (formatos no soportados o
 * archivo dañado/cifrado que no se puede rasterizar aqui).
 */
function FileThumbnail({ file, light = false }: { file: File; light?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    if (file.type.startsWith("image/")) {
      // Una foto de 12-48 Mpx NO se decodifica entera para pintar 72 px: miniatura pequena hecha en cola (compartida con
      // el resto de vistas previas). Sin ella (navegador sin `createImageBitmap`) se usa el archivo original, como siempre.
      void getThumbnailBlob(file).then((thumbnail) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(thumbnail ?? file);
        setUrl(objectUrl);
      });
    } else if (isPdfFile(file)) {
      void (async () => {
        let document: Awaited<ReturnType<typeof openPdfDocument>> | null =
          null;
        try {
          if (light) {
            // Con fotos enormes se queda el icono: la preparacion se guarda por archivo y la reutiliza la busqueda.
            const { prepareImagesFor, MAX_IMAGE_PIXELS } = await import("@/lib/pdf/extractAssets/imagesPrep");
            const prep = await prepareImagesFor(file, new Uint8Array(await file.arrayBuffer()), MAX_IMAGE_PIXELS);
            if (cancelled || prep.big.size > 0) return;
          }
          document = await openPdfDocument(file);
          if (cancelled) return;
          const page = await document.getPage(1);
          const dataUrl = await renderPageToDataUrl(page, {
            maxWidth: THUMB_MAX_WIDTH,
          });
          page.cleanup();
          if (!cancelled) setUrl(dataUrl);
        } catch {
          // Se queda en null: el icono generico sirve de respaldo.
        } finally {
          if (document) void closePdfDocument(document);
        }
      })();
    }

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file, light]);

  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt="" className="h-full w-full object-cover" />
    );
  }

  return (
    <span className="flex h-full w-full items-center justify-center">
      <FileText aria-hidden="true" className="size-4 text-signal" />
    </span>
  );
}
