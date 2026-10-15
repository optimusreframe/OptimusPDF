"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import Link from "next/link";
import { AnimatePresence } from "motion/react";
import { Info, Layers, SlidersHorizontal, X } from "lucide-react";
import { useScrollEdge } from "@/components/layout/useScrollEdge";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { ErrorBanner, type ErrorBannerAction } from "@/components/tool/ErrorBanner";
import { blockedRunText, errorCopy } from "@/components/tool/errorCopy";
import { FileDropzone } from "@/components/tool/FileDropzone";
import { FileList } from "@/components/tool/FileList";
import { useInputGuard } from "@/components/tool/InputGuardContext";
import { OptionsPanel } from "@/components/tool/OptionsPanel";
import { useFocusTarget, type FocusPlan } from "@/components/tool/useFocusTarget";
import { PasswordSheet } from "@/components/tool/PasswordSheet";
import { ProcessingOverlay } from "@/components/tool/ProcessingOverlay";
import { DownloadScreen } from "@/components/tool/DownloadScreen";
import type { BatchReport } from "@/lib/pdf/batchReport";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { addRecentEntry } from "@/lib/recent";
import { setHandoff } from "@/app/pdf-pro/proHandoff";
import {
  downloadBlob,
  isPdfFile,
  matchesAccept,
  toPdfError,
  type PdfErrorCode,
  type ProgressCallback,
} from "@/lib/pdf/core";
import {
  decryptInputCopy,
  isDecryptedCopy,
  isRestrictionOnlyCopy,
  type InputCheck,
} from "@/lib/pdf/inputGuard";
import {
  ACCENT_BG_SOFT,
  ACCENT_TEXT,
  toolHref,
  type Tool,
} from "@/lib/tools-registry";

export type ProcessResult = {
  blob: Blob;
  filename: string;
  /**
   * Solo para procesados por lotes (p. ej. firmar varios documentos): que
   * documentos entraron en el archivo y cuales fallaron. `DownloadScreen`
   * avisa de los fallos; sin este campo todo se comporta como siempre.
   */
  report?: BatchReport;
  /**
   * Resumen de lo que se hizo («3 textos editados, 1 imagen añadida.»), ya
   * traducido. `DownloadScreen` lo muestra bajo el nombre del archivo.
   */
  summary?: string;
  /**
   * Avisos de la exportacion, ya traducidos, mostrados como lista accesible
   * en la pantalla de descarga (p. ej. fuente sustituida, firma invalidada).
   */
  notices?: { title: string; items: string[] };
  /**
   * Segunda descarga, discreta, bajo «Descargar» (p. ej. el registro `.json` de Firmar PDF). Etiqueta ya traducida;
   * ausente = la pantalla es la de siempre.
   */
  secondaryDownload?: { label: string; blob: Blob; filename: string };
};

/** La descarga secundaria de un resultado, lista para `DownloadScreen` (sin ella, `undefined`). */
function secondaryDownloadAction(
  extra: ProcessResult["secondaryDownload"],
): { label: string; onDownload: () => void } | undefined {
  return extra
    ? { label: extra.label, onDownload: () => downloadBlob(extra.blob, extra.filename) }
    : undefined;
}

/**
 * Resultado de `canRun` con motivo: cuando no se puede procesar, el boton
 * «Procesar» queda desactivado y `reason` se muestra junto a el (descrito con
 * `aria-describedby`), para que nunca haya un boton inerte sin explicacion.
 */
export type CanRunResult = { ok: true } | { ok: false; reason: string };

/**
 * Que hace el shell con los archivos que elige la persona. Por defecto se
 * comprueba cada archivo al subirlo (vacio, no PDF, danado) y un PDF cifrado
 * abre la hoja de contrasena para trabajar con una copia descifrada.
 */
export type InputPolicy = {
  /**
   * PDF cifrado: `"password"` (por defecto) pide la contrasena en una hoja;
   * `"allow"` lo deja pasar tal cual (la herramienta lo gestiona: Desbloquear,
   * Editar); `"link"` lo bloquea y ofrece abrir Desbloquear PDF (Proteger).
   */
  encrypted?: "password" | "allow" | "link";
  /**
   * Textos propios para las copias abiertas con contrasena, cuando el resultado NO sale sin cifrar
   * (Proteger PDF vuelve a cifrar la copia con la contrasena nueva): sustituyen a la frase generica
   * «el resultado saldra sin cifrar» en la hoja (`sheetBody`) y en el aviso (`notice`, con `{name}`).
   */
  passwordCopy?: { sheetBody?: string; notice?: string };
};

export type ToolRenderContext<TOptions> = {
  files: File[];
  options: TOptions;
  setOptions: (patch: Partial<TOptions>) => void;
  /**
   * Publica un error en el banner del shell. Opcional para quien lo
   * necesite: una herramienta puede seguir mostrando su propio aviso
   * local sin usar esto.
   */
  setError: (code: PdfErrorCode) => void;
};

