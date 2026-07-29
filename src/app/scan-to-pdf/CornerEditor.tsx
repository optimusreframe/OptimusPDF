"use client";

import { useEffect, useRef, useState } from "react";
import { Check, RefreshCcw, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useI18n } from "@/lib/i18n";
import {
  DEFAULT_QUAD,
  QUAD_KEYS,
  clampQuad,
  isDegenerateQuad,
  type QuadCorners,
} from "@/lib/scan/perspective";
import { STRINGS } from "@/app/scan-to-pdf/strings";

export type CornerEditorProps = {
  /** Original crudo de la captura; nunca se modifica. */
  source: Blob;
  /** Esquinas de partida, normalizadas 0-1. */
  corners: QuadCorners;
  onConfirm: (corners: QuadCorners) => void;
  onCancel: () => void;
};

/**
 * Ajuste manual de las cuatro esquinas del documento.
 *
 * La interaccion (arrastre, teclado y lupa) la pone `createCornerEditor`
 * de `scanic`, cargado con el mismo `import()` diferido que el detector.
 * La presentacion es del proyecto: se apaga la barra de la libreria y se
 * tematiza con los tokens de la app, para que el dialogo se vea como el
 * resto del catalogo en vez de como un widget ajeno.
 */
export function CornerEditor({
  source,
  corners,
  onConfirm,
  onCancel,
}: CornerEditorProps) {
  const { language } = useI18n();
  const s = STRINGS[language];

  const hostRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<QuadCorners>(corners);
  const editorRef = useRef<{ setCorners: (value: QuadCorners) => void } | null>(
    null,
  );
  const [ready, setReady] = useState(false);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let destroy: (() => void) | null = null;
    const url = URL.createObjectURL(source);
    const image = new Image();

    void (async () => {
      try {
        const [{ createCornerEditor }] = await Promise.all([
          import("scanic"),
          new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error("decode"));
            image.src = url;
          }),
        ]);
        if (disposed) return;

        const width = image.naturalWidth || 1;
        const height = image.naturalHeight || 1;
        const toPixels = (value: QuadCorners) =>
          Object.fromEntries(
            QUAD_KEYS.map((key) => [
              key,
              { x: value[key].x * width, y: value[key].y * height },
            ]),
          ) as QuadCorners;
        const toNormalized = (value: QuadCorners) =>
          clampQuad(
            Object.fromEntries(
              QUAD_KEYS.map((key) => [
                key,
                { x: value[key].x / width, y: value[key].y / height },
              ]),
            ) as QuadCorners,
          );

        const editor = createCornerEditor({
          container: host,
          image,
          corners: toPixels(corners),
          // La confirmacion la llevan los botones del proyecto.
          toolbar: { enabled: false },
          magnifier: { enabled: true },
          keyboard: true,
          handleHitArea: 44,
          theme: {
            accent: "var(--color-signal)",
            mask: "color-mix(in oklab, var(--color-background) 68%, transparent)",
            handleColor: "var(--color-signal)",
            handleRingColor: "var(--color-foreground)",
          },
          onChange: (next) => {
            const normalized = toNormalized(next);
            draftRef.current = normalized;
            setInvalid(isDegenerateQuad(normalized));
          },
        });

        editorRef.current = {
          setCorners: (value) => editor.setCorners(toPixels(value)),
        };
        destroy = () => editor.destroy();
        setReady(true);
      } catch {
        // Sin editor no hay ajuste manual posible: se cierra sin cambios
        // en vez de dejar un dialogo vacio.
        if (!disposed) onCancel();
      }
    })();

    return () => {
      disposed = true;
      destroy?.();
      editorRef.current = null;
      image.onload = null;
      image.onerror = null;
      URL.revokeObjectURL(url);
    };
    // El editor se monta una vez por captura; `corners` solo siembra el
    // estado inicial y `onCancel` es estable en el padre.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={s.cornersTitle}
      className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-xl"
    >
      <header className="flex items-start justify-between gap-4 px-4 pt-5 md:px-6">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-foreground md:text-lg">
            {s.cornersTitle}
          </h2>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
            {s.cornersHint}
          </p>
        </div>
        <Button variant="ghost" size="sm" aria-label={s.cornersCancel} onClick={onCancel}>
          <X aria-hidden="true" className="size-4" />
        </Button>
      </header>

      <div className="relative min-h-0 flex-1 px-4 py-4 md:px-6">
        <div
          ref={hostRef}
          className="glass rounded-ios relative flex h-full w-full items-center justify-center overflow-hidden p-2 select-none"
        />
        {ready ? null : (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Spinner className="size-5" label={s.cornersLoading} />
          </div>
        )}
      </div>

      <footer
        className="glass-bar flex items-center gap-3 border-t border-white/10 px-4 py-3 md:px-6"
        style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))" }}
      >
        <Button
          variant="ghost"
          size="md"
          onClick={() => {
            draftRef.current = DEFAULT_QUAD;
            setInvalid(false);
            editorRef.current?.setCorners(DEFAULT_QUAD);
          }}
        >
          <RefreshCcw aria-hidden="true" className="size-3.5" />
          {s.cornersReset}
        </Button>
        <Button
          fullWidth
          size="md"
          disabled={!ready || invalid}
          onClick={() => onConfirm(draftRef.current)}
        >
          <Check aria-hidden="true" className="size-4" />
          {invalid ? s.cornersInvalid : s.cornersApply}
        </Button>
      </footer>
    </div>
  );
}
