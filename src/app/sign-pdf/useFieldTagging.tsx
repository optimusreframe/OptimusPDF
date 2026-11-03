"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useOptionalLanguage } from "@/lib/i18n";
import { isSuggestedField, type DetectedField } from "@/lib/pdf/detectFields";
import { isMemoryTag, sanitizeTag, tagLabel, tagOf } from "@/lib/fieldTags";
import {
  planFillFromSession,
  planPropagation,
  planUndo,
  withoutMark,
  type AutoMark,
  type DocPatch,
  type FieldChange,
  type Plan,
  type PropDoc,
  type PropDocs,
} from "@/lib/fieldPropagation";
import { customTagNames, recordValue } from "@/lib/valueHistory";
import { docIdOf, docStateOf, type DocId } from "@/app/sign-pdf/docSet";
import type { SessionBridge } from "@/app/sign-pdf/useSessionBridge";
import { AutoFillToast, type AutoFillNotice } from "@/app/sign-pdf/AutoFillToast";
import { useTagStrings } from "@/app/sign-pdf/tagStrings";

/*
 * Etiquetas de campo, memoria y autorrelleno de UN documento de la sesion (W3-A1). Lo monta `useDocumentSession`, asi que lo
 * heredan a la vez «Solo yo», «Varios firmantes» (herramienta suelta y PDF Pro: `SignEmbedded`) y «Rellenar» de PDF Pro.
 *
 * Lo que hace:
 *  - `onCommit`: la persona CONFIRMA un campo (el input pierde el foco, Tab/Enter, elige una sugerencia). Si lleva etiqueta y
 *    valor, los demas campos vacios con esa etiqueta —de TODAS las paginas y de TODOS los documentos de la ronda— se rellenan
 *    solos y se avisa «Rellenado en N campos · Deshacer».
 *  - `onTagChange`: pone, cambia o quita la etiqueta de un campo. Un campo vacio recien etiquetado se rellena con el dato que la
 *    sesion ya tiene para esa etiqueta; uno que ya tenia texto pasa a ser origen.
 *  - campos que LLEGAN con etiqueta cuando la sesion ya tiene su dato (una plantilla aplicada, un campo duplicado) se rellenan
 *    igual. Los que ya estaban al montar (un borrador retomado) no se tocan.
 *
 * Con varios documentos escribe por el puente de la sesion (`SessionBridge`); con uno, por `setOptions` del flujo.
 */

/** Lo que el hook necesita de las opciones del flujo (un recorte de `SessionOptions`). */
export type TaggingOptions = {
  textFields: DetectedField[];
  textValues: Record<string, string>;
  autoFilled?: Record<string, AutoMark>;
};

/** Varios documentos: el puente de la sesion y el id de ESTE documento. Ausente = un solo documento (lo de `options`). */
export type CrossDocs = { bridge: SessionBridge; docId: DocId };

/** Lo que `DocumentCanvas` recibe (prop `tagging`). Ausente = el lienzo se comporta como siempre, sin etiquetas. */
export type CanvasTagging = {
  /** Marcas de autorrelleno del documento, por `id` de campo. */
  autoFilled: Readonly<Record<string, AutoMark>>;
  /** La persona confirmo el campo `id` con `value`. */
  onCommit: (id: string, value: string) => void;
  /** Pone, cambia o quita (`null`) la etiqueta de un campo. */
  onTagChange: (id: string, tag: string | null) => void;
};

const NO_MARKS: Readonly<Record<string, AutoMark>> = {};
const SELF = "$self";
const EMPTY_PLAN: Plan = { patches: {}, changes: [] };

type Memo = { value: string; docId: string; fieldId: string };
type Notice = AutoFillNotice & { changes: readonly FieldChange[] };

function isEmpty(value: string | undefined): boolean {
  return (value ?? "").trim() === "";
}

