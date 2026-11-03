"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDocumentKey } from "@/app/sign-pdf/documentKey";
import { takeBackgroundDetection } from "@/app/sign-pdf/useBackgroundDetection";
import type { CanvasSelection } from "@/app/sign-pdf/DocumentCanvas";
import {
  detectFields,
  isFieldFilled,
  isSuggestionOnly,
  type DetectedField,
} from "@/lib/pdf/detectFields";
import { bestMatchForKey } from "@/lib/valueHistory";
import { pruneMarks, withoutMark, type AutoMark } from "@/lib/fieldPropagation";
import { memoryKeyOf } from "@/app/sign-pdf/fieldMemory";
import { useFieldTagging, type CrossDocs } from "@/app/sign-pdf/useFieldTagging";

/*
 * Sesion de documento compartida por "Varios firmantes" (`MultiFlow`) y
 * "Solo yo" (`SoloFlow`). Es la parte de ambos flujos que describe EL
 * DOCUMENTO y no a quien firma: su huella, el reinicio al cambiar de archivo,
 * la deteccion de campos, la reutilizacion de valores y el puente entre el
 * lienzo y las opciones. Se extrajo (W2-C) de `MultiFlow` sin cambiar su
 * comportamiento: la carrera de `documentKey` (el reinicio ocurre al CAMBIAR
 * DE ARCHIVO; la huella, al llegar, solo SELLA) vive aqui, una sola vez.
 */

/** Lo que la sesion necesita de las opciones de la herramienta. */
export type SessionOptions = {
  /** Huella del documento al que pertenece el estado; `""` = aun sin sellar. */
  signature: string;
  textFields: DetectedField[];
  textValues: Record<string, string>;
  textFieldsDetectedFor: string | null;
  selectedFieldId: string | null;
  selectedTextFieldId: string | null;
  /** Campos que la propagacion por etiqueta relleno sola o que se sacaron de esa cola (ver `DocState.autoFilled`). Ausente = ninguno. */
  autoFilled?: Record<string, AutoMark>;
};

/* ------------------------------------------------------------------ *
 * Reutilizacion de valores entre documentos (src/lib/valueHistory.ts)
 * ------------------------------------------------------------------ */

/**
 * Documentos para los que el usuario ya dijo "no, empezar en blanco" en
 * esta pestaña. `sessionStorage` (no `localStorage`, y no un `ref`): a
 * diferencia del historial de valores, esto es un dato de interfaz (que
 * no volver a preguntar), no PII, y tiene que sobrevivir a que el flujo
 * se desmonte y remonte (ej. alternar "Solo yo" <-> "Varios firmantes"),
 * que un `ref` de componente no sobrevive.
 */
const DECLINED_REUSE_KEY = "optimuspdf:sign-fill:declinedReuse";

function hasDeclinedReuse(documentKey: string): boolean {
  try {
    const raw = window.sessionStorage.getItem(DECLINED_REUSE_KEY);
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.includes(documentKey);
  } catch {
    return false;
  }
}

