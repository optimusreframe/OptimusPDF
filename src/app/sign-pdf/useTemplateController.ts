"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { autoMapFile } from "@/lib/pdf/autoMapFile";
import { getDocument } from "@/lib/docLibrary/store";
import { compareFingerprints, findBestMatch } from "@/lib/docLibrary/match";
import { findTemplateForFingerprint, getTemplateForDocument } from "@/lib/docLibrary/templatesStore";
import type { DocTemplate } from "@/lib/docLibrary/templateTypes";
import type { MatchLevel, MatchResult } from "@/lib/docLibrary/types";
import type { Language } from "@/lib/i18n";
import { nextFieldId, nextTextFieldId } from "@/app/sign-pdf/DocumentCanvas";
import { nextSignerId } from "@/app/sign-pdf/SignerManager";
import { docIdOf, docIdsOf, type DocId } from "@/app/sign-pdf/docSet";
import type { SignSession } from "@/app/sign-pdf/signSession";
import type { SessionBridge } from "@/app/sign-pdf/useSessionBridge";
import { isRestored, libraryIdOf } from "@/app/sign-pdf/templateFileRegistry";
import { readRememberedCount, rememberCount } from "@/app/sign-pdf/templatePrefs";
import { defaultRoles, emptyContent, type EditorContent } from "@/app/sign-pdf/templateEditorModel";
import { saveTemplateToLibrary, seedContentFromSession, type SaveFailure } from "@/app/sign-pdf/templateLibrary";
import { basisOf, countUsableTemplates, fingerprintOfFile, pageCountOfFile } from "@/app/sign-pdf/templateCandidates";
import { planManualMatch, type PageScope } from "@/app/sign-pdf/templateManual";
import { libraryTemplateStrings } from "@/app/sign-pdf/libraryTemplateStrings";
import { rememberTemplateUse } from "@/app/sign-pdf/templateUse";
import {
  autoMapSignerCount,
  chooseCount,
  clampCount,
  hasLoss,
  isPristine,
  planAccept,
  planAutoMapApplication,
  planTemplateApplication,
  planUndo,
  undoWork,
  variantSupport,
  type AppliedRecord,
  type Mint,
  type PendingField,
  type WorkLoss,
} from "@/app/sign-pdf/templateSession";
import type { SignStrings } from "@/app/sign-pdf/strings";

/*
 * Aplicacion automatica de plantillas y automapeo al cargar documentos en Firmar (Fase 2 · U2.4). Un controlador por
 * herramienta, que vive ARRIBA (en `SignToolClient`): `ToolShell` desmonta el espacio de trabajo mientras procesa, y el
 * estado de los avisos («Plantilla aplicada · Deshacer», «¿Guardar como plantilla?») tiene que sobrevivir a eso.
 *
 * Por cada archivo NUEVO de la ronda (una sola vez):
 *   1. huella en segundo plano (worker) y busqueda en la biblioteca;
 *   2. «Coincide» -> se aplica la plantilla para el nº de firmantes; «Parece» -> se pregunta; nada -> automapeo;
 *   3. el automapeo (si esta activado y se trabaja con varios firmantes) coloca los campos de confianza alta y deja el
 *      resto como sugerencias.
 * Nada se aplica sobre un trabajo ya hecho: los archivos restaurados (borrador, configuracion) y los documentos que ya no
 * estan limpios se saltan. Todo es deshacible. Nada sale del dispositivo.
 *
 * W3-A2: ademas de lo automatico, la persona puede ELEGIR a mano una plantilla de «Mis documentos» desde la hoja «Plantillas»
 * (`applyChosen`: mismo camino, mismo aviso «Plantilla aplicada · Deshacer», misma politica de confirmacion si quitaria trabajo
 * suyo), y si al cargar un PDF no se aplico ninguna plantilla pero la biblioteca tiene, se ofrece elegir (`offers`, no bloqueante).
 * La huella del archivo se comparte con la hoja (`fingerprintOfFile`): se calcula una sola vez por archivo.
 */

export type NoticePhase = "asking" | "applied" | "automapping" | "automapped";

export type TemplateLookup = {
  template: DocTemplate;
  documentId: string | null;
  level: MatchLevel;
  percent: number;
  /** `null` = el mismo documento (traspaso desde «Mis documentos»): mapa identidad. Lo que usa la aplicacion: el mapa de paginas y el nivel. */
  match: Pick<MatchResult, "mappedPages" | "reviewPages" | "level" | "percent"> | null;
  /** Paginas del documento cargado. */
  pageCount: number;
  /** Aplicacion a mano «todas por posicion»: paginas del documento (0-based) colocadas sin que la comparacion las avale. */
  flaggedPages?: number[];
};

/** «Hay N plantillas en Mis documentos»: aviso no bloqueante al cargar un PDF al que no se aplico ninguna. */
export type LibraryOffer = { docId: DocId; name: string; count: number };