export type ToolShellProps<TOptions> = {
  tool: Tool;
  defaultOptions: TOptions;
  /** Contenido del panel de opciones (sidebar desktop / sheet movil). */
  renderOptions?: (context: ToolRenderContext<TOptions>) => ReactNode;
  /** Contenido extra de la columna principal (miniaturas, previews...). */
  renderMain?: (context: ToolRenderContext<TOptions>) => ReactNode;
  /**
   * `signal` se aborta al cancelar. Los motores que no lo necesiten
   * pueden declarar menos parametros: una funcion de aridad 3 sigue
   * siendo asignable a este tipo.
   */
  process: (
    files: File[],
    options: TOptions,
    onProgress: ProgressCallback,
    signal: AbortSignal,
  ) => Promise<ProcessResult>;
  /** Numero minimo de archivos para habilitar el procesado. */
  minFiles?: number;
  /**
   * Condicion adicional para habilitar el boton de procesar. Se suma al
   * minimo de archivos; sin ella el comportamiento es el de siempre. Puede
   * devolver un booleano o `{ ok: false, reason }`: con motivo, el shell lo
   * muestra junto al boton desactivado («Marca al menos una pagina»).
   */
  canRun?: (files: File[], options: TOptions) => boolean | CanRunResult;
  /**
   * Comprobacion de los archivos al subirlos y manejo del cifrado. `"off"`
   * la desactiva (Reparar PDF abre justo los PDF danados). Ver `InputPolicy`.
   */
  inputPolicy?: InputPolicy | "off";
  /**
   * Confirmacion previa a procesar (p. ej. «editar invalida las firmas
   * digitales»). Se evalua al pulsar el boton de procesar, ANTES de abrir el
   * overlay de progreso (que es modal y dejaria inerte cualquier hoja de
   * confirmacion). `false` cancela la ejecucion sin error y sin tocar nada.
   */
  beforeRun?: (files: File[], options: TOptions) => boolean | Promise<boolean>;
  /**
   * Texto del aviso NEUTRO (`role="status"`, no un error) que sale al cancelar
   * el procesado. Por defecto, `tool.errors.cancelled`.
   */
  cancelledMessage?: string;
  /**
   * Mensaje del overlay de progreso. Por defecto, el nombre de la
   * herramienta; una herramienta con pasos largos puede narrarlos.
   */
  progressMessage?: string;
  /**
   * Se rellena con el disparador del mismo procesado que lanza el boton
   * del shell. Lo necesita quien conduce al usuario por un flujo propio
   * y quiere rematarlo con un boton suyo, sin duplicar ni la ejecucion ni
   * la pantalla de descarga.
   */
  runRef?: RefObject<(() => void) | null>;
  /**
   * Contenido extra despues de `DownloadScreen`, solo en `phase === "done"`.
   * Lo necesita quien quiere ofrecer algo mas que "empezar de nuevo" justo
   * tras descargar (ej. un prompt para reusar datos en otro documento). No
   * incluye un `reset()` propio a proposito: quien pasa `renderDone` es el
   * mismo componente que crea y pasa `resetRef` (o `runRef`), asi que ya
   * lo tiene en su propio closure -- reenviarlo aqui duplicaria la API sin
   * necesidad, y ademas ensuciaria este render con una funcion que lee
   * refs (`react-hooks/refs` lo marca con razon: nada impide que una
   * implementacion de `renderDone` la invoque sincronicamente en vez de
   * dentro de su propio manejador de evento).
   */
  renderDone?: (context: {
    result: ProcessResult;
    options: TOptions;
  }) => ReactNode;
  /**
   * Contenido extra DENTRO de la tarjeta de `DownloadScreen`, justo bajo «Descargar» (opciones propias de ese resultado:
   * la casilla «Borrar el borrador de esta firma» y la opcion «E-sign» de Firmar, F0 · U0.4 y U0.7). Solo en `phase === "done"`.
   */
  renderDownloadExtras?: (context: {
    result: ProcessResult;
    options: TOptions;
  }) => ReactNode;
  /**
   * Se llama justo despues de lanzar la descarga del resultado con el boton primario «Descargar» (no con la descarga
   * secundaria). Lo usa Firmar para borrar el borrador de la ronda entregada si la persona lo dejo marcado (F0 · U0.4).
   */
  onDownloaded?: (context: {
    result: ProcessResult;
    options: TOptions;
  }) => void;
  /**
   * Se rellena con una version de `reset()` que acepta un patch parcial de
   * opciones en vez de volver siempre a `defaultOptions`. Lo necesita quien
   * quiere reiniciar el flujo (archivo fuera, vuelta a `"idle"`) pero
   * conservando algo que el usuario ya cargo (ej. el roster de firmantes).
   */
  resetRef?: RefObject<((patch?: Partial<TOptions>) => void) | null>;
  /**
   * Se rellena con una funcion que carga archivos y un patch de opciones
   * sin pasar por el dropzone. Lo necesita quien reanuda un borrador
   * guardado (archivo reconstruido desde bytes) o importa una
   * configuracion. A diferencia de `resetRef`, deja `phase` en `"files"`
   * (hay archivo) en vez de `"idle"`.
   */
  loadRef?: RefObject<
    ((files: File[], patch?: Partial<TOptions>) => void) | null
  >;
  /**
   * Contenido extra justo encima de la zona de carga, SOLO mientras no hay ningun archivo (`phase === "idle"`). Lo usa Firmar
   * para ofrecer retomar un trabajo sin terminar antes de que la persona suba nada (F0 · U0.3).
   */
  renderIdle?: () => ReactNode;
  /**
   * Se llama con la lista nueva y la anterior cada vez que la PERSONA cambia los archivos (subir, quitar, reordenar), antes
   * de aplicarlo. No se llama al cargar con `loadRef`/`resetRef` ni al sustituir un archivo por su copia descifrada. Lo usa
   * Firmar para ofrecer «Deshacer» al quitar un documento con trabajo hecho (F0 · U0.3).
   */
  onFilesChanged?: (next: File[], previous: File[]) => void;
};

type Phase = "idle" | "files" | "options" | "processing" | "done";

/**
 * A donde va el foco tras el proximo render (ver `focusPending`). `attention`
 * es el banner de un archivo con problema (o, si no hay, el boton Procesar).
 */
type FocusTarget = "run" | "download" | "dropzone" | "attention" | "neighbor";

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/**
 * Errores con una salida directa: el mensaje ya la nombra en lenguaje
 * llano; aqui se convierte en un boton que lleva a ella.
 */
const ERROR_ACTIONS: Partial<Record<PdfErrorCode, { href: string; labelKey: "encryptedAction" }>> = {
  encrypted: { href: toolHref("unlock-pdf"), labelKey: "encryptedAction" },
};

/** Fallos genericos del motor que se afinan mirando el archivo (ver `refineFailure`). */
const REFINABLE: ReadonlySet<PdfErrorCode> = new Set(["corrupt", "unknown", "encrypted"]);

/** El archivo no se puede usar tal cual: «Procesar» espera a que se cambie o se quite. */
function isBlocking(check: InputCheck | undefined, policy: "password" | "allow" | "link"): boolean {
  if (!check) return false;
  if (check.status === "problem") return check.code !== "tooLarge";
  if (check.status === "encrypted") return policy !== "allow";
  if (check.status === "unsupported") return policy !== "allow";
  return false;
}

function evaluateCanRun<TOptions>(
  fn: ToolShellProps<TOptions>["canRun"],
  files: File[],
  options: TOptions,
): { ok: boolean; reason: string } {
  if (!fn) return { ok: true, reason: "" };
  const result = fn(files, options);
  if (typeof result === "boolean") return { ok: result, reason: "" };
  return result.ok ? { ok: true, reason: "" } : { ok: false, reason: result.reason };
}