function markDeclinedReuse(documentKey: string): void {
  try {
    const raw = window.sessionStorage.getItem(DECLINED_REUSE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
    if (!list.includes(documentKey)) list.push(documentKey);
    window.sessionStorage.setItem(DECLINED_REUSE_KEY, JSON.stringify(list));
  } catch {
    // Sin sessionStorage disponible no hay nada que recordar: el banner
    // podria reaparecer, pero nunca es motivo para romper el flujo.
  }
}

/**
 * Campos cuya etiqueta (la suya o la que sugiere su rótulo) coincide con un valor ya guardado de otro documento. Es una
 * PROPUESTA que la persona acepta o rechaza (`ReuseValuesPrompt`): la memoria de otros documentos nunca rellena sola.
 */
function matchingStoredValues(
  fields: readonly DetectedField[],
): Record<string, string> {
  const matches: Record<string, string> = {};
  for (const field of fields) {
    const key = memoryKeyOf(field);
    if (!key) continue;
    const value = bestMatchForKey(key);
    if (value) matches[field.id] = value;
  }
  return matches;
}

/** Ultimo archivo visto y las opciones con las que se vio (ver `seen` de `useDocumentSession`). */
export type SeenDocument<T> = { file: File | null; options: T };

/** Memoria del ultimo archivo visto: quien la crea decide donde vive (ver `seen` de `useDocumentSession`). */
export type SeenStore<T> = {
  read: () => SeenDocument<T>;
  write: (value: SeenDocument<T>) => void;
};

export type DocumentSessionParams<T extends SessionOptions> = {
  file: File | null;
  options: T;
  setOptions: (patch: Partial<T>) => void;
  /**
   * Lo que describe UN documento concreto (huecos, trazos, campos...).
   * Se vuelve a este estado cuando el documento cambia; el resto
   * (firmantes, modo...) no depende del documento y sobrevive.
   */
  clearedState: Partial<T>;
  /** El archivo cambio por otro: limpiar lo local del flujo (p. ej. el "Deshacer" de un firmante). */
  onDocumentChange?: () => void;
  /**
   * Memoria del ultimo archivo visto (`seen`), que SOBREVIVE al flujo: quitar el archivo
   * desmonta el flujo y cargar otro monta uno nuevo, asi que un `ref` propio
   * nunca veria el cambio (y sin `crypto.subtle` la huella no llega nunca para
   * reiniciar: lo de A acabaria estampado en B). Lo crea quien monta los flujos
   * (`SignToolClient`); sin el, cada flujo recuerda solo desde que se monta.
   */
  seen?: SeenStore<T>;
  /**
   * Varios documentos en la ronda: el puente de la sesion y el id de este documento, para que el autorrelleno por etiqueta
   * llegue tambien a los campos de los demas documentos. Ausente = un solo documento.
   */
  cross?: CrossDocs;
};

export function useDocumentSession<T extends SessionOptions>({
  file,
  options,
  setOptions,
  clearedState,
  onDocumentChange,
  seen,
  cross,
}: DocumentSessionParams<T>) {
  /** Huella del contenido del archivo; `null` mientras se calcula. */
  const documentKey = useDocumentKey(file);
  const [detecting, setDetecting] = useState(false);
  const [detectionFailed, setDetectionFailed] = useState(false);
  const [reuseMatches, setReuseMatches] = useState<Record<
    string,
    string
  > | null>(null);
  /**
   * Huella para la que ya se lanzo (o esta en marcha) la deteccion. Vive
   * en un ref, no en `options`, a proposito: si estuviera en las
   * dependencias del efecto de deteccion, el propio `setOptions({
   * textFields: ... })` con el que termina la deteccion volveria a
   * disparar ese mismo efecto y cancelaria su propia peticion en marcha
   * antes de que resolviera (esto se detecto de verdad reordenando los
   * tests, no es hipotetico).
   *
   * Sembrado con `options.textFieldsDetectedFor` (solo el valor del
   * PRIMER render, `useRef` no lo vuelve a leer): un borrador restaurado
   * o una configuracion importada ya trae ese campo resuelto, y sin este
   * sembrado la deteccion real correria igual sobre el documento recien
   * cargado en cuanto `documentKey` confirme la huella, pisando en
   * silencio los campos ya restaurados.
   */
  const detectedForRef = useRef<string | null>(options.textFieldsDetectedFor);

  /**
   * Opciones ya confirmadas en pantalla. La deteccion termina mucho
   * despues de arrancar y tiene que mirar lo que la persona tiene AHORA
   * (campos anadidos a mano mientras tanto), no lo de cuando salio. Se
   * actualiza al confirmar cada render (layout), nunca durante el.
   */
  const latestOptionsRef = useRef(options);
  useLayoutEffect(() => {
    latestOptionsRef.current = options;
  });

  const clearedRef = useRef(clearedState);
  const onDocumentChangeRef = useRef(onDocumentChange);
  useEffect(() => {
    clearedRef.current = clearedState;
    onDocumentChangeRef.current = onDocumentChange;
  });

  /**
   * Cambio de ARCHIVO: es lo que reinicia el documento, no la llegada de
   * su huella. Los huecos y los trazos describen un documento concreto;
   * al cambiar el archivo se empieza de cero -- heredarlos colocaria
   * firmas sobre paginas que nadie llego a ver. Los firmantes si
   * sobreviven, porque no dependen del documento. Se limpia en el acto y
   * se deja `signature` sin sellar (`""`): lo que la persona haga en el
   * archivo nuevo mientras llega su huella se conserva, y la huella solo
   * lo sella (efecto de mas abajo).
   *
   * Solo cuenta un cambio de un archivo a otro CON LAS MISMAS opciones.
   * Si en el mismo render cambian el archivo Y las opciones, es una carga
   * externa (reanudar un borrador, importar una configuracion) que trae
   * su propio estado, ya coherente con el archivo nuevo: se respeta, y si
   * su huella no coincide con la del archivo el efecto de sellado de mas
   * abajo lo reinicia igualmente.
   *
   * El reinicio NO depende de la huella: es lo que cierra el caso de quitar
   * el archivo y cargar otro sin `crypto.subtle` (contexto no seguro), donde la
   * huella nunca llega.
   */
  const ownSeenRef = useRef<SeenDocument<T>>({ file, options });
  const store = useMemo<SeenStore<T>>(
    () =>
      seen ?? {
        read: () => ownSeenRef.current,
        write: (value) => {
          ownSeenRef.current = value;
        },
      },
    [seen],
  );
  useEffect(() => {
    const previous = store.read();
    store.write({ file: file ?? previous.file, options });
    if (!file || !previous.file || previous.file === file) return;
    if (previous.options !== options) return;
    // En el acto, dentro del propio efecto: el render siguiente ya no ve
    // lo del documento anterior (y cancela un reinicio por huella pendiente).
    setOptions({ signature: "", ...clearedRef.current } as Partial<T>);
    detectedForRef.current = null;
    // `queueMicrotask` para no llamar a `setState` sincrono en el cuerpo
    // del efecto (mismo patron que `FileList.tsx:FileThumbnail`).
    queueMicrotask(() => {
      setReuseMatches(null);
      setDetectionFailed(false);
      setDetecting(false);
      onDocumentChangeRef.current?.();
    });
  }, [file, options, setOptions, store]);

  /**
   * Llega la huella del archivo cargado. Se SELLA, sin tocar el trabajo:
   *  - `signature === ""` (nada sellado: primer documento, o archivo recien
   *    cambiado): solo se sella. Lo hecho mientras llegaba -- con un PDF
   *    grande la huella tarda y una persona rapida ya creo firmante,
   *    huecos y campos -- se conserva.
   *  - `signature` es la huella de OTRO documento (una carga externa para
   *    otro archivo: borrador, plantilla, configuracion): se reinicia, para
   *    no mezclar documentos.
   * Mientras no hay huella (`null`) ninguna captura vale (`validCapture`),
   * `SigningCeremony` espera y `multiReady` no da por lista una ronda con
   * huecos: no se firma nada sin ella. El relleno de texto no depende de
   * ella: `process()` recalcula la huella justo antes de escribir.
   */
  useEffect(() => {
    if (documentKey === null || options.signature === documentKey) return;
    const unsealed = options.signature === "";
    // `queueMicrotask` para no llamar a `setState` sincrono en el cuerpo
    // del efecto (mismo patron que `FileList.tsx:FileThumbnail`).
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (unsealed) {
        setOptions({ signature: documentKey } as Partial<T>);
        return;
      }
      setOptions({
        signature: documentKey,
        ...clearedRef.current,
      } as Partial<T>);
      setReuseMatches(null);
      setDetectionFailed(false);
    });
    return () => {
      cancelled = true;
    };
  }, [documentKey, options.signature, setOptions]);

  /** La huella ya sella el estado de las opciones (o lo restaurado ya traia la suya). */
  const sealedToDocument =
    documentKey !== null && options.signature === documentKey;

  /**
   * Deteccion de campos de texto (AcroForm + heuristica vectorial/raster)
   * del documento nuevo. Arranca cuando el estado ya esta sellado a su
   * huella: asi nunca corre mientras un reinicio pendiente puede borrar lo
   * que deje. Depende solo de `documentKey`/`file` y de ese sello -nunca
   * de nada que la propia deteccion module- para no cancelarse a si
   * misma a mitad: el sello solo pasa de falso a verdadero una vez y la
   * deteccion no lo toca; si cambia el documento, cancelarla es lo
   * correcto. Un fallo nunca bloquea nada: el usuario siempre puede seguir
   * anadiendo campos a mano (`detectionFailedHint`).
   *
   * `detectedForRef` arranca sembrado con `options.textFieldsDetectedFor`
   * (ver el comentario junto a su declaracion): un borrador restaurado o
   * una configuracion importada ya trae `textFields` resuelto, y sin ese
   * sembrado la deteccion real correria de todos modos sobre el documento
   * recien cargado y pisaria en silencio los campos restaurados,
   * incluidos los anadidos a mano que la deteccion nunca podria
   * reconstruir por si sola.
   *
   * Si al terminar ya hay campos (anadidos a mano mientras tanto, o de un
   * borrador guardado antes de que acabara la deteccion), se conservan y
   * los detectados se suman: la deteccion nunca pisa lo que hizo la persona.
   */
  useEffect(() => {
    if (!file || documentKey === null || !sealedToDocument) return;
    if (detectedForRef.current === documentKey) return;
    detectedForRef.current = documentKey;

    let cancelled = false;
    setDetecting(true);
    // Si la vista continua ya los detecto en segundo plano, se usan esos (una vez).
    void (takeBackgroundDetection(file) ?? detectFields(file))
      .then((detected) => {
        if (cancelled) return;
        const existing = latestOptionsRef.current.textFields;
        const known = new Set(existing.map((field) => field.id));
        setOptions({
          textFields:
            existing.length === 0
              ? detected
              : [
                  ...existing,
                  ...detected.filter((field) => !known.has(field.id)),
                ],
          textFieldsDetectedFor: documentKey,
        } as Partial<T>);
        if (documentKey && hasDeclinedReuse(documentKey)) return;
        const matches = matchingStoredValues(detected);
        if (Object.keys(matches).length > 0) setReuseMatches(matches);
      })
      .catch(() => {
        if (!cancelled) setDetectionFailed(true);
      })
      .finally(() => {
        if (!cancelled) setDetecting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [documentKey, file, sealedToDocument, setOptions]);

  /* ---------------------------------------------------------------- *
   * Puente lienzo <-> opciones
   * ---------------------------------------------------------------- */

  /**
   * Una sola seleccion en el lienzo, traducida a los dos campos
   * persistidos (`selectedFieldId` / `selectedTextFieldId`), que asi
   * quedan mutuamente exclusivos sin cambiar el formato de las opciones.
   */
  const canvasSelection: CanvasSelection | null = options.selectedTextFieldId
    ? { kind: "text", id: options.selectedTextFieldId }
    : options.selectedFieldId
      ? { kind: "slot", id: options.selectedFieldId }
      : null;

  const onCanvasSelectionChange = (selection: CanvasSelection | null) => {
    setOptions({
      selectedFieldId: selection?.kind === "slot" ? selection.id : null,
      selectedTextFieldId: selection?.kind === "text" ? selection.id : null,
    } as Partial<T>);
  };

  /** Quita del mapa de valores (y de las marcas de autorrelleno) lo que ya no describe ningun campo vivo. */
  const onTextFieldsChange = (fields: DetectedField[]) => {
    const alive = new Set(fields.map((field) => field.id));
    const values: Record<string, string> = {};
    for (const [id, value] of Object.entries(options.textValues)) {
      if (alive.has(id)) values[id] = value;
    }
    const marks = pruneMarks(options.autoFilled, alive);
    setOptions({
      textFields: fields,
      textValues: values,
      ...(marks !== options.autoFilled ? { autoFilled: marks ?? {} } : {}),
    } as Partial<T>);
  };

  /**
   * Escribir en un campo es "tocarlo": si estaba autorrellenado deja de seguir al campo origen (pasa a ser un valor de la
   * persona); si lo vacia, queda fuera de la cola (no se vuelve a rellenar solo) hasta que escriba algo.
   */
  const onTextValueChange = (id: string, value: string) => {
    const marks = options.autoFilled;
    const mark = marks?.[id];
    let nextMarks: Record<string, AutoMark> | undefined;
    if (marks && mark === "filled" && value.trim() === "") nextMarks = { ...marks, [id]: "declined" };
    else if (marks && mark !== undefined && (mark === "filled" || value.trim() !== "")) nextMarks = (withoutMark(marks, id) ?? marks) as Record<string, AutoMark>;
    setOptions({
      textValues: { ...options.textValues, [id]: value },
      ...(nextMarks ? { autoFilled: nextMarks } : {}),
    } as Partial<T>);
  };

  const { tagging, autoFillToast } = useFieldTagging<T>({ options, setOptions, cross });

  const acceptReuse = () => {
    if (!reuseMatches) return;
    setOptions({
      textValues: { ...options.textValues, ...reuseMatches },
    } as Partial<T>);
    setReuseMatches(null);
  };

  const declineReuse = () => {
    if (documentKey) markDeclinedReuse(documentKey);
    setReuseMatches(null);
  };

  /**
   * Campos de texto que aun no tienen valor (aviso NO bloqueante antes de descargar).
   * Las SUGERENCIAS sin tocar (heuristica vectorial/raster) no cuentan: no son campos
   * del documento hasta que la persona escribe en ellas.
   */
  const textFieldsMissing = options.textFields.filter(
    (field) =>
      !isSuggestionOnly(field, options.textValues[field.id]) &&
      !isFieldFilled(field, options.textValues[field.id]),
  ).length;
  /**
   * Solo los campos REALES que hallo la deteccion (AcroForm): los manuales y
   * los de una plantilla (`source: "manual"`) no son "detectados" y las
   * sugerencias tienen su propio interruptor en el lienzo, asi que ninguno
   * cuenta en el aviso "Se detectaron N campos".
   */
  const detectedFieldsCount = options.textFields.filter(
    (field) => field.source === "acroform",
  ).length;

  return {
    documentKey,
    detecting,
    detectionFailed,
    reuseMatches,
    acceptReuse,
    declineReuse,
    canvasSelection,
    onCanvasSelectionChange,
    onTextFieldsChange,
    onTextValueChange,
    textFieldsMissing,
    detectedFieldsCount,
    /** Etiquetas, memoria y autorrelleno: se pasa tal cual a `DocumentCanvas` (`tagging`). */
    tagging,
    /** El aviso «Rellenado en N campos · Deshacer»: hay que pintarlo junto al lienzo. */
    autoFillToast,
  };
}
