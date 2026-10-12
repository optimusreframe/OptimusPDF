"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { DocumentTabs, type DocumentBadge } from "@/app/sign-pdf/DocumentTabs";
import {
  DocumentSequence,
  type SequenceTarget,
  type SoloPlacementPlan,
} from "@/app/sign-pdf/DocumentSequence";
import { soloPlacement } from "@/app/sign-pdf/sequenceMath";
import { needsDetection } from "@/app/sign-pdf/useBackgroundDetection";
import type { DetectedField } from "@/lib/pdf/detectFields";
import { useDocumentKeys, type KeyedDoc } from "@/app/sign-pdf/documentKey";
import {
  docIdOf,
  docIdsOf,
  docStateOf,
  duplicateGroups,
  liveFields,
  projectCaptures,
  type DocId,
} from "@/app/sign-pdf/docSet";
import { syncSession, viewOf, type SignSession } from "@/app/sign-pdf/signSession";
import type { SessionBridge } from "@/app/sign-pdf/useSessionBridge";
import type { SignToolOptions } from "@/app/sign-pdf/SignToolClient";
import type { SignStrings } from "@/app/sign-pdf/strings";

const NO_DOCS: readonly KeyedDoc[] = [];

/** Lo que el anfitrion entrega a quien pinta los flujos. */
export type DocumentSessionContext = {
  /** Documento activo. */
  docId: DocId;
  file: File;
  /** Vista plana del documento activo: lo que consumen `MultiFlow` / `SoloFlow`. */
  view: SignToolOptions;
  /** Escribe en el documento ACTIVO DE ESTE RENDER (atado a su `docId`: ver `SessionBridge.setView`). Estable por documento. */
  setView: (patch: Partial<SignToolOptions>) => void;
  /** Cuantos documentos hay en la ronda. */
  docCount: number;
  /** Selector de documentos y avisos; `null` con un solo documento (la interfaz de siempre). */
  nav: ReactNode;
  /** Huella de cada documento (solo se calcula con mas de uno). */
  keys: Record<DocId, string | null>;
  /** La sesion ya puesta al dia con los archivos (bloques y documentos de ESTE render). */
  session: SignSession;
  /**
   * Envuelve los flujos con la vista continua (paginador global, tira de
   * miniaturas de todos los documentos, «Aplicar a todos» de «Solo yo»). Con un
   * solo documento devuelve el mismo arbol, sin nada propio.
   */
  withSequence: (content: ReactNode) => ReactNode;
};

export type DocumentSessionHostProps = {
  /** Archivos del shell: su orden ES la cola de documentos. */
  files: File[];
  /** Estado canonico que guarda el shell. */
  session: SignSession;
  setShellOptions: (patch: Partial<SignSession>) => void;
  bridge: SessionBridge;
  strings: SignStrings;
  /** Motivo por el que la descarga conjunta no esta disponible (varios documentos); `null` = sin aviso. */
  holdMessage: string | null;
  /** Clases del contenedor de los flujos; por defecto el apilado de la herramienta suelta (`space-y-6`). */
  className?: string;
  children: (context: DocumentSessionContext) => ReactNode;
};

/**
 * Anfitrion de la sesion de documentos. Con UN documento no pinta nada propio
 * (`nav` es `null`) y entrega la vista plana de siempre; con varios, elige el
 * documento activo y pinta el selector. Quien lo usa monta los flujos con
 * `key={docId}`: al cambiar de documento se remontan sobre SU estado.
 *
 * Mantiene la sesion al dia respecto a los archivos (poda lo de los
 * documentos quitados, elige activo, ajusta bloques) y calcula la huella de
 * toda la cola en segundo plano para avisar de copias identicas.
 */
