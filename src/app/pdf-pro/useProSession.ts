"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useInputGuard } from "@/components/tool/InputGuardContext";
import { useI18n } from "@/lib/i18n";
import { addRecentEntry } from "@/lib/recent";
import type { ResumeOutcome } from "@/lib/useResumeLink";
import type { PdfErrorCode } from "@/lib/pdf/core";
import type { InputGuard } from "@/lib/pdf/inputGuard";
import type { ToolSlug } from "@/lib/tools-registry";
import { checkProInput, decryptProFile } from "@/app/pdf-pro/proAdapter";
import { takeHandoff } from "@/app/pdf-pro/proHandoff";
import {
  deleteProDraft,
  listProDrafts,
  loadProDraft,
  type ProDraftSummary,
} from "@/app/pdf-pro/proDrafts";
import { getProStrings } from "@/app/pdf-pro/proStrings";
import { useProWorkingDoc } from "@/app/pdf-pro/useProWorkingDoc";

/**
 * Sesion de la pagina `/pdf-pro` (Wave 7 · U1): de «un archivo elegido» a «documento abierto».
 * Reune lo que hace falta en la puerta de entrada y no es del documento de trabajo:
 *  - validacion con el MISMO `inputGuard` que el resto de herramientas (vacio, no PDF, danado) y hoja
 *    de contrasena para los cifrados (copia descifrada en memoria; la contrasena no se guarda);
 *  - el archivo que llega de otra herramienta (`takeHandoff`, una unica vez);
 *  - el borrador del mismo documento (por huella), para ofrecer retomarlo, y «Documentos recientes».
 */
export type ProIntakeState =
  | { phase: "idle" }
  | { phase: "checking"; file: File }
  | { phase: "password"; file: File; busy: boolean; wrong: boolean; failed: boolean; attempt: number }
  | { phase: "problem"; file: File | null; code: PdfErrorCode };

const NO_GUARD: InputGuard = async () => ({ status: "ok" });

