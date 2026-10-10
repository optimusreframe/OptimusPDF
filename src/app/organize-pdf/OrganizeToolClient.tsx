"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FilePlus2, RotateCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { useI18n, useT, type Dictionary } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import {
  MAX_SAFE_FILE_SIZE,
  withSuffix,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { organizePdf, type OrganizePage } from "@/lib/pdf/organize";
import { getTool } from "@/lib/tools-registry";
import {
  FieldNote,
  PageBoard,
  PageTile,
  TileButton,
  fileKey,
  usePageThumbnails,
} from "@/app/organize-pdf/pageToolkit";
import { getOrganizeStrings, type OrganizeStrings } from "@/app/organize-pdf/strings";

const TOOL = getTool("organize-pdf");

/**
 * Estado de la UI para una entrada del plan. Union discriminada por
 * `kind`, en espejo de `OrganizePage` (el tipo que consume el motor):
 * sin esto, un item sin `page` real (una pagina en blanco) rompe
 * `thumbs[item.page]` (spinner infinito), el `aria-label` ("Page null")
 * y la nota ("#null") — verificado contra `PageTile`.
 */
type OrganizeItem =
  | {
      kind: "existing";
      /** Clave estable para React y para el arrastre. */
      id: string;
      /** Numero de pagina 1-based en el documento original. */
      page: number;
      rotation: number;
    }
  | {
      kind: "blank";
      /** Clave estable para React y para el arrastre. */
      id: string;
    };

export type OrganizeToolOptions = {
  /** Documento al que pertenece el plan. */
  signature: string;
  items: OrganizeItem[];
};

const DEFAULT_OPTIONS: OrganizeToolOptions = { signature: "", items: [] };

function buildItems(pageCount: number): OrganizeItem[] {
  return Array.from({ length: pageCount }, (_, index) => ({
    kind: "existing" as const,
    id: `p${index + 1}`,
    page: index + 1,
    rotation: 0,
  }));
}