export function DocumentSessionHost({
  files,
  session,
  setShellOptions,
  bridge,
  strings,
  holdMessage,
  className = "space-y-6",
  children,
}: DocumentSessionHostProps) {
  const docOrder = useMemo(() => docIdsOf(files), [files]);

  // El puente ve el estado confirmado de cada render (antes que los efectos
  // de los hijos, que pueden escribir en el).
  useLayoutEffect(() => {
    bridge.sync(files, session, setShellOptions);
  });

  // Lo que la sesion tendria tras ponerse al dia con los archivos. Se usa YA
  // al pintar (sin esperar al efecto) para no ensenar un fotograma con el
  // documento o el paso de la ronda anterior.
  const syncPatch = useMemo(() => syncSession(session, docOrder), [session, docOrder]);
  const effective = useMemo<SignSession>(
    () => (Object.keys(syncPatch).length > 0 ? { ...session, ...syncPatch } : session),
    [session, syncPatch],
  );
  useEffect(() => {
    if (Object.keys(syncPatch).length === 0) return;
    bridge.commit((current, currentFiles) =>
      syncSession(current, docIdsOf(currentFiles)),
    );
  }, [bridge, syncPatch]);

  const activeId = effective.activeDocId ?? docOrder[0];
  const activeFile =
    files.find((file) => docIdOf(file) === activeId) ?? files[0];

  const doc = docStateOf(effective.docs, activeId);
  const fields = useMemo(
    () => liveFields(doc, effective.signers),
    [doc, effective.signers],
  );
  const captures = useMemo(
    () => projectCaptures(effective.blocks, activeId),
    [effective.blocks, activeId],
  );
  const view = useMemo(
    () => viewOf(effective, activeId, { fields, captures }),
    [effective, activeId, fields, captures],
  );

  const setView = useCallback(
    (patch: Partial<SignToolOptions>) => bridge.setView(activeId, patch),
    [bridge, activeId],
  );

  const select = useCallback(
    (docId: DocId) => {
      bridge.commit((current) => {
        if (current.activeDocId === docId) return {};
        const doc = docStateOf(current.docs, docId);
        // «Solo yo»: un documento con la firma ya colocada se abre en la pagina de la firma
        // (tras «Aplicar a todos» puede estar en otra pagina que la ultima que se vio).
        const toSignature =
          current.mode === "single" && doc.rect.width > 0 && doc.fieldPageIndex !== doc.pageIndex;
        return {
          activeDocId: docId,
          ...(toSignature
            ? { docs: { ...current.docs, [docId]: { ...doc, fieldPageIndex: doc.pageIndex } } }
            : {}),
          // Lo seleccionado pertenecia al documento anterior.
          selectedFieldId: null,
          selectedTextFieldId: null,
          editingTextFieldId: null,
        };
      });
    },
    [bridge],
  );

  /* --- Varios documentos --- */

  const multi = docOrder.length > 1;
  const entries = useMemo<readonly KeyedDoc[]>(
    () => (multi ? files.map((file) => ({ id: docIdOf(file), file })) : NO_DOCS),
    [multi, files],
  );
  const keys = useDocumentKeys(entries);
  const duplicates = useMemo(
    () => duplicateGroups(keys, docOrder),
    [keys, docOrder],
  );

  // La huella de cada documento sella su estado en cuanto llega, tambien la
  // de los que no estan a la vista: la entrega conjunta (`canRun`, `process`)
  // la lee de la sesion y reacciona sola. Solo se rellena lo aun sin sellar:
  // una huella distinta de la ya sellada la gestiona `useDocumentSession` del
  // documento activo (reinicia), no este efecto.
  useEffect(() => {
    if (!multi) return;
    const unsealed = Object.entries(keys).filter(
      ([id, key]) => key && !docStateOf(session.docs, id).sealedKey,
    );
    if (unsealed.length === 0) return;
    bridge.commit((current, currentFiles) => {
      const live = new Set(docIdsOf(currentFiles));
      let docs = current.docs;
      for (const [id, key] of unsealed) {
        if (!key || !live.has(id)) continue;
        const state = docStateOf(docs, id);
        if (state.sealedKey) continue;
        docs = { ...docs, [id]: { ...state, sealedKey: key } };
      }
      return docs === current.docs ? {} : { docs };
    });
  }, [multi, keys, session.docs, bridge]);

  const navRef = useRef<HTMLElement>(null);
  const focusAfterSwitchRef = useRef(false);

  // Alt + Re Pag / Av Pag: documento anterior / siguiente, sin dar la vuelta.
  // No choca con las teclas del lienzo (V F I T C D, Tab, flechas). Se ignora
  // con un dialogo abierto: ahi manda el dialogo.
  useEffect(() => {
    if (!multi) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "PageUp" && event.key !== "PageDown") return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const index = docOrder.indexOf(activeId);
      const target = docOrder[index + (event.key === "PageDown" ? 1 : -1)];
      event.preventDefault();
      if (!target) return;
      focusAfterSwitchRef.current = true;
      select(target);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [multi, docOrder, activeId, select]);

  // El lienzo se remonta al cambiar de documento y el foco que tenia se
  // pierde: tras un cambio con el teclado, va al selector (al documento activo).
  useEffect(() => {
    if (!focusAfterSwitchRef.current) return;
    focusAfterSwitchRef.current = false;
    navRef.current
      ?.querySelector<HTMLElement>('[aria-current="true"]')
      ?.focus({ preventScroll: true });
  }, [activeId]);

  /* --- Vista continua (W4-U4) --- */

  const sequenceDocs = useMemo(
    () => files.map((file) => ({ id: docIdOf(file), name: file.name, file })),
    [files],
  );

  /** Salta a una pagina de un documento (y, si se pide, a un campo de texto para editarlo). */
  const go = useCallback(
    (target: SequenceTarget) => {
      bridge.commit((current, currentFiles) => {
        if (!docIdsOf(currentFiles).includes(target.docId)) return {};
        const doc = docStateOf(current.docs, target.docId);
        return {
          activeDocId: target.docId,
          docs:
            doc.fieldPageIndex === target.pageIndex
              ? current.docs
              : {
                  ...current.docs,
                  [target.docId]: { ...doc, fieldPageIndex: target.pageIndex },
                },
          // Lo seleccionado pertenecia al documento anterior.
          selectedFieldId: null,
          selectedTextFieldId: target.textFieldId ?? null,
          editingTextFieldId: target.textFieldId ?? null,
        };
      });
    },
    [bridge],
  );

  /** «Solo yo»: escribe la colocacion de la firma de varios documentos de una vez. */
  const placeSolo = useCallback(
    (plan: SoloPlacementPlan) => {
      bridge.commit((current, currentFiles) => {
        const live = new Set(docIdsOf(currentFiles));
        let docs = current.docs;
        for (const [id, placement] of Object.entries(plan)) {
          if (!live.has(id)) continue;
          docs = {
            ...docs,
            [id]: {
              ...docStateOf(docs, id),
              rect: placement.rect,
              pageIndex: placement.pageIndex,
            },
          };
        }
        return docs === current.docs ? {} : { docs };
      });
    },
    [bridge],
  );

  /** Campos detectados en segundo plano en un documento aun sin abrir: solo si nadie los toco entretanto. */
  const onDetected = useCallback(
    (docId: DocId, file: File, fields: DetectedField[]) => {
      bridge.commit((current, currentFiles) => {
        if (!currentFiles.includes(file) || docIdOf(file) !== docId) return {};
        const doc = docStateOf(current.docs, docId);
        if (!needsDetection(doc) || fields.length === 0) return {};
        return { docs: { ...current.docs, [docId]: { ...doc, textFields: fields } } };
      });
    },
    [bridge],
  );

  const withSequence = (content: ReactNode): ReactNode => (
    <DocumentSequence
      enabled={multi}
      docs={sequenceDocs}
      activeId={activeId}
      session={effective}
      go={go}
      placeSolo={placeSolo}
      onDetected={onDetected}
      strings={strings}
    >
      {content}
    </DocumentSequence>
  );

  /** «Solo yo» con firma creada: cada documento dice si ya la lleva colocada. */
  const badges = useMemo<Record<DocId, DocumentBadge> | undefined>(() => {
    if (!multi || effective.mode !== "single" || effective.signaturePng === "") {
      return undefined;
    }
    const out: Record<DocId, DocumentBadge> = {};
    for (const id of docOrder) {
      const placed = soloPlacement(effective.docs[id]) === "placed";
      out[id] = {
        done: placed,
        label: placed ? strings.docBadgePlaced : strings.docBadgePending,
      };
    }
    return out;
  }, [multi, effective, docOrder, strings]);

  const nav = multi ? (
    <section className="space-y-3">
      <DocumentTabs
        docs={files.map((file) => ({ id: docIdOf(file), name: file.name }))}
        activeId={activeId}
        onSelect={select}
        strings={strings}
        navRef={navRef}
        badges={badges}
        quietLive
      />
      {duplicates.map((group) => (
        <p
          key={group.join("|")}
          role="status"
          className="text-footnote leading-relaxed text-muted-foreground"
        >
          {strings.duplicateDocsNotice(
            group.map((id) => files.find((file) => docIdOf(file) === id)?.name ?? id),
          )}
        </p>
      ))}
      {holdMessage ? (
        <p role="status" className="text-footnote leading-relaxed text-muted-foreground">
          {holdMessage}
        </p>
      ) : null}
    </section>
  ) : null;

  return (
    <div className={className}>
      {children({
        docId: activeId,
        file: activeFile,
        view,
        setView,
        docCount: docOrder.length,
        nav,
        keys,
        session: effective,
        withSequence,
      })}
    </div>
  );
}
