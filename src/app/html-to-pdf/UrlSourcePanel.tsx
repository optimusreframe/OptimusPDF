"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, Check, Globe, Info, Server } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { ErrorBanner, type ErrorBannerAction } from "@/components/tool/ErrorBanner";
import { cn } from "@/lib/cn";
import { requestSnapshot, SnapshotRequestError, type SnapshotClientErrorCode } from "@/lib/htmlSnapshot/client";
import type { SnapshotResult } from "@/lib/htmlSnapshot/types";
import { normalizeTypedAddress, validateSnapshotUrl } from "@/lib/htmlSnapshot/urlGuard";
import type { HtmlToPdfStrings } from "@/app/html-to-pdf/strings";

/**
 * Modo «Dirección web» de HTML a PDF: campo de dirección con validación en vivo, aviso de transparencia (siempre visible
 * ANTES de consultar), consulta cancelable y errores claros por tipo. La consulta la hace `POST /api/html-snapshot`
 * (nuestro servidor lee la página porque el navegador no puede por CORS); el resultado entra en la lista de archivos como
 * un HTML sintético y el resto del flujo es el de siempre, en el dispositivo.
 *
 * La validación del navegador es solo comodidad: la ruta repite todas las comprobaciones.
 */

type Phase = "idle" | "loading" | "error" | "cancelled";

/** Errores tras los que tiene sentido «Reintentar» (los demás piden cambiar la dirección). */
const RETRYABLE: ReadonlySet<SnapshotClientErrorCode> = new Set(["network", "timeout", "unreachable", "rate-limited", "bad-response", "forbidden"]);
/** Errores tras los que el archivo HTML es una salida real. */
const SUGGEST_FILE: ReadonlySet<SnapshotClientErrorCode> = new Set(["unreachable", "too-large", "timeout", "network"]);

export type UrlSourcePanelProps = {
  strings: HtmlToPdfStrings;
  address: string;
  onAddressChange: (value: string) => void;
  /** La consulta terminó bien: el padre carga el HTML en la lista de archivos. */
  onLoaded: (result: SnapshotResult) => void;
  /** «Usar un archivo HTML» (salida cuando la página no se puede leer). */
  onUseFile: () => void;
  /** Lleva el foco al campo al montarse (al volver a esta pantalla tras quitar el archivo o descargar). */
  focusOnMount: boolean;
  dismissLabel: string;
};

