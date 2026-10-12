"use client";

import { memo, type MouseEvent, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";

export type ViewerPageProps = {
  index: number;
  count: number;
  top: number;
  left: number;
  width: number;
  height: number;
  /** URL del bitmap mostrado (puede ser de otro tamano: se estira por CSS hasta que llegue el nuevo). */
  imageUrl: string | null;
  /** Ya se midio la pagina (si no, el alto es una estimacion). */
  measured: boolean;
  /** El render de esta pagina fallo (no se reintenta en bucle). */
  failed: boolean;
  current: boolean;
  selected: boolean;
  /** Esta pagina es la parada de tabulador (roving tabindex). */
  tabStop: boolean;
  label: string;
  description: string;
  selectedLabel: string;
  failedLabel: string;
  overlay: ReactNode;
  toolbar: ReactNode;
  onClickPage: (index: number, event: MouseEvent<HTMLElement>) => void;
};

/**
 * Una hoja del visor. Es un `article` del patron «feed» (con `aria-posinset`/`aria-setsize`: asi un lector de
 * pantalla dice «3 de 500» aunque solo haya 12 hojas en el DOM). Se coloca en absoluto con su alto reservado;
 * la imagen y la capa superpuesta viven dentro. Memoizada: una pagina solo se repinta si cambia lo suyo.
 */
function ViewerPageImpl({
  index,
  count,
  top,
  left,
  width,
  height,
  imageUrl,
  measured,
  failed,
  current,
  selected,
  tabStop,
  label,
  description,
  selectedLabel,
  failedLabel,
  overlay,
  toolbar,
  onClickPage,
}: ViewerPageProps) {
  const descId = `pro-page-${index}-desc`;
  return (
    <article
      aria-posinset={index + 1}
      aria-setsize={count}
      aria-label={label}
      aria-describedby={descId}
      aria-current={current ? "page" : undefined}
      aria-busy={(imageUrl === null && !failed) || undefined}
      tabIndex={tabStop ? 0 : -1}
      data-page-index={index}
      data-state={imageUrl ? "ready" : failed ? "error" : "loading"}
      data-selected={selected || undefined}
      data-measured={measured || undefined}
      onClick={(event) => onClickPage(index, event)}
      className={cn(
        "absolute rounded-[2px] outline-none",
        "shadow-elevation-2 forced-colors:border forced-colors:border-[CanvasText]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal forced-colors:focus-visible:outline-[Highlight]",
        selected && "outline-2 outline-offset-2 outline-signal forced-colors:outline-[Highlight]",
      )}
      style={{ top, left, width, height, backgroundColor: "#fff" }}
    >
      <span id={descId} className="sr-only">
        {description}
        {selected ? `. ${selectedLabel}` : ""}
        {failed ? `. ${failedLabel}` : ""}
      </span>
      {imageUrl ? (
        // Imagen de la pagina: puramente visual (la hoja ya esta etiquetada).
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt=""
          draggable={false}
          decoding="async"
          className="pointer-events-none absolute inset-0 size-full max-w-none select-none"
        />
      ) : (
        <div
          aria-hidden="true"
          className="absolute inset-0 flex items-center justify-center p-3 text-center text-footnote text-neutral-600 forced-colors:text-[CanvasText]"
        >
          {failed ? failedLabel : <Spinner className="size-6" />}
        </div>
      )}
      {overlay ? <div className="absolute inset-0">{overlay}</div> : null}
      {selected ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-2 left-2 flex size-6 items-center justify-center rounded-full bg-signal text-white forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]"
        >
          <Check className="size-3.5" />
        </span>
      ) : null}
      {toolbar ? <div className="absolute top-2 right-2 z-10">{toolbar}</div> : null}
    </article>
  );
}

export const ViewerPage = memo(ViewerPageImpl);