export function useFieldTagging<T extends TaggingOptions>({
  options,
  setOptions,
  cross,
}: {
  options: T;
  setOptions: (patch: Partial<T>) => void;
  cross?: CrossDocs;
}): { tagging: CanvasTagging; autoFillToast: ReactNode } {
  const language = useOptionalLanguage();
  const strings = useTagStrings();
  const optionsRef = useRef(options);
  const setOptionsRef = useRef(setOptions);
  const crossRef = useRef(cross);
  useLayoutEffect(() => {
    optionsRef.current = options;
    setOptionsRef.current = setOptions;
    crossRef.current = cross;
  });
  /** Ultimo dato confirmado por etiqueta: es el que gana al rellenar un campo recien etiquetado (si sigue siendo el de su campo). */
  const memoRef = useRef<Map<string, Memo>>(new Map());
  const sequenceRef = useRef(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeRef = useRef(notice);
  useEffect(() => {
    noticeRef.current = notice;
  }, [notice]);

  /** Foto de lo que hay ahora: todos los documentos de la ronda (o solo este) y cual es el de este flujo. */
  const read = useCallback((override?: Partial<PropDoc>): { docs: PropDocs; order: string[]; self: string } => {
    const link = crossRef.current;
    const current = optionsRef.current;
    const own: PropDoc = {
      textFields: current.textFields,
      textValues: current.textValues,
      ...(current.autoFilled ? { autoFilled: current.autoFilled } : {}),
      ...override,
    };
    if (!link) return { docs: { [SELF]: own }, order: [SELF], self: SELF };
    const { session, files } = link.bridge.read();
    const order = files.map(docIdOf);
    const docs: Record<string, PropDoc> = {};
    for (const id of order) {
      const state = docStateOf(session.docs, id);
      docs[id] = { textFields: state.textFields, textValues: state.textValues, ...(state.autoFilled ? { autoFilled: state.autoFilled } : {}) };
    }
    docs[link.docId] = own;
    return { docs, order: order.includes(link.docId) ? order : [...order, link.docId], self: link.docId };
  }, []);

  /** Escribe un plan (los mapas de valores y marcas de cada documento tocado) y, de este documento, lo extra (campos...). */
  const write = useCallback((plan: Plan, self: string, ownExtra?: Partial<TaggingOptions>) => {
    const link = crossRef.current;
    const own: Partial<TaggingOptions> = { ...ownExtra };
    const mine: DocPatch | undefined = plan.patches[self];
    if (mine) {
      own.textValues = mine.textValues;
      own.autoFilled = mine.autoFilled;
    }
    if (!link) {
      if (Object.keys(own).length > 0) setOptionsRef.current(own as Partial<T>);
      return;
    }
    link.bridge.commit((current) => {
      const docs = { ...current.docs };
      for (const [id, patch] of Object.entries(plan.patches)) {
        if (id === self) continue;
        docs[id] = { ...docStateOf(current.docs, id), textValues: patch.textValues, autoFilled: patch.autoFilled };
      }
      if (Object.keys(own).length > 0) docs[self] = { ...docStateOf(current.docs, self), ...own };
      return { docs };
    });
  }, []);

  const announce = useCallback(
    (tag: string | null, changes: readonly FieldChange[]) => {
      if (changes.length === 0) return;
      sequenceRef.current += 1;
      setNotice({
        id: sequenceRef.current,
        message: tag
          ? strings.autoFilledToast(changes.length, tagLabel(tag, language, customTagNames()))
          : strings.autoFilledGeneric(changes.length),
        undoable: true,
        changes,
      });
    },
    [strings, language],
  );

  const onCommit = useCallback(
    (id: string, value: string) => {
      const { docs, order, self } = read();
      const doc = docs[self];
      const field = doc?.textFields.find((candidate) => candidate.id === id);
      const tag = field ? tagOf(field) : undefined;
      if (!doc || !field || !tag || !isMemoryTag(tag)) return;
      // Un campo que solo seguia a otro (autorrellenado y sin tocar) no es origen de nada.
      if (doc.autoFilled?.[id] === "filled" || isEmpty(value)) return;
      memoRef.current.set(tag, { value: doc.textValues[id] ?? value, docId: self, fieldId: id });
      const plan = planPropagation(docs, order, { docId: self, fieldId: id });
      if (plan.changes.length === 0) return;
      write(plan, self);
      announce(tag, plan.changes);
    },
    [read, write, announce],
  );

  const onTagChange = useCallback(
    (id: string, requested: string | null) => {
      const current = optionsRef.current;
      const field = current.textFields.find((candidate) => candidate.id === id);
      if (!field) return;
      const nextTag = requested === null ? undefined : sanitizeTag(requested);
      if (requested !== null && nextTag === undefined) return;
      if (tagOf(field) === nextTag) return;

      // Una sugerencia de la heuristica que la persona etiqueta es ya un campo suyo.
      const base = isSuggestedField(field) ? ({ ...field, source: "manual" } as DetectedField) : field;
      const { tag: previousTag, ...withoutTag } = base;
      void previousTag;
      const nextField: DetectedField = nextTag ? { ...withoutTag, tag: nextTag } : withoutTag;
      const textFields = current.textFields.map((candidate) => (candidate.id === id ? nextField : candidate));

      // Un campo que solo seguia a otro y cambia de etiqueta deja de valer ese texto: vuelve a vacio y sale de la cola.
      let textValues = current.textValues;
      let autoFilled = current.autoFilled;
      if (autoFilled && id in autoFilled) {
        if (autoFilled[id] === "filled" && id in textValues) {
          textValues = { ...textValues };
          delete textValues[id];
        }
        autoFilled = (withoutMark(autoFilled, id) ?? autoFilled) as Record<string, AutoMark>;
      }
      const { docs, order, self } = read({ textFields, textValues, ...(autoFilled ? { autoFilled } : {}) });
      const hasText = !isEmpty(textValues[id]);
      const plan =
        nextTag && isMemoryTag(nextTag)
          ? hasText
            ? planPropagation(docs, order, { docId: self, fieldId: id })
            : planFillFromSession(docs, order, { docId: self, fieldId: id }, memoRef.current.get(nextTag))
          : EMPTY_PLAN;

      const extra: Partial<TaggingOptions> = { textFields };
      if (textValues !== current.textValues) extra.textValues = textValues;
      if (autoFilled !== current.autoFilled) extra.autoFilled = autoFilled ?? {};
      write(plan, self, extra);

      if (nextTag && isMemoryTag(nextTag) && hasText) {
        const typed = (textValues[id] ?? "").trim();
        // El texto que ya tenia el campo es el dato de esa etiqueta desde ahora: se recuerda y es el origen del autorrelleno.
        if ((field.type ?? "text") === "text") recordValue(nextTag, typed);
        memoRef.current.set(nextTag, { value: textValues[id] as string, docId: self, fieldId: id });
      }
      if (nextTag) announce(nextTag, plan.changes);
    },
    [read, write, announce],
  );

  /* ---- Campos que llegan ya con etiqueta (plantilla aplicada, campo duplicado): se rellenan si la sesion ya tiene su dato ---- */
  const seenIdsRef = useRef<Set<string> | null>(null);
  const fieldsKey = options.textFields.map((field) => `${field.id}:${tagOf(field) ?? ""}`).join("|");
  useEffect(() => {
    const ids = new Set(optionsRef.current.textFields.map((field) => field.id));
    const seen = seenIdsRef.current;
    seenIdsRef.current = ids;
    // La primera vez solo se anota lo que hay (un borrador retomado trae sus campos; los vacios se quedan vacios).
    if (seen === null) return;
    const arrivals = optionsRef.current.textFields.filter((field) => !seen.has(field.id) && tagOf(field));
    if (arrivals.length === 0) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const changes: FieldChange[] = [];
      const tags = new Set<string>();
      const snapshot = read();
      const { order, self } = snapshot;
      let docs: PropDocs = snapshot.docs;
      const merged: Plan = { patches: {}, changes: [] };
      for (const field of arrivals) {
        const tag = tagOf(field) as string;
        const plan = planFillFromSession(docs, order, { docId: self, fieldId: field.id }, memoRef.current.get(tag));
        if (plan.changes.length === 0) continue;
        Object.assign(merged.patches, plan.patches);
        changes.push(...plan.changes);
        tags.add(tag);
        // El siguiente campo ve lo que ya relleno este.
        docs = { ...docs, ...Object.fromEntries(Object.entries(plan.patches).map(([id, patch]) => [id, { ...docs[id], ...patch }])) };
      }
      if (changes.length === 0) return;
      write(merged, self);
      announce(tags.size === 1 ? [...tags][0] : null, changes);
    });
    return () => {
      cancelled = true;
    };
    // `fieldsKey` resume la lista de campos y sus etiquetas: solo importa cuando cambia el conjunto de campos o una etiqueta.
  }, [fieldsKey, read, write, announce]);

  const undo = useCallback(() => {
    const current = noticeRef.current;
    if (!current || !current.undoable) return;
    const { docs, self } = read();
    const plan = planUndo(docs, current.changes);
    if (plan.changes.length === 0) {
      setNotice(null);
      return;
    }
    write(plan, self);
    sequenceRef.current += 1;
    setNotice({ id: sequenceRef.current, message: strings.autoFillUndone(plan.changes.length), undoable: false, changes: [] });
  }, [read, write, strings]);

  const dismiss = useCallback(() => setNotice(null), []);

  const tagging = useMemo<CanvasTagging>(
    () => ({ autoFilled: options.autoFilled ?? NO_MARKS, onCommit, onTagChange }),
    [options.autoFilled, onCommit, onTagChange],
  );

  return { tagging, autoFillToast: <AutoFillToast notice={notice} onUndo={undo} onDismiss={dismiss} /> };
}