export function UrlSourcePanel({ strings: s, address, onAddressChange, onLoaded, onUseFile, focusOnMount, dismissLabel }: UrlSourcePanelProps) {
  const ids = useId();
  const inputId = `${ids}-address`;
  const statusId = `${ids}-status`;
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const [phase, setPhase] = useState<Phase>("idle");
  const [errorCode, setErrorCode] = useState<Exclude<SnapshotClientErrorCode, "cancelled"> | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const normalized = normalizeTypedAddress(address);
  const check = normalized === "" ? null : validateSnapshotUrl(normalized);
  const invalid = check !== null && !check.ok;
  const showInvalid = invalid && (address.trim().length > 0 || submitted);

  useEffect(() => {
    mountedRef.current = true;
    if (focusOnMount) inputRef.current?.focus({ preventScroll: true });
    return () => {
      mountedRef.current = false;
      // Salir de la pantalla (o cargar el resultado) corta una consulta en curso: nada queda a medias.
      controllerRef.current?.abort();
    };
    // Solo al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Al empezar a consultar, el boton «Consultar» desaparece: el foco pasa a «Cancelar» en vez de caer en <body>.
  useEffect(() => {
    if (phase === "loading") cancelRef.current?.focus({ preventScroll: true });
    if (phase === "error") bannerRef.current?.focus({ preventScroll: true });
    if (phase === "cancelled") inputRef.current?.focus({ preventScroll: true });
  }, [phase]);

  const consult = useCallback(async () => {
    const target = normalizeTypedAddress(address);
    const verdict = target === "" ? null : validateSnapshotUrl(target);
    if (!verdict || !verdict.ok) {
      setSubmitted(true);
      inputRef.current?.focus();
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setErrorCode(null);
    setPhase("loading");
    try {
      const result = await requestSnapshot(verdict.url.href, controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      onLoaded(result);
    } catch (error) {
      if (!mountedRef.current) return;
      const code = error instanceof SnapshotRequestError ? error.code : "bad-response";
      if (code === "cancelled") {
        setPhase("cancelled");
        return;
      }
      setErrorCode(code);
      setPhase("error");
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [address, onLoaded]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (phase === "loading") return;
    void consult();
  };

  /** «Reintentar» del aviso de error: la misma consulta. */
  const retry = useCallback(() => {
    void consult();
  }, [consult]);

  const cancel = () => {
    controllerRef.current?.abort();
  };

  const loading = phase === "loading";
  const errorCopy = errorCode ? s.urlErrors[errorCode] : null;
  const bannerActions = useMemo<ErrorBannerAction[]>(
    () => [
      ...(errorCode && RETRYABLE.has(errorCode) ? [{ id: "retry", label: s.retry, primary: true, onClick: retry }] : []),
      ...(errorCode && SUGGEST_FILE.has(errorCode) ? [{ id: "file", label: s.modeFile, onClick: onUseFile }] : []),
    ],
    [errorCode, retry, onUseFile, s.retry, s.modeFile],
  );

  const statusText = showInvalid
    ? check && !check.ok && check.code === "blocked-address"
      ? s.urlBlocked
      : s.urlInvalid
    : check?.ok
      ? s.urlReady
      : s.urlHint;
  const StatusIcon = showInvalid ? AlertTriangle : check?.ok ? Check : Info;

  return (
    <section aria-labelledby={`${ids}-heading`} className="surface-card rounded-ios-lg p-5 md:p-6">
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-signal/12 text-signal">
          <Globe aria-hidden="true" className="size-5" />
        </span>
        <h2 id={`${ids}-heading`} className="min-w-0 text-title-3 text-foreground">
          {s.urlHeading}
        </h2>
      </div>

      {/* Transparencia: SIEMPRE visible antes de consultar. */}
      <div data-url-notice="" className="rounded-ios mt-4 flex items-start gap-3 border border-hairline-strong bg-white/5 p-4">
        <Server aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-signal" />
        <div className="min-w-0">
          <h3 className="text-subheadline font-semibold text-foreground">{s.urlNoticeTitle}</h3>
          <p className="mt-1 text-footnote leading-relaxed text-muted-foreground">{s.urlNotice}</p>
        </div>
      </div>

      <form onSubmit={onSubmit} noValidate className="mt-5">
        <label htmlFor={inputId} className="ui-label text-muted-foreground">
          {s.urlFieldLabel}
        </label>
        <div className="mt-1.5 flex flex-col gap-3 sm:flex-row sm:items-start">
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={2048}
            placeholder={s.urlPlaceholder}
            value={address}
            readOnly={loading}
            onChange={(event) => {
              onAddressChange(event.target.value);
              if (phase !== "loading") setPhase("idle");
            }}
            aria-invalid={showInvalid || undefined}
            aria-describedby={statusId}
            className={cn(
              "h-12 w-full min-w-0 sm:flex-1 rounded-ios-sm border bg-white/5 px-3 text-base text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
              showInvalid ? "border-destructive/60" : "border-hairline",
              loading && "opacity-70",
            )}
          />
          {loading ? (
            // `key` distinto: sin el, React reutiliza el MISMO <button> y, al volver a «Consultar» dentro del mismo clic de «Cancelar»,
            // el navegador ejecuta la accion por defecto del boton ya convertido en `submit` y la consulta se repite.
            <Button key="cancel" ref={cancelRef} variant="secondary" size="lg" wrap onClick={cancel} className="sm:shrink-0">
              {s.cancelConsult}
            </Button>
          ) : (
            <Button key="consult" type="submit" size="lg" wrap className="sm:shrink-0">
              {s.consult}
            </Button>
          )}
        </div>

        {/* Estado = icono + texto (nunca solo color). */}
        <p
          id={statusId}
          aria-live="polite"
          className={cn(
            "mt-2 flex items-start gap-2 text-footnote leading-relaxed",
            showInvalid ? "text-destructive-text" : check?.ok ? "text-success-text" : "text-muted-foreground",
          )}
        >
          <StatusIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">{statusText}</span>
        </p>
      </form>

      {loading ? (
        <div role="status" className="rounded-ios mt-4 flex items-start gap-3 border border-hairline bg-white/5 p-4">
          <Spinner className="mt-0.5" />
          <div className="min-w-0">
            <p className="text-subheadline font-semibold text-foreground">{s.consulting}</p>
            <p className="mt-0.5 text-footnote text-muted-foreground">{s.consultingDetail}</p>
          </div>
        </div>
      ) : null}

      {phase === "cancelled" ? (
        <p role="status" className="mt-4 flex items-start gap-2 text-subheadline text-muted-foreground">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">{s.consultCancelled}</span>
        </p>
      ) : null}

      <div className="mt-4">
        <ErrorBanner
          show={phase === "error" && !!errorCopy}
          errorKey={errorCode ?? "error"}
          title={errorCopy?.title ?? ""}
          message={errorCopy?.message ?? ""}
          actions={bannerActions}
          onDismiss={() => {
            setPhase("idle");
            inputRef.current?.focus({ preventScroll: true });
          }}
          dismissLabel={dismissLabel}
          bannerRef={bannerRef}
          className="mb-0"
        />
      </div>

      <details className="group mt-5 border-t border-hairline pt-4">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-subheadline font-semibold text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal [&::-webkit-details-marker]:hidden">
          <Info aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">{s.limitsTitle}</span>
        </summary>
        <ul className="mt-2 list-disc space-y-1.5 pl-9 text-footnote leading-relaxed text-muted-foreground">
          {s.limits.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}