export function ToolShell<TOptions>({
  tool,
  defaultOptions,
  renderOptions,
  renderMain,
  process,
  minFiles = 1,
  canRun: canRunProp,
  inputPolicy,
  beforeRun,
  cancelledMessage,
  progressMessage,
  runRef,
  renderDone,
  renderDownloadExtras,
  onDownloaded,
  resetRef,
  loadRef,
  renderIdle,
  onFilesChanged,
}: ToolShellProps<TOptions>) {
  const t = useT();
  const Icon = tool.icon;
  const copy = t.tools[tool.slug];
  const belowHasContent = useScrollEdge("bottom");

  const [phase, setPhase] = useState<Phase>("idle");
  const [files, setFiles] = useState<File[]>([]);
  const [options, setOptionsState] = useState<TOptions>(defaultOptions);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<PdfErrorCode | null>(null);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const runIdRef = useRef(0);
  /** Controlador de la ejecucion en curso; `cancel()` lo aborta. */
  const abortRef = useRef<AbortController | null>(null);
  /** Archivos descartados por formato en la ultima carga (aviso no bloqueante). */
  const [skipped, setSkipped] = useState<string[]>([]);

  const policy = inputPolicy === "off" ? null : (inputPolicy?.encrypted ?? "password");
  const passwordCopy = inputPolicy === "off" ? undefined : inputPolicy?.passwordCopy;
  const guard = useInputGuard();
  const reasonId = useId();

  /*
   * Comprobacion de cada archivo al subirlo (Wave 6 · U1/U3). `checks` guarda el
   * resultado (se ignora el de archivos que ya no estan); `checksRef` es su espejo
   * sincrono para `run()`, que no puede esperar a un render. `startedRef` evita
   * comprobar dos veces el mismo `File`.
   */
  const [checks, setChecks] = useState<ReadonlyMap<File, InputCheck>>(() => new Map());
  const checksRef = useRef(new Map<File, InputCheck>());
  const startedRef = useRef(new WeakSet<File>());
  /** Archivos cuya comprobacion fallo (no es un «esta bien»): si el motor falla se vuelven a mirar. */
  const unreliableRef = useRef(new WeakSet<File>());
  const pendingChecksRef = useRef(new Set<Promise<void>>());
  const filesRef = useRef<File[]>([]);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [pw, setPw] = useState({ busy: false, wrong: false, failed: false, attempt: 0 });
  const [dismissedDecrypt, setDismissedDecrypt] = useState("");
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const replaceTargetRef = useRef<File | null>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  /** Lista de archivos (para llevar el foco al «Quitar» del vecino tras quitar uno). */
  const fileListRef = useRef<HTMLDivElement>(null);
  const neighborIndexRef = useRef(0);
  /** `true` mientras el shell muestra un banner (se sincroniza antes del efecto de foco). */
  const bannerVisibleRef = useRef(false);
  /** Pide el foco a `useFocusTarget` (que se declara tras el banner; este puente estable evita el ciclo). */
  const focusRequestRef = useRef<(target: FocusTarget) => void>(() => {});

  /*
   * Foco por fase. Lo que tenia el foco antes de procesar se desmonta
   * (el boton Procesar vive en el area de trabajo), asi que el overlay no
   * puede "devolverlo": aqui se decide el destino segun lo que acaba de
   * pasar y se aplica tras el render. Reintenta unos frames porque, al
   * terminar, el overlay sigue saliendo (AnimatePresence) y hasta que
   * retira `inert` del resto de la pagina el destino no es enfocable.
   */
  /**
   * «Procesar» de escritorio (principal o pie del panel; solo uno de los dos existe) y el de
   * la barra movil (`md:hidden`): en cada ancho solo uno se pinta.
   */
  const runDesktopRef = useRef<HTMLButtonElement>(null);
  const runMobileRef = useRef<HTMLButtonElement>(null);
  const downloadRef = useRef<HTMLButtonElement>(null);
  const dropzoneButtonRef = useRef<HTMLButtonElement>(null);

  const setOptions = useCallback((patch: Partial<TOptions>) => {
    setOptionsState((previous) => ({ ...previous, ...patch }));
  }, []);

  /** Pide el foco para el commit siguiente (se aplica en la fase de layout, sin pasar por <body>). */
  const requestFocus = useCallback((target: FocusTarget) => focusRequestRef.current(target), []);

  /** Errores de la zona de carga. Un archivo grande es un aviso (se puede seguir): el foco va a su banner. */
  const onDropzoneError = useCallback(
    (code: PdfErrorCode) => {
      setError(code);
      if (code === "tooLarge") requestFocus("attention");
    },
    [requestFocus],
  );

  const recordCheck = useCallback((file: File, check: InputCheck | null) => {
    if (check) checksRef.current.set(file, check);
    else checksRef.current.delete(file);
    setChecks(new Map(checksRef.current));
  }, []);

  /** Cambia un archivo por otro en su sitio (copia descifrada, archivo elegido de nuevo). */
  const swapFile = useCallback(
    (from: File, to: File) => {
      checksRef.current.delete(from);
      startedRef.current.add(to);
      recordCheck(to, { status: "ok" });
      setFiles((previous) => previous.map((file) => (file === from ? to : file)));
    },
    [recordCheck],
  );

  /** Resultado de comprobar `file`: aplica la politica de cifrado y registra el problema. */
  const applyCheck = useCallback(
    async (file: File, found: InputCheck) => {
      if (!policy || !filesRef.current.includes(file)) return;
      let check = found;
      if (check.status === "encrypted" && policy !== "allow" && !check.needsPassword) {
        // Solo restringe permisos: se abre con la contrasena vacia, sin pedir nada.
        const attempt = await decryptInputCopy(file, "");
        if (!filesRef.current.includes(file)) return;
        if (attempt.status === "ok") {
          swapFile(file, attempt.file);
          return;
        }
        check =
          attempt.status === "unsupported"
            ? { status: "unsupported", code: attempt.code }
            : { status: "encrypted", needsPassword: true };
      }
      recordCheck(file, check);
      if (!isBlocking(check, policy)) return;
      if (check.status === "encrypted" && policy === "password") {
        setPw({ busy: false, wrong: false, failed: false, attempt: 0 });
        setPasswordOpen(true);
      }
      requestFocus("attention");
    },
    [policy, recordCheck, requestFocus, swapFile],
  );

  useEffect(() => {
    filesRef.current = files;
  });

  const onFilesChangedRef = useRef(onFilesChanged);
  useEffect(() => {
    onFilesChangedRef.current = onFilesChanged;
  });

  // Cada archivo nuevo se comprueba una vez (vacio, no PDF, danado, cifrado).
  useEffect(() => {
    if (!guard || !policy) return;
    for (const file of files) {
      if (startedRef.current.has(file)) continue;
      startedRef.current.add(file);
      const job: Promise<void> = guard(file)
        .then((check) => applyCheck(file, check))
        // La comprobacion no pudo con este archivo: no se le puede reprochar nada (y se deja de esperar).
        .catch(() => {
          unreliableRef.current.add(file);
          recordCheck(file, { status: "ok" });
        })
        .finally(() => {
          pendingChecksRef.current.delete(job);
        });
      pendingChecksRef.current.add(job);
    }
  }, [files, guard, policy, applyCheck, recordCheck]);

  const onFilesChange = useCallback(
    (next: File[]) => {
    // Al quitar el ultimo archivo la lista se desmonta: el foco va a la
    // zona de carga en vez de caer a <body>.
    if (next.length === 0 && filesRef.current.length > 0) requestFocus("dropzone");
    onFilesChangedRef.current?.(next, filesRef.current);
    setFiles(next);
    setError(null);
    setSkipped([]);
    setPhase(next.length === 0 ? "idle" : "files");
    },
    [requestFocus],
  );

  const onSkipped = useCallback((files: File[]) => {
    setSkipped(files.map((file) => file.name));
  }, []);

  /**
   * Base de `reset()` y del `resetRef` expuesto: vuelve siempre a
   * `"idle"` sin archivos (nunca a un `phase` que exija `files` para
   * pintar, ver `showWorkspace` mas abajo), y aborta cualquier `process()`
   * en vuelo -- `reset()` hoy solo se alcanza tras `"done"` (sin ejecucion
   * en marcha), pero `resetRef` es publico y llamable en cualquier
   * momento, asi que necesita la misma guardia que ya usa `cancel()`.
   * Solo sobrevive del estado anterior lo que el patch nombra
   * explicitamente -- fusionar contra `defaultOptions`, no contra el
   * `options` actual, para no arrastrar datos del documento anterior
   * (huecos, valores de texto) que ya no describen el archivo nuevo.
   */
  const resetWith = useCallback(
    (patch?: Partial<TOptions>) => {
      runIdRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      setFiles([]);
      checksRef.current.clear();
      setChecks(new Map());
      setPasswordOpen(false);
      setOptionsState({ ...defaultOptions, ...patch });
      setResult(null);
      setProgress(0);
      setError(null);
      setSkipped([]);
      requestFocus("dropzone");
      setPhase("idle");
    },
    [defaultOptions, requestFocus],
  );

  const reset = useCallback(() => resetWith(), [resetWith]);

  /**
   * Igual que `resetWith`, pero con archivos: entra directo a `"files"`
   * (o `"idle"` si `files` viene vacio) en vez de siempre a `"idle"`, para
   * quien reanuda un borrador o importa una configuracion sin pasar por
   * el dropzone. Misma guardia de `runIdRef`/`abortRef` que `resetWith`.
   */
  const loadWith = useCallback(
    (nextFiles: File[], patch?: Partial<TOptions>) => {
      runIdRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      setFiles(nextFiles);
      checksRef.current.clear();
      // Se vuelve a comprobar TODO: un archivo que ya estuvo aqui (el «Deshacer» de Firmar devuelve los mismos `File`) no
      // puede quedar «ya comprobado» sin veredicto, o `checking` no terminaria nunca y la herramienta no se montaria.
      startedRef.current = new WeakSet<File>();
      setChecks(new Map());
      setPasswordOpen(false);
      setOptionsState({ ...defaultOptions, ...patch });
      setResult(null);
      setProgress(0);
      setError(null);
      setSkipped([]);
      setPhase(nextFiles.length === 0 ? "idle" : "files");
    },
    [defaultOptions],
  );

  /**
   * Un fallo generico del motor («corrupt», «unknown»...) se afina mirando los
   * archivos: si alguno esta vacio, no es un PDF, esta danado o cifrado, ese es
   * el mensaje (el mismo que habria salido al subirlo). Devuelve el archivo y su
   * comprobacion, o `null` si no hay nada que anadir al codigo del motor.
   */
  const refineFailure = useCallback(
    async (code: PdfErrorCode, inputs: File[]): Promise<[File, InputCheck] | null> => {
      if (!policy || !REFINABLE.has(code)) return null;
      await Promise.all([...pendingChecksRef.current]);
      for (const file of inputs) {
        if (guard && (!checksRef.current.has(file) || unreliableRef.current.has(file))) {
          try {
            const check = await guard(file);
            if (isBlocking(check, policy)) return [file, check];
          } catch {
            // La comprobacion no pudo con este archivo: se queda el codigo del motor.
          }
        }
        const known = checksRef.current.get(file);
        if (isBlocking(known, policy)) return [file, known as InputCheck];
      }
      // El motor dice «cifrado» y la comprobacion no lo vio (p. ej. permisos): se ofrece igualmente.
      if (code === "encrypted" && policy !== "allow" && inputs.length > 0) {
        return [inputs[0], { status: "encrypted", needsPassword: true }];
      }
      return null;
    },
    [guard, policy],
  );

  const run = useCallback(async () => {
    if (files.length < minFiles) {
      setError(minFiles > 1 ? "needTwo" : "empty");
      return;
    }
    // La condicion propia de la herramienta se vuelve a evaluar aqui, no
    // solo al pintar el boton. Confiar en `disabled` deja pasar cualquier
    // ejecucion que arranque desde un render con estado ya obsoleto, y en
    // herramientas con consentimiento explicito eso es saltarse la
    // confirmacion.
    if (!evaluateCanRun(canRunProp, files, options).ok) {
      setError("nothingSelected");
      return;
    }
    // Las comprobaciones de la subida pueden seguir en curso: se esperan, y un
    // archivo inservible detiene la ejecucion (el banner ya lo explica).
    if (policy) {
      // Sin `await` cuando no hay nada pendiente: arrancar el procesado en el mismo turno del clic.
      if (pendingChecksRef.current.size > 0) await Promise.all([...pendingChecksRef.current]);
      if (files.some((file) => isBlocking(checksRef.current.get(file), policy))) {
        requestFocus("attention");
        return;
      }
    }
    if (beforeRun && !(await beforeRun(files, options))) return;
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;

    const controller = new AbortController();
    abortRef.current = controller;

    setError(null);
    setProgress(0);
    setPhase("processing");

    try {
      const output = await process(
        files,
        options,
        (value) => {
          if (runIdRef.current !== runId) return;
          setProgress(Math.round(Math.min(1, Math.max(0, value)) * 100));
        },
        controller.signal,
      );
      if (runIdRef.current !== runId) return;
      setResult(output);
      addRecentEntry(tool.slug, output.filename);
      requestFocus("download");
      setPhase("done");
    } catch (caught) {
      if (runIdRef.current !== runId) return;
      const code = toPdfError(caught).code;
      const refined = await refineFailure(code, files);
      if (runIdRef.current !== runId) return;
      if (refined) {
        const [badFile, check] = refined;
        recordCheck(badFile, check);
        if (check.status === "encrypted" && policy === "password") {
          setPw({ busy: false, wrong: false, failed: false, attempt: 0 });
          setPasswordOpen(true);
        }
        setError(null);
        requestFocus("attention");
      } else {
        setError(code);
        requestFocus("run");
      }
      setPhase("files");
    }
  }, [
    beforeRun,
    canRunProp,
    files,
    minFiles,
    options,
    policy,
    process,
    recordCheck,
    refineFailure,
    requestFocus,
    tool.slug,
  ]);

  useEffect(() => {
    if (!runRef) return;
    runRef.current = () => void run();
    return () => {
      runRef.current = null;
    };
  }, [run, runRef]);

  useEffect(() => {
    if (!resetRef) return;
    resetRef.current = resetWith;
    return () => {
      resetRef.current = null;
    };
  }, [resetWith, resetRef]);

  useEffect(() => {
    if (!loadRef) return;
    loadRef.current = loadWith;
    return () => {
      loadRef.current = null;
    };
  }, [loadWith, loadRef]);

  const cancel = useCallback(() => {
    runIdRef.current += 1;
    // Ademas de ignorar el resultado, se pide al motor que pare: los
    // que escuchan la senal dejan de gastar CPU en el acto.
    abortRef.current?.abort();
    abortRef.current = null;
    requestFocus("run");
    setPhase("files");
    setProgress(0);
    setError("cancelled");
  }, [requestFocus]);

  const showWorkspace = phase === "files" || phase === "options";

  // «Abrir en PDF Pro» (Wave 7): con un PDF cargado, y «Seguir en PDF Pro» con el PDF resultado.
  // El archivo pasa por la memoria de la pestana (`proHandoff`), nunca se sube ni se guarda.
  const proCandidate = tool.slug !== "pdf-pro" ? files.find((file) => isPdfFile(file)) : undefined;
  const proResult = useMemo(
    () =>
      phase === "done" &&
      result &&
      tool.slug !== "pdf-pro" &&
      (result.blob.type === "application/pdf" || /\.pdf$/i.test(result.filename))
        ? new File([result.blob], result.filename, { type: "application/pdf" })
        : null,
    [phase, result, tool.slug],
  );

  // Primer archivo inservible (vacio, no PDF, danado, cifrado sin salida): bloquea «Procesar».
  const blockingFile = policy ? files.find((file) => isBlocking(checks.get(file), policy)) : undefined;
  const blockingCheck = blockingFile ? checks.get(blockingFile) : undefined;
  const blocked = blockingFile !== undefined;
  // Con la comprobacion activa, hasta que no vuelve el veredicto de TODOS los archivos no se monta el
  // contenido de la herramienta: un PDF cifrado o roto no debe llegar a abrirse en miniaturas ni lienzos.
  const checking = guard !== null && policy !== null && files.some((file) => !checks.has(file));
  const runState = evaluateCanRun(canRunProp, files, options);
  const canRun = files.length >= minFiles && !blocked && !checking && runState.ok;
  const disabledReason = canRun
    ? ""
    : blocked
      ? blockedRunText(t, t.tool.run)
      : files.length < minFiles
        ? minFiles > 1
          ? t.tool.errors.needTwo
          : ""
        : runState.reason;

  const context: ToolRenderContext<TOptions> = {
    files,
    options,
    setOptions,
    setError,
  };

  // Barra de accion fija en movil: el final de la pagina reserva su alto
  // (globals.css lee este atributo; se retira siempre al salir de la fase).
  useEffect(() => {
    if (!showWorkspace) return;
    document.documentElement.setAttribute("data-action-bar", "");
    return () => {
      document.documentElement.removeAttribute("data-action-bar");
    };
  }, [showWorkspace]);

  const removeFile = useCallback(
    (file: File) => {
      neighborIndexRef.current = Math.max(0, filesRef.current.indexOf(file));
      requestFocus("neighbor");
      onFilesChange(filesRef.current.filter((item) => item !== file));
    },
    [onFilesChange, requestFocus],
  );

  const chooseAnother = useCallback((file: File) => {
    replaceTargetRef.current = file;
    replaceInputRef.current?.click();
  }, []);

  const onReplacementPicked = (incoming: FileList | null) => {
    const target = replaceTargetRef.current;
    replaceTargetRef.current = null;
    if (!incoming || incoming.length === 0) return;
    const picked = Array.from(incoming).find((file) =>
      matchesAccept(file, tool.accept, tool.extensions),
    );
    if (!picked) {
      setError("invalidType");
      return;
    }
    setError(null);
    setSkipped([]);
    requestFocus("attention");
    setFiles((previous) =>
      target && previous.includes(target)
        ? previous.map((file) => (file === target ? picked : file))
        : [...previous, picked],
    );
  };

  const passwordFile =
    blockingFile && blockingCheck?.status === "encrypted" && policy === "password"
      ? blockingFile
      : undefined;

  const submitPassword = async (password: string) => {
    const target = passwordFile;
    if (!target) return;
    setPw((previous) => ({ ...previous, busy: true, wrong: false, failed: false }));
    const attempt = await decryptInputCopy(target, password);
    if (!filesRef.current.includes(target)) return;
    if (attempt.status === "ok") {
      swapFile(target, attempt.file);
      // Si hay mas PDF cifrados esperando, la hoja sigue abierta y los va pidiendo uno a uno.
      const more = filesRef.current.some((file) => {
        const check = checksRef.current.get(file);
        return file !== target && check?.status === "encrypted" && check.needsPassword;
      });
      setPasswordOpen(more);
      setPw({ busy: false, wrong: false, failed: false, attempt: 0 });
      requestFocus("attention");
      return;
    }
    if (attempt.status === "unsupported") {
      recordCheck(target, { status: "unsupported", code: attempt.code });
      setPasswordOpen(false);
      setPw({ busy: false, wrong: false, failed: false, attempt: 0 });
      requestFocus("attention");
      return;
    }
    setPw((previous) => ({
      busy: false,
      wrong: attempt.status === "wrongPassword",
      failed: attempt.status === "failed",
      attempt: previous.attempt + 1,
    }));
  };

  // Cancelar no es un fallo: es un aviso neutro en la region viva siempre montada (sin pantalla de error).
  const cancelledNotice = error === "cancelled" ? (cancelledMessage ?? t.tool.errors.cancelled) : null;
  // Copias de trabajo: las abiertas con contrasena («saldra sin cifrar») y las de PDF que solo
  // restringian edicion/impresion («sin esas restricciones»): dos frases distintas y ciertas.
  const copies = files.filter(isDecryptedCopy);
  const passwordNames = copies.filter((file) => !isRestrictionOnlyCopy(file)).map((file) => file.name);
  const restrictedNames = copies.filter(isRestrictionOnlyCopy).map((file) => file.name);
  const decryptedKey = copies.map((file) => file.name).join("\n");
  const decryptedNotice =
    copies.length > 0 && decryptedKey !== dismissedDecrypt
      ? [
          passwordNames.length > 0
            ? fillTemplate(passwordCopy?.notice ?? t.tool.decryptedNotice, { name: passwordNames.join(", ") })
            : null,
          restrictedNames.length > 0
            ? fillTemplate(t.tool.restrictedNotice, { name: restrictedNames.join(", ") })
            : null,
        ]
          .filter(Boolean)
          .join(" ")
      : null;
  const skippedNotice =
    cancelledNotice ??
    decryptedNotice ??
    (skipped.length === 1
      ? fillTemplate(t.tool.skippedOne, { names: skipped[0] })
      : skipped.length > 1
        ? fillTemplate(t.tool.skippedMany, {
            count: String(skipped.length),
            names: skipped.join(", "),
          })
        : null);

  /*
   * Banner de error: o es de un ARCHIVO (la comprobacion de la subida o un fallo del
   * motor afinado mirandolo: vacio, no es PDF, danado, cifrado) o es un error general.
   * Con un solo archivo, ambos ofrecen «Elegir otro archivo» y «Quitar archivo».
   */
  const showErrorBanner = error !== null && error !== "cancelled";
  const generalActions = ERROR_ACTIONS[error ?? "unknown"];
  // El aviso de archivo grande propone Dividir PDF, salvo en el propio Dividir PDF.
  const suggestSplit = tool.slug !== "split-pdf";
  // Con la comprobacion apagada (Reparar, Editar) el archivo lo gobierna la propia herramienta.
  const fileActionable =
    policy !== null &&
    files.length === 1 &&
    error !== null &&
    !["invalidType", "needTwo", "empty", "nothingSelected", "cancelled"].includes(error);

  let banner: {
    key: string;
    title: string;
    message: string;
    hint?: string;
    kind: "error" | "warning";
    detail?: string;
    actions: ErrorBannerAction[];
    dismissible: boolean;
    /** Archivo sobre el que actuan «Elegir otro archivo» y «Quitar archivo». */
    target?: File;
  } | null = null;
  if (blockingFile && blockingCheck) {
    const code: PdfErrorCode =
      blockingCheck.status === "problem" || blockingCheck.status === "unsupported"
        ? blockingCheck.code
        : "encrypted";
    const sheet = blockingCheck.status === "encrypted" && policy === "password";
    const actions: ErrorBannerAction[] = [];
    if (sheet) {
      actions.push({ id: "password", label: t.tool.enterPassword, primary: true });
    } else if (code === "encrypted") {
      actions.push({ label: t.tool.errors.encryptedAction, href: toolHref("unlock-pdf"), primary: true });
    }
    actions.push(
      { id: "choose", label: t.tool.chooseAnother, primary: actions.length === 0 },
      { id: "remove", label: t.tool.removeFile },
    );
    banner = {
      key: `file-${code}-${sheet ? "sheet" : "plain"}`,
      ...errorCopy(t, code, { fileProblem: true, sheet, suggestSplit }),
      detail: fillTemplate(t.tool.fileProblemFile, { name: blockingFile.name }),
      actions,
      dismissible: false,
      target: blockingFile,
    };
  } else if (showErrorBanner && error) {
    const actions: ErrorBannerAction[] = [];
    if (generalActions) {
      actions.push({ label: t.tool.errors[generalActions.labelKey], href: generalActions.href, primary: true });
    }
    if (fileActionable) {
      actions.push(
        { id: "choose", label: t.tool.chooseAnother, primary: actions.length === 0 },
        { id: "remove", label: t.tool.removeFile },
      );
    }
    banner = {
      key: error,
      ...errorCopy(t, error, { suggestSplit }),
      actions,
      dismissible: true,
      target: files[0],
    };
  }

  // Sincronizado ANTES del efecto de foco (mismo commit): un banner que se acaba de retirar no es destino.
  useLayoutEffect(() => {
    bannerVisibleRef.current = banner !== null;
  });

  const resolveFocus = (target: FocusTarget): FocusPlan => {
    const removeLabel = t.tool.remove;
    // Destino logico del vecino tras quitar un archivo: el «Quitar» de la fila que ocupa su sitio.
    const neighbor = (): HTMLElement | null => {
      const buttons = Array.from(
        fileListRef.current?.querySelectorAll<HTMLButtonElement>("li button[aria-label]") ?? [],
      ).filter((button) => button.getAttribute("aria-label") === removeLabel && !button.disabled);
      return buttons[Math.min(neighborIndexRef.current, buttons.length - 1)] ?? null;
    };
    // El banner solo es destino si TODAVIA se muestra: uno que acaba de retirarse sigue un instante en
    // el DOM (animacion de salida) y enfocarlo dejaria el foco en <body> al desmontarse.
    const bannerCandidate = bannerVisibleRef.current ? bannerRef.current : null;
    // Mientras la comprobacion del archivo recien elegido sigue en curso «Procesar» aun esta desactivado:
    // se acepta un control de reserva (el «Quitar» de la lista) y se mejora a «Procesar» al terminar.
    // Tambien cuenta «Procesar» visible pero desactivado: el estado de la comprobacion (ref) va por delante del render.
    const settling =
      (!!guard && policy !== null && filesRef.current.some((file) => !checksRef.current.has(file))) ||
      [runDesktopRef.current, runMobileRef.current].some(
        (button) => !!button && button.disabled && button.getClientRects().length > 0,
      );
    switch (target) {
      case "run":
        return { candidates: [runDesktopRef.current, runMobileRef.current] };
      case "download":
        return { candidates: [downloadRef.current] };
      case "dropzone":
        return { candidates: [dropzoneButtonRef.current] };
      case "attention":
        // El banner si lo hay; si no, «Procesar»; si esta desactivado, el primer control util de la lista.
        return {
          respectFocus: true,
          settling,
          candidates: [
            bannerCandidate,
            runDesktopRef.current,
            runMobileRef.current,
            neighbor(),
            dropzoneButtonRef.current,
          ],
        };
      case "neighbor":
        return {
          respectFocus: true,
          settling,
          candidates: [
            bannerCandidate,
            neighbor(),
            runDesktopRef.current,
            runMobileRef.current,
            dropzoneButtonRef.current,
          ],
        };
    }
  };
  const { request: requestFocusNow } = useFocusTarget<FocusTarget>(resolveFocus);
  useLayoutEffect(() => {
    focusRequestRef.current = requestFocusNow;
  }, [requestFocusNow]);

  const onBannerAction = (action: ErrorBannerAction) => {
    const target = banner?.target;
    if (action.id === "password") {
      setPw({ busy: false, wrong: false, failed: false, attempt: 0 });
      setPasswordOpen(true);
    } else if (action.id === "choose" && target) {
      chooseAnother(target);
    } else if (action.id === "remove" && target) {
      removeFile(target);
    }
  };

  const reasonNode = (suffix: string, className = "mb-2") =>
    disabledReason ? (
      <p
        id={`${reasonId}-${suffix}`}
        data-run-reason=""
        className={cn("text-footnote text-muted-foreground", className)}
      >
        {disabledReason}
      </p>
    ) : null;
  const describedBy = (suffix: string) =>
    disabledReason ? `${reasonId}-${suffix}` : undefined;

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 pt-6 pb-52 md:px-6 md:pt-10 md:pb-16">
      <header className="mb-8 flex items-start gap-4">
        <span
          className={cn(
            "flex size-12 shrink-0 items-center justify-center rounded-ios",
            ACCENT_BG_SOFT[tool.accent],
          )}
        >
          <Icon
            aria-hidden="true"
            className={cn("size-6", ACCENT_TEXT[tool.accent])}
          />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-title-1 text-foreground">{copy.name}</h1>
            {tool.status === "soon" ? (
              <Badge variant="soon">{t.common.soon}</Badge>
            ) : null}
          </div>
          <p className="mt-1.5 max-w-2xl text-callout text-muted-foreground">
            {copy.description}
          </p>
        </div>
      </header>

      <ErrorBanner
        show={banner !== null}
        errorKey={banner?.key}
        title={banner?.title ?? ""}
        message={banner?.message ?? ""}
        hint={banner?.hint}
        detail={banner?.detail}
        actions={banner?.actions}
        onAction={onBannerAction}
        variant={banner?.kind ?? "error"}
        onDismiss={banner?.dismissible ? () => setError(null) : undefined}
        dismissLabel={t.common.close}
        bannerRef={bannerRef}
      />

      {/* Selector oculto de «Elegir otro archivo»: solo existe mientras hay un banner con esa accion. */}
      {banner && banner.actions.some((action) => action.label === t.tool.chooseAnother) ? (
        <input
          ref={replaceInputRef}
          type="file"
          accept={[...tool.accept, ...tool.extensions].join(",")}
          aria-label={t.tool.chooseAnother}
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => {
            onReplacementPicked(event.target.files);
            event.target.value = "";
          }}
        />
      ) : null}

      {/*
        Region viva SIEMPRE montada: varios lectores de pantalla no anuncian
        una region que nace ya con contenido, asi que mientras no hay aviso el
        <p role="status"> existe vacio (sin caja ni margen) y lo unico que
        cambia es su texto. La caja visible (icono + boton de cierre) solo
        aparece con aviso; el boton queda fuera de la region para que no se
        lea junto al mensaje.
      */}
      <div
        className={
          skippedNotice
            ? "mb-6 flex items-start gap-3 rounded-ios border border-hairline bg-white/5 p-4 pr-2"
            : undefined
        }
      >
        {skippedNotice ? (
          <Info aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        ) : null}
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={
            skippedNotice
              ? "min-w-0 flex-1 pt-0.5 text-subheadline text-foreground"
              : undefined
          }
        >
          {skippedNotice}
        </p>
        {skippedNotice ? (
          <button
            type="button"
            onClick={() => {
              setSkipped([]);
              if (cancelledNotice) setError(null);
              if (decryptedNotice) setDismissedDecrypt(decryptedKey);
            }}
            aria-label={t.common.close}
            className="group -mt-2 flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-6px] focus-visible:outline-signal"
          >
            <span className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)] group-hover:bg-white/10 group-hover:text-foreground group-active:scale-90 group-active:duration-[80ms]">
              <X className="size-4" />
            </span>
          </button>
        ) : null}
      </div>

      {phase === "idle" ? renderIdle?.() : null}

      {phase === "idle" ? (
        <FileDropzone
          tool={tool}
          files={files}
          onFilesChange={onFilesChange}
          onError={onDropzoneError}
          onSkipped={onSkipped}
          buttonRef={dropzoneButtonRef}
        />
      ) : null}

      {showWorkspace ? (
        <div className="flex flex-col gap-6 md:flex-row md:items-start md:gap-8">
          {/* Con la hoja de opciones abierta (movil) el fondo queda inerte: no se lee ni se enfoca. */}
          <div className="min-w-0 flex-1" inert={phase === "options"}>
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h2 className="ui-label text-muted-foreground">
                {t.tool.filesTitle}
              </h2>
              {files.length > 1 ? (
                <span className="text-caption text-muted-foreground tabular-nums">
                  {files.length}
                </span>
              ) : null}
              {proCandidate && !blocked && !checking ? (
                <Link
                  href={toolHref("pdf-pro")}
                  onClick={() => setHandoff(proCandidate, tool.slug, files.filter((file) => isPdfFile(file)).length)}
                  title={files.length > 1 ? `${t.tool.openInPro}: ${proCandidate.name}` : undefined}
                  className={buttonClasses("ghost", "sm", "ml-auto")}
                >
                  <Layers aria-hidden="true" className="size-4" />
                  {t.tool.openInPro}
                </Link>
              ) : null}
            </div>
            <div ref={fileListRef}>
              <FileList
                files={files}
                onChange={onFilesChange}
                reorderable={tool.multiple}
              />
            </div>

            {tool.multiple ? (
              <FileDropzone
                tool={tool}
                files={files}
                onFilesChange={onFilesChange}
                onError={onDropzoneError}
                onSkipped={onSkipped}
                compact
                className="mt-3"
              />
            ) : null}

            {renderMain && !blocked && !checking ? <div className="mt-8">{renderMain(context)}</div> : null}

            {/*
              Un solo «Procesar» visible por pantalla: en escritorio, este si no hay panel de
              opciones (o el panel no se pinta por un archivo inservible); con panel, el de su pie.
              En movil, el de la barra fija; su motivo, si lo hay, se lee justo encima de ella. Sin panel,
              la barra con «Procesar» se queda pegada al borde inferior de la ventana (sticky) mientras el
              contenido sea mas largo que ella: el boton siempre esta a la vista.
            */}
            {!renderOptions || blocked || checking ? (
              <div className="sticky bottom-0 z-10 mt-8 hidden border-t border-hairline bg-background/90 py-4 backdrop-blur-sm md:block">
                {reasonNode("main")}
                <Button
                  ref={runDesktopRef}
                  size="lg"
                  disabled={!canRun}
                  aria-describedby={describedBy("main")}
                  onClick={() => void run()}
                >
                  {t.tool.run}
                </Button>
              </div>
            ) : null}
          </div>

          {renderOptions && !blocked && !checking ? (
            <OptionsPanel
              open={phase === "options"}
              onOpenChange={(open) => setPhase(open ? "options" : "files")}
              footer={
                <>
                  {reasonNode("panel")}
                  <Button
                    ref={runDesktopRef}
                    fullWidth
                    size="lg"
                    disabled={!canRun}
                    aria-describedby={describedBy("panel")}
                    onClick={() => {
                      setPhase("files");
                      void run();
                    }}
                  >
                    {t.tool.run}
                  </Button>
                </>
              }
            >
              {renderOptions(context)}
            </OptionsPanel>
          ) : null}
        </div>
      ) : null}

      {showWorkspace ? (
        <div
          data-scrolled={belowHasContent ? "true" : "false"}
          inert={phase === "options"}
          className="material-thick scroll-edge-top fixed inset-x-0 z-30 flex flex-col gap-2 px-4 py-3 md:hidden"
          style={{
            borderWidth: 0,
            bottom: "calc(4.5rem + env(safe-area-inset-bottom, 0px))",
          }}
        >
          {/* El motivo por el que «Procesar» esta desactivado se lee DENTRO de la barra, justo sobre el boton. */}
          {reasonNode("bar", "mb-0")}
          <div className="flex items-center gap-2">
            {renderOptions && !blocked && !checking ? (
              <Button
                variant="secondary"
                size="md"
                onClick={() => setPhase("options")}
              >
                <SlidersHorizontal aria-hidden="true" className="size-4" />
                {t.tool.openOptions}
              </Button>
            ) : null}
            <Button
              ref={runMobileRef}
              size="md"
              fullWidth
              disabled={!canRun}
              aria-describedby={describedBy("bar")}
              onClick={() => void run()}
            >
              {t.tool.run}
            </Button>
          </div>
        </div>
      ) : null}

      <PasswordSheet
        key={passwordFile ? `${passwordFile.name}:${passwordFile.size}:${passwordFile.lastModified}` : "none"}
        open={passwordOpen && passwordFile !== undefined}
        onClose={() => {
          setPasswordOpen(false);
          requestFocus("attention");
        }}
        onSubmit={(password) => void submitPassword(password)}
        onCancel={() => {
          setPasswordOpen(false);
          if (passwordFile) removeFile(passwordFile);
        }}
        busy={pw.busy}
        wrong={pw.wrong}
        failed={pw.failed}
        attempt={pw.attempt}
        fileName={passwordFile?.name}
        strings={{ ...t.tool.password, ...(passwordCopy?.sheetBody ? { body: passwordCopy.sheetBody } : {}) }}
      />

      <AnimatePresence>
        {phase === "processing" ? (
          <ProcessingOverlay
            key="processing"
            progress={progress}
            message={progressMessage ?? copy.name}
            onCancel={cancel}
          />
        ) : null}
      </AnimatePresence>

      {phase === "done" && result ? (
        <>
          <DownloadScreen
            slug={tool.slug}
            filename={result.filename}
            size={result.blob.size}
            onDownload={() => {
              downloadBlob(result.blob, result.filename);
              onDownloaded?.({ result, options });
            }}
            onStartOver={reset}
            downloadButtonRef={downloadRef}
            report={result.report}
            summary={result.summary}
            notices={result.notices}
            secondaryDownload={secondaryDownloadAction(result.secondaryDownload)}
            extras={renderDownloadExtras?.({ result, options })}
            continueAction={
              proResult ? (
                <Link
                  href={toolHref("pdf-pro")}
                  onClick={() => setHandoff(proResult, tool.slug)}
                  className={buttonClasses("secondary", "md", "mt-2")}
                >
                  <Layers aria-hidden="true" className="size-4" />
                  {t.tool.continueInPro}
                </Link>
              ) : null
            }
          />
          {renderDone ? renderDone({ result, options }) : null}
        </>
      ) : null}
    </div>
  );
}