export function OrganizeToolClient() {
  const { language } = useI18n();
  const t = useT();
  const strings = useMemo(() => getOrganizeStrings(language), [language]);
  // Conteo REAL de paginas del documento cargado, publicado por
  // `OrganizeBoard` (via `usePageThumbnails`) segun se conoce. Solo
  // `countOriginal` lo lee; el resto del bug preexistente de
  // `countOriginal` (fragilidad general fuera de un plan todo-blancos)
  // queda fuera de alcance de A6.
  const [realPageCount, setRealPageCount] = useState(0);

  const process = useCallback(
    async (
      files: File[],
      options: OrganizeToolOptions,
      onProgress: ProgressCallback,
    ): Promise<ProcessResult> => {
      const file = files[0];
      // Si el plan no describe este archivo (cambio de documento sin que
      // el tablero haya reconstruido el plan), se entrega intacto.
      const plan: OrganizePage[] =
        options.signature === fileKey(file)
          ? options.items.map((item) =>
              item.kind === "existing"
                ? { kind: "existing" as const, page: item.page, rotation: item.rotation }
                : { kind: "blank" as const },
            )
          : [];
      const blob = await organizePdf(file, plan, onProgress);
      return { blob, filename: withSuffix(file.name, strings.filenameSuffix) };
    },
    [strings],
  );

  return (
    <ToolShell<OrganizeToolOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_OPTIONS}
      process={process}
      canRun={(files, options) => {
        // Hasta que el tablero lee las paginas no hay plan.
        if (options.signature !== fileKey(files[0]) || options.items.length === 0) {
          return { ok: false, reason: "" };
        }
        // Un plan identico al documento (mismo orden, sin giros, sin cambios) devolveria el mismo PDF.
        const untouched =
          options.items.length === realPageCount &&
          options.items.every(
            (item, index) =>
              item.kind === "existing" &&
              item.page === index + 1 &&
              item.rotation % 360 === 0,
          );
        return untouched ? { ok: false, reason: strings.needChange } : { ok: true };
      }}
      renderMain={({ files, options, setOptions }) => (
        <OrganizeBoard
          key={fileKey(files[0])}
          file={files[0]}
          options={options}
          onChange={setOptions}
          onPageCountChange={setRealPageCount}
          strings={strings}
          errors={t.tool.errors}
          pageLabel={t.tool.page}
        />
      )}
      renderOptions={({ files, options, setOptions }) => (
        <div className="space-y-4">
          <FieldNote>{strings.intro}</FieldNote>
          <p className="text-sm text-foreground">
            {strings.summary(
              options.items.length,
              countOriginal(options, realPageCount),
              options.items.length - countExisting(options),
            )}
          </p>
          {countRotated(options) > 0 ? (
            <FieldNote>{strings.rotated(countRotated(options))}</FieldNote>
          ) : null}
          {options.items.length === 1 ? (
            <FieldNote tone="warning">{strings.keepLast}</FieldNote>
          ) : null}
          {options.items.length > 0 && countExisting(options) === 0 ? (
            <FieldNote tone="warning">{strings.allBlankWarning}</FieldNote>
          ) : null}
          {files[0] && files[0].size > MAX_SAFE_FILE_SIZE ? (
            <FieldNote tone="warning">{strings.largeFile}</FieldNote>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            fullWidth
            onClick={() =>
              setOptions({
                items: buildItems(countOriginal(options, realPageCount)),
              })
            }
          >
            {strings.restore}
          </Button>
          <FieldNote>{strings.restoreHint}</FieldNote>
        </div>
      )}
    />
  );
}

/**
 * Paginas del documento original. Usa el conteo REAL cuando ya se conoce
 * (lo publica `usePageThumbnails` a traves de `OrganizeBoard`); mientras
 * no se conoce (documento aun cargando) cae en la heuristica preexistente
 * -- `Math.max` sobre los numeros de pagina del plan -- que ya era fragil
 * antes de A6 y sigue siendolo (fuera de alcance arreglarla a fondo aqui).
 * Sin el conteo real, un plan todo-blancos daria 0 y "Restaurar" quedaria
 * muerto: por eso el conteo real es la fuente preferida.
 */
function countOriginal(
  options: OrganizeToolOptions,
  realPageCount: number,
): number {
  if (realPageCount > 0) return realPageCount;
  return options.items.reduce(
    (max, item) => (item.kind === "existing" ? Math.max(max, item.page) : max),
    0,
  );
}

function countRotated(options: OrganizeToolOptions): number {
  return options.items.filter(
    (item) => item.kind === "existing" && item.rotation % 360 !== 0,
  ).length;
}

/** Numero de entradas `existing` en el plan (0 en un plan todo-blancos). */
function countExisting(options: OrganizeToolOptions): number {
  return options.items.filter((item) => item.kind === "existing").length;
}

type OrganizeBoardProps = {
  file: File | undefined;
  options: OrganizeToolOptions;
  onChange: (patch: Partial<OrganizeToolOptions>) => void;
  /** Publica el conteo REAL de paginas del documento en cuanto se conoce. */
  onPageCountChange: (pageCount: number) => void;
  strings: OrganizeStrings;
  errors: Dictionary["tool"]["errors"];
  pageLabel: string;
};

function OrganizeBoard({
  file,
  options,
  onChange,
  onPageCountChange,
  strings,
  errors,
  pageLabel,
}: OrganizeBoardProps) {
  const { pageCount, thumbs, loading, error } = usePageThumbnails(file);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const changeRef = useRef(onChange);
  useEffect(() => {
    changeRef.current = onChange;
  });

  const signature = fileKey(file);
  const stale = options.signature !== signature;

  // El plan se construye una vez conocido el numero de paginas, y se
  // reconstruye si el archivo cargado cambia.
  useEffect(() => {
    if (pageCount < 1) return;
    if (!stale && options.items.length > 0) return;
    changeRef.current({ signature, items: buildItems(pageCount) });
  }, [pageCount, signature, stale, options.items.length]);

  // `OrganizeBoard` remonta con `key={fileKey(file)}` en cada cambio de
  // archivo, asi que este efecto vuelve a arrancar desde `pageCount`
  // inicial (0) y sube hasta el conteo real segun `usePageThumbnails` lo
  // va conociendo -- sin esto, `countOriginal` en el padre no tendria
  // forma de leer el conteo real del documento.
  useEffect(() => {
    onPageCountChange(pageCount);
  }, [pageCount, onPageCountChange]);

  const items = useMemo(
    () => (stale ? [] : options.items),
    [stale, options.items],
  );

  const move = useCallback(
    (from: number, to: number) => {
      if (from === to || from < 0 || to < 0) return;
      if (from >= items.length || to >= items.length) return;
      const next = [...items];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      changeRef.current({ items: next });
    },
    [items],
  );

  const rotate = useCallback(
    (id: string) => {
      changeRef.current({
        items: items.map((item) =>
          item.kind === "existing" && item.id === id
            ? { ...item, rotation: (item.rotation + 90) % 360 }
            : item,
        ),
      });
    },
    [items],
  );

  const drop = useCallback(
    (id: string) => {
      if (items.length <= 1) return;
      changeRef.current({ items: items.filter((item) => item.id !== id) });
    },
    [items],
  );

  const insertBlank = useCallback(
    (afterIndex: number) => {
      // El siguiente numero se deriva del propio `items` (maximo `b<n>`
      // presente, +1), NUNCA de un contador en un `useRef`: `OrganizeBoard`
      // se desmonta mientras `phase === "processing"` (ver `ToolShell.tsx`)
      // -- Cancelar o un error del motor lo remonta con el plan viejo
      // intacto pero cualquier `useRef` a cero. Un contador de ref
      // produciria un `b1` duplicado tras ese ciclo, y `drop` borra TODOS
      // los items que compartan `id` de un solo clic (hallazgo real de
      // revision adversarial, con perdida de datos reproducible).
      // Derivarlo del plan sobrevive a cualquier remonte futuro.
      const nextNumber =
        items.reduce((max, item) => {
          if (item.kind !== "blank") return max;
          const match = /^b(\d+)$/.exec(item.id);
          const n = match ? Number(match[1]) : 0;
          return Math.max(max, n);
        }, 0) + 1;
      const blank: OrganizeItem = { kind: "blank", id: `b${nextNumber}` };
      const next = [...items];
      next.splice(afterIndex + 1, 0, blank);
      changeRef.current({ items: next });
    },
    [items],
  );

  if (!file) return null;

  return (
    <PageBoard
      title={strings.boardTitle}
      loading={loading}
      errorText={error ? errors[error] : null}
      toolbar={
        <span className="text-caption text-muted-foreground">
          {strings.dragHint}
        </span>
      }
    >
      {items.map((item, index) => (
        <li
          key={item.id}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", item.id);
            setDragIndex(index);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setOverIndex(index);
          }}
          onDrop={(event) => {
            event.preventDefault();
            if (dragIndex !== null) move(dragIndex, index);
            setDragIndex(null);
            setOverIndex(null);
          }}
          onDragEnd={() => {
            setDragIndex(null);
            setOverIndex(null);
          }}
          className={cn(
            "cursor-grab transition-opacity duration-200 active:cursor-grabbing",
            dragIndex === index && "opacity-40",
            overIndex === index && dragIndex !== index && "ring-signal/60 rounded-ios-sm ring-2",
          )}
        >
          <PageTile
            number={index + 1}
            label={item.kind === "existing" ? `${pageLabel} ${item.page}` : strings.blankPage}
            url={item.kind === "existing" ? thumbs[item.page] : undefined}
            rotation={item.kind === "existing" ? item.rotation : undefined}
            blank={item.kind === "blank"}
            blankLabel={strings.blankPage}
            note={
              item.kind === "existing" && item.page !== index + 1
                ? `#${item.page}`
                : undefined
            }
            compactActions
            actions={
              <>
                <TileButton
                  compact
                  label={strings.moveBefore}
                  disabled={index === 0}
                  onClick={() => move(index, index - 1)}
                >
                  <ChevronLeft aria-hidden="true" className="size-3.5" />
                </TileButton>
                {item.kind === "existing" ? (
                  <TileButton
                    compact
                    label={strings.rotate}
                    onClick={() => rotate(item.id)}
                  >
                    <RotateCw aria-hidden="true" className="size-3.5" />
                  </TileButton>
                ) : null}
                <TileButton
                  compact
                  label={strings.insertBlank}
                  onClick={() => insertBlank(index)}
                >
                  <FilePlus2 aria-hidden="true" className="size-3.5" />
                </TileButton>
                <TileButton
                  compact
                  label={strings.removePage}
                  tone="destructive"
                  disabled={items.length <= 1}
                  onClick={() => drop(item.id)}
                >
                  <Trash2 aria-hidden="true" className="size-3.5" />
                </TileButton>
                <TileButton
                  compact
                  label={strings.moveAfter}
                  disabled={index === items.length - 1}
                  onClick={() => move(index, index + 1)}
                >
                  <ChevronRight aria-hidden="true" className="size-3.5" />
                </TileButton>
              </>
            }
          />
        </li>
      ))}
    </PageBoard>
  );
}