/** Una plantilla de «Mis documentos» elegida a mano en la hoja «Plantillas». */
export type ManualRequest = {
  /** Documentos de la ronda a los que se aplica (el activo, o todos). */
  docIds: DocId[];
  template: DocTemplate;
  /** Documento de la biblioteca sobre el que se configuro la plantilla (`null` = sin documento: se coloca por posicion). */
  documentId: string | null;
  scope: PageScope;
  /** Nº de firmantes; ausente = el de siempre (los que ya hay, los recordados o 2). */
  count?: 1 | 2;
  /** La persona ya confirmo que se reemplace lo que hay (aplicar a todos): no se vuelve a preguntar. */
  allowLoss?: boolean;
};

export type ManualOutcome = { applied: number; blocked: number; skipped: number };

/**
 * Un cambio de nº de firmantes (o una re-aplicacion) que quitaria trabajo de la persona y espera su confirmacion. `lookup`
 * `null` = el automapeo. Mientras exista, no se ha tocado nada.
 */
export type PendingChange = {
  count: 1 | 2;
  loss: WorkLoss;
  lookup: TemplateLookup | null;
  /** Aplicar lo guardado desde el editor: al confirmar se sigue reemplazando lo que ya habia (no se duplica). */
  replaceDocument?: boolean;
};

export type DocNotice = {
  docId: DocId;
  name: string;
  phase: NoticePhase;
  lookup: TemplateLookup | null;
  record: AppliedRecord | null;
  pending: PendingField[];
  count: 1 | 2;
  /** Nº de firmantes de la sesion cuando se aplico (cambiarlo despues re-aplica la variante). */
  signerCount: number;
  offerSave: "available" | "saved" | "dismissed" | null;
  /** Feedback del guardado «Plantilla guardada · aplicada a N páginas» (o el motivo del fallo). */
  saveResult: { ok: true; pages: number } | { ok: false; reason: SaveFailure } | null;
  busy: boolean;
  /** Cambio que espera confirmacion porque quitaria firmas, nombres o valores de la persona. */
  confirm: PendingChange | null;
  /** El automapeo llego al tope de campos por documento: cuantos se colocaron y que paginas (0-based) quedaron sin iniciales. */
  cap: { placed: number; pages: number[] } | null;
};

/** Lo que añade W3-A2 al controlador: elegir a mano plantillas de «Mis documentos». Opcional para quien solo pinta los avisos. */
export type LibraryControls = {
  /** Avisos «Hay N plantillas en Mis documentos · Elegir» (uno por documento sin plantilla automatica). */
  offers: LibraryOffer[];
  dismissLibraryOffer: (docId: DocId) => void;
  /** Aplica a mano una plantilla de «Mis documentos»; si quitaria trabajo de la persona, deja el aviso esperando su confirmacion. */
  applyChosen: (request: ManualRequest) => Promise<ManualOutcome>;
};

export type TemplateController = Partial<LibraryControls> & {
  notices: DocNotice[];
  /** Region viva UNICA de este bloque. */
  announcement: string;
  notify: (files: File[]) => void;
  undo: (docId: DocId) => void;
  dismiss: (docId: DocId) => void;
  setCount: (docId: DocId, count: 1 | 2) => void;
  /** «Quitar y cambiar»: hace el cambio que esperaba confirmacion (y quita lo anunciado). */
  confirmChange: (docId: DocId) => void;
  /** «Cancelar»: no se toca nada. */
  cancelChange: (docId: DocId) => void;
  acceptSimilar: (docId: DocId) => void;
  declineSimilar: (docId: DocId) => void;
  accept: (docId: DocId, key: string) => void;
  acceptAll: (docId: DocId) => void;
  detect: (docId: DocId) => void;
  saveAsTemplate: (docId: DocId) => void;
  dismissOffer: (docId: DocId) => void;
  /** Tras guardar una plantilla de este documento en el editor: se aplica la guardada. */
  applySaved: (docId: DocId, template: DocTemplate, documentId: string, pageCount: number) => void;
};

type ApplyOutcome = "applied" | "blocked" | "skipped";

const MINT: Mint = { signerId: nextSignerId, fieldId: nextFieldId, textFieldId: nextTextFieldId };
const ANNOUNCE_MS = 6000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ControllerParams = {
  bridge: SessionBridge;
  language: Language;
  strings: SignStrings;
  applyEnabled: boolean;
  detectEnabled: boolean;
  /** Ofrecer elegir una plantilla a mano cuando al cargar un PDF no se aplico ninguna y la biblioteca tiene (la hoja «Plantillas» tiene que estar disponible). */
  offerEnabled?: boolean;
  /** Un documento de «Mis documentos» con la plantilla desactualizada NO coincide con ella: se avisa (nombre del archivo). */
  onStaleSkipped?: (fileName: string) => void;
};