export function useProSession() {
  const { language } = useI18n();
  const { doc, document } = useProWorkingDoc();
  const guard = useInputGuard();
  const [intake, setIntake] = useState<ProIntakeState>({ phase: "idle" });
  const [openedFrom, setOpenedFrom] = useState<ToolSlug | null>(null);
  /** Cuantos PDF habia en la herramienta de origen (solo se abrio el primero). */
  const [openedTotal, setOpenedTotal] = useState(1);
  const [draftOffer, setDraftOffer] = useState<ProDraftSummary | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState(false);
  const guardRef = useRef(guard);
  const languageRef = useRef(language);
  useEffect(() => {
    guardRef.current = guard;
    languageRef.current = language;
  });
  /** Para descartar la respuesta tardia de una apertura que otra ya reemplazo. */
  const attemptRef = useRef(0);
  const takenRef = useRef(false);
  /** Herramienta de origen del archivo que se esta abriendo (sobrevive a la hoja de contrasena). */
  const fromRef = useRef<ToolSlug | null>(null);
  const totalRef = useRef(1);

  const finishOpen = useCallback(
    async (file: File, from: ToolSlug | null, wasEncrypted: boolean, attempt: number) => {
      const result = await doc.open(file, { encrypted: wasEncrypted });
      if (attempt !== attemptRef.current) return;
      if (!result.ok) {
        if (result.code !== "cancelled") setIntake({ phase: "problem", file, code: result.code });
        return;
      }
      const fingerprint = result.document.fingerprint;
      // Con huella y sin contrasena el historial apunta al borrador (solo tipo e id): Recientes no lo repite aparte.
      addRecentEntry("pdf-pro", file.name, fingerprint && !wasEncrypted ? { kind: "pro", id: fingerprint } : undefined);
      setIntake({ phase: "idle" });
      setOpenedFrom(from);
      setOpenedTotal(from ? totalRef.current : 1);
      setDraftError(false);
      if (fingerprint && !wasEncrypted) {
        const drafts = await listProDrafts();
        if (attempt !== attemptRef.current) return;
        setDraftOffer(drafts.find((draft) => draft.id === fingerprint) ?? null);
      } else {
        setDraftOffer(null);
      }
    },
    [doc],
  );

  /** Abre un archivo (elegido, soltado o recibido de otra herramienta). */
  const openFile = useCallback(
    async (file: File, from: ToolSlug | null = null, total = 1) => {
      const attempt = ++attemptRef.current;
      fromRef.current = from;
      totalRef.current = total;
      setIntake({ phase: "checking", file });
      setDraftOffer(null);
      doc.announce(getProStrings(languageRef.current).empty.checking);
      const checked = await checkProInput(file, guardRef.current ?? NO_GUARD);
      if (attempt !== attemptRef.current) return;
      if (checked.status === "ready") {
        await finishOpen(checked.file, from, checked.wasEncrypted, attempt);
      } else if (checked.status === "password") {
        setIntake({ phase: "password", file: checked.file, busy: false, wrong: false, failed: false, attempt: 0 });
      } else {
        setIntake({ phase: "problem", file, code: checked.code });
      }
    },
    [doc, finishOpen],
  );

  /**
   * Abre un PDF que creo la propia aplicacion (nuevo en blanco, nuevo desde imagenes): no pasa por la comprobacion
   * de entrada (no hay nada que descifrar ni validar) y no se rotula como «Abierto desde...».
   */
  const openGenerated = useCallback(
    async (file: File) => {
      const attempt = ++attemptRef.current;
      fromRef.current = null;
      setDraftOffer(null);
      setDraftError(false);
      const result = await doc.open(file, { encrypted: false });
      if (attempt !== attemptRef.current) return;
      if (!result.ok) {
        if (result.code !== "cancelled") setIntake({ phase: "problem", file, code: result.code });
        return;
      }
      const fingerprint = result.document.fingerprint;
      addRecentEntry("pdf-pro", file.name, fingerprint ? { kind: "pro", id: fingerprint } : undefined);
      setIntake({ phase: "idle" });
      setOpenedFrom(null);
    },
    [doc],
  );

  const submitPassword = useCallback(
    async (password: string) => {
      if (intake.phase !== "password") return;
      const target = intake.file;
      const attempt = attemptRef.current;
      setIntake({ ...intake, busy: true, wrong: false, failed: false });
      const decrypted = await decryptProFile(target, password);
      if (attempt !== attemptRef.current) return;
      if (decrypted.status === "ready") {
        await finishOpen(decrypted.file, fromRef.current, true, attempt);
      } else if (decrypted.status === "unsupported") {
        setIntake({ phase: "problem", file: target, code: decrypted.code });
      } else {
        setIntake({
          phase: "password",
          file: target,
          busy: false,
          wrong: decrypted.status === "wrongPassword",
          failed: decrypted.status === "failed",
          attempt: intake.attempt + 1,
        });
      }
    },
    [finishOpen, intake],
  );

  const cancelPassword = useCallback(() => {
    attemptRef.current += 1;
    setIntake({ phase: "idle" });
  }, []);

  /** Un problema de la zona de carga (formato que no es PDF) que no llega a ser un archivo comprobado. */
  const reportProblem = useCallback((code: PdfErrorCode) => {
    if (code === "tooLarge") return; // avisa pero no bloquea: el archivo se abre igualmente
    setIntake({ phase: "problem", file: null, code });
  }, []);

  const dismissProblem = useCallback(() => {
    setIntake((previous) => (previous.phase === "problem" ? { phase: "idle" } : previous));
  }, []);

  /**
   * Abre un borrador guardado (desde «Documentos recientes», desde la oferta del documento o desde Recientes con
   * `?resume=pro:<id>`). Devuelve que paso: `gone` = ya no existe (se borro, caduco o estaba danado); `failed` = no se
   * pudo leer ahora. Con `quietGone` un `gone` no enciende el aviso de «no se pudo abrir» (lo cuenta quien llama).
   */
  const restoreDraft = useCallback(
    async (id: string, options: { quietGone?: boolean } = {}): Promise<ResumeOutcome> => {
      const attempt = ++attemptRef.current;
      setDraftBusy(true);
      setDraftError(false);
      const loaded = await loadProDraft(id);
      if (attempt !== attemptRef.current) return "restored";
      if (!loaded.ok) {
        const gone = loaded.reason === "notFound" || loaded.reason === "corrupt" || loaded.reason === "invalid";
        setDraftBusy(false);
        setDraftError(!(gone && options.quietGone));
        setDraftOffer(null);
        return gone ? "gone" : "failed";
      }
      const { meta, bytes, history } = loaded.draft;
      const file = new File([bytes as unknown as BlobPart], meta.fileName, {
        type: "application/pdf",
        lastModified: Date.parse(meta.savedAt) || Date.now(),
      });
      const result = await doc.open(file, {
        encrypted: false,
        fingerprint: meta.id,
        restored: { savedAt: meta.savedAt, history },
      });
      if (attempt !== attemptRef.current) return "restored";
      setDraftBusy(false);
      if (!result.ok) {
        setDraftError(true);
        return "failed";
      }
      addRecentEntry("pdf-pro", meta.fileName, { kind: "pro", id: meta.id });
      setOpenedFrom(null);
      setDraftOffer(null);
      return "restored";
    },
    [doc],
  );

  const discardDraft = useCallback(async () => {
    const offer = draftOffer;
    setDraftOffer(null);
    if (offer) await deleteProDraft(offer.id);
  }, [draftOffer]);

  /** Cierra el documento (el borrador, si hay cambios, se conserva para retomarlo). */
  const closeDocument = useCallback(() => {
    attemptRef.current += 1;
    doc.close();
    setOpenedFrom(null);
    setOpenedTotal(1);
    setDraftOffer(null);
    setIntake({ phase: "idle" });
  }, [doc]);

  // El archivo traido de otra herramienta se recoge UNA vez (el ref lo protege del doble efecto de StrictMode).
  useEffect(() => {
    if (takenRef.current) return;
    takenRef.current = true;
    const handoff = takeHandoff();
    // Fuera del cuerpo del efecto: la apertura actualiza estado y el efecto solo recoge el archivo.
    if (handoff) queueMicrotask(() => void openFile(handoff.file, handoff.from, handoff.total));
  }, [openFile]);

  return {
    document,
    intake,
    openedFrom,
    openedTotal,
    draftOffer,
    draftBusy,
    draftError,
    openFile,
    openGenerated,
    reportProblem,
    submitPassword,
    cancelPassword,
    dismissProblem,
    restoreDraft,
    discardDraft,
    closeDocument,
  };
}
