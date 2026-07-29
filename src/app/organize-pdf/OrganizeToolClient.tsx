"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RotateCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { useI18n, useT, type Dictionary } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import {
  MAX_SAFE_FILE_SIZE,
  withSuffix,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { organizePdf } from "@/lib/pdf/organize";
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

type OrganizeItem = {
  /** Clave estable para React y para el arrastre. */
  id: string;
  /** Numero de pagina 1-based en el documento original. */
  page: number;
  rotation: number;
};

export type OrganizeToolOptions = {
  /** Documento al que pertenece el plan. */
  signature: string;
  items: OrganizeItem[];
};

const DEFAULT_OPTIONS: OrganizeToolOptions = { signature: "", items: [] };

function buildItems(pageCount: number): OrganizeItem[] {
  return Array.from({ length: pageCount }, (_, index) => ({
    id: `p${index + 1}`,
    page: index + 1,
    rotation: 0,
  }));
}

export function OrganizeToolClient() {
  const { language } = useI18n();
  const t = useT();
  const strings = useMemo(() => getOrganizeStrings(language), [language]);

  const process = useCallback(
    async (
      files: File[],
      options: OrganizeToolOptions,
      onProgress: ProgressCallback,
    ): Promise<ProcessResult> => {
      const file = files[0];
      // Si el plan no describe este archivo (cambio de documento sin que
      // el tablero haya reconstruido el plan), se entrega intacto.
      const plan =
        options.signature === fileKey(file)
          ? options.items.map((item) => ({
              page: item.page,
              rotation: item.rotation,
            }))
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
      renderMain={({ files, options, setOptions }) => (
        <OrganizeBoard
          key={fileKey(files[0])}
          file={files[0]}
          options={options}
          onChange={setOptions}
          strings={strings}
          errors={t.tool.errors}
          pageLabel={t.tool.page}
        />
      )}
      renderOptions={({ files, options, setOptions }) => (
        <div className="space-y-4">
          <FieldNote>{strings.intro}</FieldNote>
          <p className="text-sm text-foreground">
            {strings.summary(options.items.length, countOriginal(options))}
          </p>
          {countRotated(options) > 0 ? (
            <FieldNote>{strings.rotated(countRotated(options))}</FieldNote>
          ) : null}
          {options.items.length === 1 ? (
            <FieldNote tone="warning">{strings.keepLast}</FieldNote>
          ) : null}
          {files[0] && files[0].size > MAX_SAFE_FILE_SIZE ? (
            <FieldNote tone="warning">{strings.largeFile}</FieldNote>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            fullWidth
            onClick={() =>
              setOptions({ items: buildItems(countOriginal(options)) })
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

/** Paginas del documento original deducidas del plan actual. */
function countOriginal(options: OrganizeToolOptions): number {
  return options.items.reduce((max, item) => Math.max(max, item.page), 0);
}

function countRotated(options: OrganizeToolOptions): number {
  return options.items.filter((item) => item.rotation % 360 !== 0).length;
}

type OrganizeBoardProps = {
  file: File | undefined;
  options: OrganizeToolOptions;
  onChange: (patch: Partial<OrganizeToolOptions>) => void;
  strings: OrganizeStrings;
  errors: Dictionary["tool"]["errors"];
  pageLabel: string;
};

function OrganizeBoard({
  file,
  options,
  onChange,
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
          item.id === id
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

  if (!file) return null;

  return (
    <PageBoard
      title={strings.boardTitle}
      loading={loading}
      errorText={error ? errors[error] : null}
      toolbar={
        <span className="hud-label text-[10px] text-muted-foreground">
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
            label={`${pageLabel} ${item.page}`}
            url={thumbs[item.page]}
            rotation={item.rotation}
            note={item.page !== index + 1 ? `#${item.page}` : undefined}
            actions={
              <>
                <TileButton
                  label={strings.moveBefore}
                  disabled={index === 0}
                  onClick={() => move(index, index - 1)}
                >
                  <ChevronLeft aria-hidden="true" className="size-4" />
                </TileButton>
                <TileButton
                  label={strings.rotate}
                  onClick={() => rotate(item.id)}
                >
                  <RotateCw aria-hidden="true" className="size-4" />
                </TileButton>
                <TileButton
                  label={strings.removePage}
                  tone="destructive"
                  disabled={items.length <= 1}
                  onClick={() => drop(item.id)}
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                </TileButton>
                <TileButton
                  label={strings.moveAfter}
                  disabled={index === items.length - 1}
                  onClick={() => move(index, index + 1)}
                >
                  <ChevronRight aria-hidden="true" className="size-4" />
                </TileButton>
              </>
            }
          />
        </li>
      ))}
    </PageBoard>
  );
}