export function useTemplateController({ bridge, language, strings, applyEnabled, detectEnabled, offerEnabled = false, onStaleSkipped }: ControllerParams): TemplateController & LibraryControls {
  const [notices, setNotices] = useState<Record<DocId, DocNotice>>({});
  const noticesRef = useRef<Record<DocId, DocNotice>>({});
  const [offerMap, setOfferMap] = useState<Record<DocId, LibraryOffer>>({});
  const [announcement, setAnnouncement] = useState("");

  const latest = useRef({ language, strings, applyEnabled, detectEnabled, offerEnabled, onStaleSkipped });
  useEffect(() => {
    latest.current = { language, strings, applyEnabled, detectEnabled, offerEnabled, onStaleSkipped };
  });

  const started = useRef(new WeakSet<File>());
  const aborts = useRef(new Map<DocId, AbortController>());
  const waitingForMulti = useRef(new Set<DocId>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const running = aborts.current;
    return () => {
      alive.current = false;
      for (const controller of running.values()) controller.abort();
    };
  }, []);

  useEffect(() => {
    if (!announcement) return;
    const timer = setTimeout(() => setAnnouncement(""), ANNOUNCE_MS);
    return () => clearTimeout(timer);
  }, [announcement]);

  /* --- Estado de los avisos --- */

  const patchNotice = useCallback((docId: DocId, patch: Partial<DocNotice> | ((current: DocNotice | undefined) => Partial<DocNotice> | null)) => {
    const current = noticesRef.current[docId];
    const change = typeof patch === "function" ? patch(current) : patch;
    if (change === null) return;
    const base: DocNotice = current ?? {
      docId,
      name: "",
      phase: "applied",
      lookup: null,
      record: null,
      pending: [],
      count: 2,
      signerCount: 0,
      offerSave: null,
      saveResult: null,
      busy: false,
      confirm: null,
      cap: null,
    };
    const next = { ...noticesRef.current, [docId]: { ...base, ...change } };
    noticesRef.current = next;
    if (alive.current) setNotices(next);
  }, []);

  const removeNotice = useCallback((docId: DocId) => {
    if (!(docId in noticesRef.current)) return;
    const { [docId]: removed, ...rest } = noticesRef.current;
    void removed;
    noticesRef.current = rest;
    if (alive.current) setNotices(rest);
  }, []);

  const say = useCallback((text: string) => {
    if (alive.current) setAnnouncement(text);
  }, []);

  const putOffer = useCallback((offer: LibraryOffer) => {
    if (alive.current) setOfferMap((current) => ({ ...current, [offer.docId]: offer }));
  }, []);

  const removeOffer = useCallback((docId: DocId) => {
    if (!alive.current) return;
    setOfferMap((current) => {
      if (!(docId in current)) return current;
      const { [docId]: removed, ...rest } = current;
      void removed;
      return rest;
    });
  }, []);

  /* --- Utilidades --- */

  const fileOf = useCallback((docId: DocId): File | null => bridge.read().files.find((file) => docIdOf(file) === docId) ?? null, [bridge]);

  /** Espera a que el anfitrion haya puesto al dia la sesion con los archivos (si no, `ensureBlocks` veria una cola vacia). */
  const settled = useCallback(
    async (docId: DocId): Promise<boolean> => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const { session, files } = bridge.read();
        if (!files.some((file) => docIdOf(file) === docId)) return false;
        if (session.docOrder.includes(docId)) return true;
        await sleep(25);
      }
      return bridge.read().files.some((file) => docIdOf(file) === docId);
    },
    [bridge],
  );

  /* --- Aplicar una plantilla --- */

  /**
   * Aplica `lookup` al documento. `"blocked"`: el cambio quitaria trabajo de la persona (firmas, un nombre escrito, valores)
   * y NO se hizo: el aviso queda esperando confirmacion (`confirm`). `allowLoss` = la persona ya lo confirmo.
   */
  const applyTemplateNow = useCallback(
    async (file: File, lookup: TemplateLookup, requested?: 1 | 2, force = false, allowLoss = false, replaceDocument = false): Promise<ApplyOutcome> => {
      const docId = docIdOf(file);
      if (!(await settled(docId))) return "skipped";
      const support = variantSupport(lookup.template);
      const before = bridge.read().session;
      const previous = noticesRef.current[docId]?.record ?? undefined;
      const count = requested ?? chooseCount({ signers: before.signers.length, remembered: readRememberedCount(), support });
      let applied: { record: AppliedRecord; pending: PendingField[]; signerCount: number } | null = null;
      let blocked: WorkLoss | null = null;
      bridge.commit((current) => {
        if (!force && !isPristine(current, docId)) return {};
        const plan = planTemplateApplication({
          template: lookup.template,
          match: lookup.match,
          count,
          session: current,
          docId,
          pageCount: lookup.pageCount,
          mint: MINT,
          previous,
          documentId: lookup.documentId,
          replaceDocument,
          ...(lookup.flaggedPages ? { flaggedPages: lookup.flaggedPages } : {}),
        });
        if (!allowLoss && hasLoss(plan.loss)) {
          blocked = plan.loss;
          return {};
        }
        applied = { record: plan.record, pending: plan.pending, signerCount: (plan.patch.signers ?? current.signers).length };
        return plan.patch;
      });
      const stopped = blocked as WorkLoss | null;
      if (stopped) {
        patchNotice(docId, { busy: false, confirm: { count, loss: stopped, lookup, ...(replaceDocument ? { replaceDocument: true } : {}) } });
        return "blocked";
      }
      const result = applied as { record: AppliedRecord; pending: PendingField[]; signerCount: number } | null;
      if (!result) return "skipped";
      rememberCount(result.record.count);
      rememberTemplateUse(lookup.template.id);
      removeOffer(docId);
      patchNotice(docId, {
        name: file.name,
        phase: "applied",
        lookup,
        record: result.record,
        pending: result.pending,
        count: result.record.count,
        signerCount: result.signerCount,
        offerSave: null,
        saveResult: null,
        busy: false,
        confirm: null,
        cap: null,
      });
      const t = latest.current.strings.template;
      const kept = result.record.keptSigners;
      say(kept && kept.length > 0 ? `${t.appliedAnnounce(lookup.template.name, result.record.count, result.record.pages)} ${t.notices.keptSigners(kept)}` : t.appliedAnnounce(lookup.template.name, result.record.count, result.record.pages));
      return "applied";
    },
    [bridge, patchNotice, removeOffer, say, settled],
  );

  /* --- Automapeo --- */

  const runAutoMap = useCallback(
    async (file: File, wantedCount?: 1 | 2, allowLoss = false): Promise<boolean> => {
      const docId = docIdOf(file);
      if (!(await settled(docId))) return false;
      const initial = bridge.read().session;
      const known = wantedCount ?? (initial.signers.length >= 1 ? clampCount(initial.signers.length) : null);
      const priorPhase = noticesRef.current[docId]?.phase;
      patchNotice(docId, { name: file.name, phase: "automapping", busy: true });
      const controller = new AbortController();
      aborts.current.get(docId)?.abort();
      aborts.current.set(docId, controller);
      try {
        const analysed = known ?? 2;
        let result = await autoMapFile(file, { signers: analysed, locale: latest.current.language }, controller.signal);
        if (controller.signal.aborted || !fileOf(docId)) return false;
        const count = known ?? autoMapSignerCount(result);
        if (count !== analysed && result.fields.length > 0) result = await autoMapFile(file, { signers: count, locale: latest.current.language }, controller.signal);
        if (controller.signal.aborted || !fileOf(docId)) return false;
        const previous = noticesRef.current[docId]?.record ?? undefined;
        const force = previous !== undefined;
        let applied: { record: AppliedRecord; pending: PendingField[]; signerCount: number } | null = null;
        let blocked: WorkLoss | null = null;
        const hasAnything = result.fields.some((field) => field.tier !== "ignore");
        if (hasAnything) {
          bridge.commit((current) => {
            if (!force && !isPristine(current, docId)) return {};
            const plan = planAutoMapApplication({
              result,
              count,
              session: current,
              docId,
              roles: defaultRoles(latest.current.language),
              mint: MINT,
              previous,
            });
            if (!allowLoss && hasLoss(plan.loss)) {
              blocked = plan.loss;
              return {};
            }
            applied = { record: plan.record, pending: plan.pending, signerCount: (plan.patch.signers ?? current.signers).length };
            return plan.patch;
          });
        }
        const stopped = blocked as WorkLoss | null;
        if (stopped) {
          // Quitaria trabajo de la persona: no se toca nada y se pregunta (el aviso anterior sigue en pie).
          patchNotice(docId, { phase: priorPhase && priorPhase !== "automapping" ? priorPhase : "automapped", busy: false, confirm: { count, loss: stopped, lookup: null } });
          return false;
        }
        const done = applied as { record: AppliedRecord; pending: PendingField[]; signerCount: number } | null;
        if (!done) {
          removeNotice(docId);
          return false;
        }
        patchNotice(docId, {
          name: file.name,
          phase: "automapped",
          lookup: null,
          record: done.record,
          pending: done.pending,
          count: done.record.count,
          signerCount: done.signerCount,
          offerSave: "available",
          saveResult: null,
          busy: false,
          confirm: null,
          // El tope de campos por documento se aplica sin avisar: aqui se le dice a la persona que paginas quedaron sin cubrir.
          cap: result.warnings.some((warning) => warning.code === "document-field-cap")
            ? { placed: done.record.placed ?? 0, pages: result.pages.filter((page) => !page.hasInitialsLine).map((page) => page.pageIndex) }
            : null,
        });
        rememberCount(done.record.count);
        say(latest.current.strings.template.automapAnnounce(done.record.placed ?? 0, done.pending.length));
        return true;
      } catch {
        // El automapeo nunca bloquea nada: sin campos propuestos se sigue a mano.
        if (!controller.signal.aborted) removeNotice(docId);
        return false;
      } finally {
        if (aborts.current.get(docId) === controller) aborts.current.delete(docId);
      }
    },
    [bridge, fileOf, patchNotice, removeNotice, say, settled],
  );

  /* --- Tuberia de un archivo --- */

  const pipeline = useCallback(
    async (file: File) => {
      const docId = docIdOf(file);
      const options = latest.current;
      if (!options.applyEnabled && !options.detectEnabled && !options.offerEnabled) return;
      const controller = new AbortController();
      aborts.current.set(docId, controller);
      const stale = () => controller.signal.aborted || !fileOf(docId);
      try {
        let lookup: TemplateLookup | null = null;
        let lookupFailed = false;
        if (options.applyEnabled) {
          try {
            let staleSkipped = false;
            const libraryId = libraryIdOf(file);
            if (libraryId) {
              const [entry, template] = await Promise.all([getDocument(libraryId), getTemplateForDocument(libraryId)]);
              if (entry && template && !entry.templateStale) {
                lookup = { template, documentId: entry.id, level: "exact", percent: 100, match: null, pageCount: entry.pageCount };
              } else if (entry && template && entry.templateStale) {
                // Se reemplazó el PDF de «Mis documentos» y la plantilla ya no coincide con él: NO se asume el mismo documento.
                // Se compara el PDF REAL con el sobre el que se configuró la plantilla: si coincide se aplica con su mapa de
                // páginas, si «Parece» se pregunta y si no, sigue el automapeo.
                const fingerprint = await fingerprintOfFile(file, controller.signal);
                if (stale()) return;
                const match = findBestMatch(fingerprint, [{ id: template.id, fingerprint: entry.templateStale.base, updatedAt: template.updatedAt }]);
                if (match && match.level !== "none") {
                  lookup = { template, documentId: entry.id, level: match.level, percent: match.percent, match, pageCount: fingerprint.pageCount };
                } else {
                  staleSkipped = true;
                }
              }
            }
            if (!lookup) {
              // Cargar el PDF directamente y abrirlo desde «Mis documentos» dan el MISMO resultado: un documento de la biblioteca sin
              // plantilla propia (o con la suya desactualizada) tambien se reconoce por su huella, como cualquier otro PDF.
              const fingerprint = await fingerprintOfFile(file, controller.signal);
              if (stale()) return;
              const found = await findTemplateForFingerprint(fingerprint);
              if (found && found.match.level !== "none") {
                lookup = { template: found.template, documentId: found.document.id, level: found.match.level, percent: found.match.percent, match: found.match, pageCount: fingerprint.pageCount };
              }
            }
            if (!lookup && staleSkipped) options.onStaleSkipped?.(file.name);
          } catch {
            // Sin huella o sin biblioteca no hay plantilla que aplicar: la herramienta sigue como siempre.
            lookupFailed = true;
          }
        }
        if (stale()) return;
        if (lookup && (lookup.level === "exact" || lookup.level === "match")) {
          if (!isPristine(bridge.read().session, docId)) return;
          if ((await applyTemplateNow(file, lookup)) === "applied") return;
        } else if (lookup && lookup.level === "similar") {
          if (!isPristine(bridge.read().session, docId)) return;
          patchNotice(docId, { name: file.name, phase: "asking", lookup, record: null, pending: [], offerSave: null, saveResult: null, busy: false });
          say(options.strings.template.similarAnnounce(lookup.template.name, lookup.percent));
          return;
        }
        // Ninguna plantilla se aplico sola: si la biblioteca tiene, se ofrece elegir una a mano (sin quitar nada de lo demas).
        if (!lookup && options.offerEnabled && isPristine(bridge.read().session, docId)) {
          const count = await countUsableTemplates();
          if (stale()) return;
          if (count > 0) {
            putOffer({ docId, name: file.name, count });
            say(libraryTemplateStrings(options.language).offerTitle(count));
          }
        }
        if (lookupFailed) return;
        if (!options.detectEnabled) return;
        if (bridge.read().session.mode !== "multi") {
          // Con «Solo yo» no se cambia de modo por un documento desconocido: se espera a que la persona elija varios firmantes.
          waitingForMulti.current.add(docId);
          return;
        }
        if (isPristine(bridge.read().session, docId)) await runAutoMap(file);
      } catch {
        // Sin huella o sin biblioteca no hay plantilla que aplicar: la herramienta sigue como siempre.
      } finally {
        if (aborts.current.get(docId) === controller) aborts.current.delete(docId);
      }
    },
    [applyTemplateNow, bridge, fileOf, patchNotice, putOffer, runAutoMap, say],
  );

  /* --- Cambio de nº de firmantes --- */

  /**
   * Vuelve a aplicar con otro nº de firmantes. Si eso quitaria firmas, un nombre escrito o valores de la persona, NO lo
   * hace: deja el aviso esperando su confirmacion (`confirm`); `allowLoss` = ya la dio.
   */
  const reapply = useCallback(
    async (docId: DocId, count: 1 | 2, allowLoss = false) => {
      const file = fileOf(docId);
      const notice = noticesRef.current[docId];
      if (!file || !notice) return;
      patchNotice(docId, { busy: true });
      if (notice.record?.source === "template" && notice.lookup) {
        await applyTemplateNow(file, notice.lookup, count, true, allowLoss);
      } else {
        await runAutoMap(file, count, allowLoss);
      }
      patchNotice(docId, { busy: false });
    },
    [applyTemplateNow, fileOf, patchNotice, runAutoMap],
  );

  /* --- notify: lo llama el anfitrion al cambiar los archivos o la sesion --- */

  const notify = useCallback(
    (files: File[]) => {
      const live = new Set(docIdsOf(files));
      if (alive.current) {
        setOfferMap((current) => (Object.keys(current).every((id) => live.has(id)) ? current : Object.fromEntries(Object.entries(current).filter(([id]) => live.has(id)))));
      }
      for (const docId of Object.keys(noticesRef.current)) {
        if (live.has(docId)) continue;
        aborts.current.get(docId)?.abort();
        aborts.current.delete(docId);
        waitingForMulti.current.delete(docId);
        removeNotice(docId);
      }
      for (const file of files) {
        if (started.current.has(file)) continue;
        started.current.add(file);
        if (isRestored(file)) continue;
        queue.current = queue.current.then(() => pipeline(file)).catch(() => undefined);
      }
      const session = bridge.read().session;
      // Un documento desconocido que esperaba a «Varios firmantes»: al elegirlo, se mapea.
      if (session.mode === "multi") {
        for (const docId of [...waitingForMulti.current]) {
          const file = files.find((candidate) => docIdOf(candidate) === docId);
          waitingForMulti.current.delete(docId);
          if (file && latest.current.detectEnabled && isPristine(session, docId)) {
            queue.current = queue.current.then(() => runAutoMap(file).then(() => undefined)).catch(() => undefined);
          }
        }
      }
      // Cambiar entre 1 y 2 firmantes en el paso «Firmantes» vuelve a aplicar la variante que corresponde.
      if (session.mode === "multi") {
        for (const notice of Object.values(noticesRef.current)) {
          if (!notice.record || notice.busy || notice.confirm || (notice.phase !== "applied" && notice.phase !== "automapped")) continue;
          const length = session.signers.length;
          if (length === notice.signerCount) continue;
          if (length === 0) {
            patchNotice(notice.docId, { signerCount: 0 });
            continue;
          }
          const support = notice.lookup ? variantSupport(notice.lookup.template) : { one: true, two: true };
          const wanted = chooseCount({ signers: length, remembered: null, support });
          patchNotice(notice.docId, { signerCount: length });
          if (wanted !== notice.record.count) void reapply(notice.docId, wanted);
        }
      }
    },
    [bridge, patchNotice, pipeline, reapply, removeNotice, runAutoMap],
  );

  /* --- Acciones de los avisos --- */

  const undo = useCallback(
    (docId: DocId) => {
      const notice = noticesRef.current[docId];
      if (!notice?.record) return;
      const record = notice.record;
      // «Deshacer» revierte lo que puso la plantilla, nunca lo que la persona aporto: con trabajo hecho no se ofrece, y esto
      // es la red de seguridad por si se llega aqui de todos modos.
      const work = undoWork(bridge.read().session, docId, record);
      if (hasLoss(work)) {
        say(latest.current.strings.template.undoBlockedAnnounce);
        return;
      }
      bridge.commit((current) => planUndo(current, docId, record));
      waitingForMulti.current.delete(docId);
      removeNotice(docId);
      say(latest.current.strings.template.undoneAnnounce);
    },
    [bridge, removeNotice, say],
  );

  const dismiss = useCallback((docId: DocId) => removeNotice(docId), [removeNotice]);

  const setCount = useCallback(
    (docId: DocId, count: 1 | 2) => {
      const notice = noticesRef.current[docId];
      if (!notice || notice.count === count || notice.busy || notice.confirm) return;
      void reapply(docId, count);
    },
    [reapply],
  );

  const confirmChange = useCallback(
    (docId: DocId) => {
      const pending = noticesRef.current[docId]?.confirm;
      if (!pending) return;
      const file = fileOf(docId);
      patchNotice(docId, { confirm: null });
      if (!file) return;
      patchNotice(docId, { busy: true });
      void (pending.lookup ? applyTemplateNow(file, pending.lookup, pending.count, true, true, pending.replaceDocument === true).then(() => undefined) : runAutoMap(file, pending.count, true).then(() => undefined)).then(() => patchNotice(docId, { busy: false }));
    },
    [applyTemplateNow, fileOf, patchNotice, runAutoMap],
  );

  /** «Cancelar»: no se toco nada, solo se cierra la pregunta. */
  const cancelChange = useCallback((docId: DocId) => patchNotice(docId, (current) => (current?.confirm ? { confirm: null } : null)), [patchNotice]);

  const acceptSimilar = useCallback(
    (docId: DocId) => {
      const file = fileOf(docId);
      const notice = noticesRef.current[docId];
      if (!file || !notice?.lookup) return;
      patchNotice(docId, { busy: true });
      void applyTemplateNow(file, notice.lookup).then((outcome) => {
        if (outcome !== "applied") removeNotice(docId);
        else patchNotice(docId, { busy: false });
      });
    },
    [applyTemplateNow, fileOf, patchNotice, removeNotice],
  );

  const declineSimilar = useCallback(
    (docId: DocId) => {
      const file = fileOf(docId);
      removeNotice(docId);
      // «No» a «Parece la plantilla X» no cierra la puerta a las demas: se ofrece elegir otra a mano.
      if (file && latest.current.offerEnabled) {
        void countUsableTemplates().then((count) => {
          if (count > 0 && fileOf(docId)) putOffer({ docId, name: file.name, count });
        });
      }
      if (file && latest.current.detectEnabled) {
        if (bridge.read().session.mode !== "multi") waitingForMulti.current.add(docId);
        else queue.current = queue.current.then(() => runAutoMap(file).then(() => undefined)).catch(() => undefined);
      }
    },
    [bridge, fileOf, putOffer, removeNotice, runAutoMap],
  );

  const takePending = useCallback(
    (docId: DocId, keys: readonly string[]) => {
      const notice = noticesRef.current[docId];
      if (!notice) return;
      const chosen = notice.pending.filter((item) => keys.includes(item.key));
      const accepted = new Set<string>();
      bridge.commit((current) => {
        let session = current;
        let patch: Partial<SignSession> = {};
        for (const item of chosen) {
          const planned = planAccept(session, docId, item, MINT);
          if (!planned) continue;
          accepted.add(item.key);
          patch = { ...patch, ...planned.patch };
          session = { ...session, ...planned.patch };
        }
        return patch;
      });
      patchNotice(docId, (current) => (current ? { pending: current.pending.filter((item) => !accepted.has(item.key)) } : null));
      // Lo aceptado pasa a ser del documento: «Deshacer» ya no lo retira (no esta en el registro).
    },
    [bridge, patchNotice],
  );

  const accept = useCallback((docId: DocId, key: string) => takePending(docId, [key]), [takePending]);
  const acceptAll = useCallback(
    (docId: DocId) => {
      const notice = noticesRef.current[docId];
      // Las firmas «sin firmante claro» (p. ej. la de la otra parte) solo se añaden de una en una, a propósito.
      if (notice) takePending(docId, notice.pending.filter((item) => !(item.kind === "sign" && item.signerIndex === undefined)).map((item) => item.key));
    },
    [takePending],
  );

  const detect = useCallback(
    (docId: DocId) => {
      const file = fileOf(docId);
      if (!file) return;
      const session = bridge.read().session;
      if (session.mode !== "multi") bridge.commit(() => ({ mode: "multi" }));
      void runAutoMap(file, noticesRef.current[docId]?.count);
    },
    [bridge, fileOf, runAutoMap],
  );

  const dismissOffer = useCallback((docId: DocId) => patchNotice(docId, { offerSave: "dismissed" }), [patchNotice]);

  const saveAsTemplate = useCallback(
    (docId: DocId) => {
      const file = fileOf(docId);
      const notice = noticesRef.current[docId];
      if (!file || !notice) return;
      patchNotice(docId, { busy: true });
      const { session } = bridge.read();
      const language = latest.current.language;
      const name = file.name.replace(/\.pdf$/i, "").slice(0, 120) || "Plantilla";
      const content: EditorContent = seedContentFromSession({
        session,
        docId,
        name,
        language,
        mint: { sign: nextFieldId, text: nextTextFieldId },
        base: emptyContent(name, language),
        textMeta: notice.record?.textMeta,
      });
      // La otra variante (1 vs 2 firmantes) de una plantilla ya guardada de este mismo PDF se conserva: se guarda solo la que se uso aqui.
      void saveTemplateToLibrary({ file, content, documentId: null, template: null, keepOtherVariant: true }).then((result) => {
        if (result.ok) {
          patchNotice(docId, { busy: false, offerSave: "saved", saveResult: { ok: true, pages: result.pages } });
          say(latest.current.strings.template.savedAnnounce(result.pages));
        } else {
          patchNotice(docId, { busy: false, saveResult: { ok: false, reason: result.reason } });
          say(latest.current.strings.template.saveFailed(result.reason));
        }
      });
    },
    [bridge, fileOf, patchNotice, say],
  );

  const applySaved = useCallback(
    (docId: DocId, template: DocTemplate, documentId: string, pageCount: number) => {
      const file = fileOf(docId);
      if (!file) return;
      // El editor se abrio con los campos de este documento: lo que ya hay se reconoce y se reemplaza, no se duplica.
      void applyTemplateNow(file, { template, documentId, level: "exact", percent: 100, match: null, pageCount }, undefined, true, false, true);
    },
    [applyTemplateNow, fileOf],
  );

  /* --- Elegir una plantilla de «Mis documentos» a mano (hoja «Plantillas») --- */

  /**
   * Aplica `request.template` a cada documento pedido por el MISMO camino que la aplicacion automatica (`applyTemplateNow`:
   * deshacible, con aviso, con confirmacion si quitaria firmas, un nombre escrito o valores). Se aplica siempre, sea cual sea el
   * parecido: con `scope: "matching"` solo las paginas que coinciden (el resto queda en «Revisar»); con `"all"` todas por posicion,
   * y las paginas que la comparacion no avala quedan marcadas para revisar (`flaggedPages`). El documento de origen se compara
   * aqui con la huella de CADA documento pedido, asi que «todos los documentos» tambien se coloca pagina a pagina.
   */
  const applyChosen = useCallback(
    async (request: ManualRequest): Promise<ManualOutcome> => {
      const outcome: ManualOutcome = { applied: 0, blocked: 0, skipped: 0 };
      let basis: Awaited<ReturnType<typeof getDocument>> | null = null;
      try {
        basis = request.documentId ? await getDocument(request.documentId) : null;
      } catch {
        basis = null;
      }
      for (const docId of request.docIds) {
        const file = fileOf(docId);
        if (!file) {
          outcome.skipped += 1;
          continue;
        }
        try {
          let fingerprint = null;
          try {
            fingerprint = await fingerprintOfFile(file);
          } catch {
            // Un PDF que no se puede huellar (cifrado, dañado a medias) tambien se puede rellenar: se coloca por numero de pagina.
            fingerprint = null;
          }
          const pageCount = fingerprint ? fingerprint.pageCount : await pageCountOfFile(file);
          const raw = fingerprint && basis ? compareFingerprints(fingerprint, basisOf(basis)) : null;
          const planned = planManualMatch({ match: raw, scope: request.scope, docPageCount: pageCount });
          const lookup: TemplateLookup = {
            template: request.template,
            documentId: request.documentId,
            level: raw ? raw.level : "none",
            percent: raw ? raw.percent : 0,
            match: planned.match ? { ...planned.match } : null,
            pageCount,
            ...(planned.flaggedPages.length > 0 ? { flaggedPages: planned.flaggedPages } : {}),
          };
          patchNotice(docId, { busy: true });
          const result = await applyTemplateNow(file, lookup, request.count, true, request.allowLoss === true, true);
          patchNotice(docId, (current) => (current ? { busy: false } : null));
          if (result === "applied") outcome.applied += 1;
          else if (result === "blocked") outcome.blocked += 1;
          else outcome.skipped += 1;
        } catch {
          // Un documento que falla no impide aplicar al resto; la herramienta sigue como siempre.
          patchNotice(docId, (current) => (current ? { busy: false } : null));
          outcome.skipped += 1;
        }
      }
      return outcome;
    },
    [applyTemplateNow, fileOf, patchNotice],
  );

  const dismissLibraryOffer = useCallback((docId: DocId) => removeOffer(docId), [removeOffer]);

  const list = useMemo(() => Object.values(notices), [notices]);
  const offers = useMemo(() => Object.values(offerMap), [offerMap]);

  return useMemo(
    () => ({ notices: list, offers, dismissLibraryOffer, applyChosen, announcement, notify, undo, dismiss, setCount, confirmChange, cancelChange, acceptSimilar, declineSimilar, accept, acceptAll, detect, saveAsTemplate, dismissOffer, applySaved }),
    [list, offers, dismissLibraryOffer, applyChosen, announcement, notify, undo, dismiss, setCount, confirmChange, cancelChange, acceptSimilar, declineSimilar, accept, acceptAll, detect, saveAsTemplate, dismissOffer, applySaved],
  );
}
