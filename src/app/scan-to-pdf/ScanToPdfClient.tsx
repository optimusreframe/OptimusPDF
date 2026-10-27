"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { useFocusTarget } from "@/components/tool/useFocusTarget";
import { useI18n } from "@/lib/i18n";
import { matchesAccept } from "@/lib/pdf/core";
import { DEFAULT_QUAD } from "@/lib/scan/perspective";
import { getTool } from "@/lib/tools-registry";
import type { ScanMode } from "@/lib/scan/types";
import { CameraScreen } from "@/app/scan-to-pdf/CameraScreen";
import { CornerEditor } from "@/app/scan-to-pdf/CornerEditor";
import { PageEditor, SheetViewer } from "@/app/scan-to-pdf/PageEditor";
import { ReviewScreen, type AddTarget } from "@/app/scan-to-pdf/ReviewScreen";
import { ResultScreen, SaveScreen, type ScanResult } from "@/app/scan-to-pdf/SaveScreen";
import { ScanLiveProvider, useAnnounce } from "@/app/scan-to-pdf/ScanLive";
import { StartScreen } from "@/app/scan-to-pdf/StartScreen";
import { rejectedFile } from "@/app/scan-to-pdf/importProblems";
import { preloadEngine } from "@/app/scan-to-pdf/scanServices";
import { readScanFromSearch, hideScanFromUrl } from "@/app/scan-to-pdf/scanUrl";
import { STRINGS } from "@/app/scan-to-pdf/strings";
import { useScanLeaveGuard } from "@/app/scan-to-pdf/useScanLeaveGuard";
import { useScanSession } from "@/app/scan-to-pdf/useScanSession";

const TOOL = getTool("scan-to-pdf");

type View = "start" | "review" | "save" | "done";
type CameraLayer = { target: AddTarget } | null;

/**
 * «Escanear a PDF» en tres momentos: ESCANEAR (camara a pantalla casi completa o fotos) -> REVISAR / ORGANIZAR (cuadricula) ->
 * GUARDAR (nombre, calidad, PDF). La sesion se guarda sola tras cada cambio; al volver se ofrece «Retomar escaneo».
 */
export function ScanToPdfClient() {
  return (
    <ScanLiveProvider>
      <ScanFlow />
    </ScanLiveProvider>
  );
}

function ScanFlow() {
  const { t, language } = useI18n();
  const s = STRINGS[language];
  const announce = useAnnounce();
  const api = useScanSession({ language, strings: s, announce });
  // Importar fotos tiene que funcionar aunque despues se pierda la red: el motor real se precarga al abrir la herramienta.
  useEffect(() => {
    preloadEngine();
  }, []);
  const [view, setView] = useState<View>("start");
  // Capas a pantalla completa: la camara, y el editor con la hoja completa y las esquinas ENCIMA de el (cerrar la de arriba devuelve
  // a la de debajo, con el foco en el control que la abrio).
  const [cameraLayer, setCameraLayer] = useState<CameraLayer>(null);
  const [editorId, setEditorId] = useState<string | null>(null);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [cornersId, setCornersId] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const libraryInputRef = useRef<HTMLInputElement>(null);
  const nativeInputRef = useRef<HTMLInputElement>(null);
  const libraryTarget = useRef<AddTarget>({ kind: "append" });
  const downloadRef = useRef<HTMLButtonElement>(null);
  /** Paginas que dejo la camara en esta apertura (para «Deshacer» la ultima) y donde va la siguiente al insertar. */
  const [lastShot, setLastShot] = useState<string[]>([]);
  const insertCursor = useRef(0);

  const pages = api.pages;
  const hasPages = pages.length > 0;

  /* ---------------- foco entre pasos ---------------- */
  const { request: askFocus } = useFocusTarget<"heading" | "download">((target) => {
    if (target === "download") return { candidates: [downloadRef.current] };
    return { candidates: [document.querySelector<HTMLElement>("[data-view-heading]")] };
  });

  const goto = useCallback(
    (next: View) => {
      // Un paso nuevo se ve desde arriba: la pagina no conserva el desplazamiento del paso anterior.
      window.scrollTo(0, 0);
      setView(next);
      askFocus(next === "done" ? "download" : "heading");
    },
    [askFocus],
  );

  /* ---------------- retomar (recarga, ?scan=, ?resume=scan:) ---------------- */
  const resumedFromUrl = useRef(false);
  const { resume } = api;
  useEffect(() => {
    if (resumedFromUrl.current) return;
    resumedFromUrl.current = true;
    const read = readScanFromSearch(window.location.search);
    if (!read.present) return;
    if (!read.id) {
      hideScanFromUrl();
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- la restauracion de la URL es un efecto externo de este montaje
    setResuming(true);
    void resume(read.id).then((ok) => {
      setResuming(false);
      if (ok) {
        setView("review");
      } else {
        hideScanFromUrl();
        setResumeNotice(s.resumeGone);
      }
    });
    // Solo una vez al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onResume = useCallback(
    async (id: string) => {
      setResuming(true);
      const ok = await resume(id);
      setResuming(false);
      if (ok) goto("review");
      else {
        setResumeNotice(s.resumeFailed);
        void api.refreshSaved();
      }
    },
    [resume, goto, s, api],
  );

  /* ---------------- guarda de salida ---------------- */
  const leave = useScanLeaveGuard(
    hasPages && view !== "done" ? { progress: true, sessionId: api.state.id, saved: api.saveStatus === "saved" || api.saveStatus === "idle" || api.saveStatus === "saving", pages: pages.length } : null,
    api.hasPendingWrite,
  );

  /* ---------------- altas ---------------- */
  const acceptFiles = useCallback(
    (list: FileList | File[] | null): File[] => {
      const files = Array.from(list ?? []);
      const accepted = files.filter((file) => matchesAccept(file, TOOL.accept, TOOL.extensions));
      if (accepted.length < files.length) api.reportImportProblems(files.filter((file) => !accepted.includes(file)).map(rejectedFile));
      return accepted;
    },
    [api],
  );

  const addLibrary = useCallback(
    (files: File[], target: AddTarget) => {
      if (files.length === 0) return;
      if (target.kind === "retake") {
        api.retake(target.id, files[0], "library");
        announce(s.said.retaken(api.pages.findIndex((page) => page.id === target.id) + 1));
        return;
      }
      const at = target.kind === "insert" ? target.at : undefined;
      api.addBlobs(files, { source: "library", at });
      announce(target.kind === "insert" ? s.said.inserted((at ?? 0) + 1) : s.said.added(files.length));
    },
    [api, announce, s],
  );

  const pickPhotos = useCallback((target: AddTarget) => {
    libraryTarget.current = target;
    libraryInputRef.current?.click();
  }, []);

  const onLibraryChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = acceptFiles(event.target.files);
    event.target.value = "";
    const target = libraryTarget.current;
    addLibrary(files, target);
    if (files.length > 0 && view === "start") goto("review");
    libraryTarget.current = { kind: "append" };
  };

  const onNativeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = acceptFiles(event.target.files);
    event.target.value = "";
    if (files.length === 0) return;
    api.addBlobs(files, { source: "camera" });
    announce(s.said.added(files.length));
    goto("review");
  };

  /* ---------------- camara ---------------- */
  const openCamera = useCallback(
    (target: AddTarget) => {
      setLastShot([]);
      insertCursor.current = target.kind === "insert" ? target.at : 0;
      setCameraLayer({ target });
    },
    [],
  );

  const closeCamera = useCallback(
    (to: View) => {
      setCameraLayer(null);
      setLastShot([]);
      goto(to === "review" && api.stateRef.current.pages.length === 0 ? "start" : to);
    },
    [api.stateRef, goto],
  );

  const onCapture = useCallback(
    async (blob: Blob) => {
      const target = cameraLayer ? cameraLayer.target : { kind: "append" as const };
      if (target.kind === "retake") {
        api.retake(target.id, blob, "camera");
        announce(s.said.retaken(api.stateRef.current.pages.findIndex((page) => page.id === target.id) + 1));
        return { kind: "pages" as const, ids: [target.id] };
      }
      const at = target.kind === "insert" ? insertCursor.current : undefined;
      const outcome = await api.addCapture(blob, { at });
      if (outcome.kind === "id-front") {
        announce(s.idBack);
        return outcome;
      }
      const added = outcome.kind === "pages" ? outcome.ids : [outcome.id];
      setLastShot(added);
      if (target.kind === "insert") insertCursor.current += added.length;
      const position = api.stateRef.current.pages.findIndex((page) => page.id === added[added.length - 1]) + 1;
      announce(outcome.kind === "id-done" ? s.idDone : s.said.captured(position));
      return outcome;
    },
    [cameraLayer, api, announce, s],
  );

  const onUndoLast = useCallback(() => {
    if (lastShot.length === 0) return;
    api.removeIds(lastShot, true);
    setLastShot([]);
    announce(s.undoLastDone);
  }, [api, announce, s, lastShot]);

  const lastId = lastShot[lastShot.length - 1];
  const lastIndex = lastId ? pages.findIndex((page) => page.id === lastId) : -1;
  const lastPage = lastIndex >= 0 ? pages[lastIndex] : null;
  const closeAfterCapture = cameraLayer?.target.kind === "retake";

  /* ---------------- editor ---------------- */
  const openEditor = useCallback((id: string) => setEditorId(id), []);
  const closeEditor = useCallback(() => setEditorId(null), []);

  const onSettingsMode = useCallback(
    (mode: ScanMode) => {
      api.setSettings({ mode });
      api.cancelIdFlow();
    },
    [api],
  );

  const targetLabel = cameraLayer
    ? cameraLayer.target.kind === "retake"
      ? s.retake + ` · ${pages.findIndex((page) => page.id === (cameraLayer.target as { id: string }).id) + 1}`
      : cameraLayer.target.kind === "insert"
        ? s.insertSourceTitle + ` · ${cameraLayer.target.at + 1}`
        : null
    : null;

  const idSide = api.settings.mode === "id-card" ? (api.idPending ? "back" : "front") : null;

  // Cerrar un paso pone el foco en su encabezado; mientras dura un paso, la vista de fondo sigue donde estaba.
  const editorPage = editorId ? (pages.find((page) => page.id === editorId) ?? null) : null;
  const sheetPage = sheetId ? (pages.find((page) => page.id === sheetId) ?? null) : null;
  const cornersPage = cornersId ? (pages.find((page) => page.id === cornersId) ?? null) : null;

  const fallbackName = language === "es" ? "Escaneo" : "Scan";
  const closeLabel = t.common.close;

  return (
    <>
      {view === "start" ? (
        <StartScreen
          s={s}
          mode={api.settings.mode}
          onMode={onSettingsMode}
          saved={api.saved}
          resumeNotice={resumeNotice}
          importProblems={api.importProblems}
          onDismissProblems={api.dismissImportProblems}
          resuming={resuming}
          onResume={(id) => void onResume(id)}
          onDiscardSaved={(id) => {
            void api.discardSaved(id);
            askFocus("heading");
          }}
          onCamera={() => openCamera({ kind: "append" })}
          onPhotos={() => pickPhotos({ kind: "append" })}
          onNative={() => nativeInputRef.current?.click()}
          closeLabel={closeLabel}
        />
      ) : null}

      {view === "review" ? (
        <>
          <h1 className="sr-only">{t.tools["scan-to-pdf"].name}</h1>
          <ReviewScreen
            s={s}
            api={api}
            closeLabel={closeLabel}
            onCamera={openCamera}
            onPhotos={pickPhotos}
            onEdit={openEditor}
            onCorners={(id) => setCornersId(id)}
            onViewSheet={(id) => setSheetId(id)}
            onSave={() => goto("save")}
          />
        </>
      ) : null}

      {view === "save" ? (
        <>
          <h1 className="sr-only">{t.tools["scan-to-pdf"].name}</h1>
          <SaveScreen
            s={s}
            api={api}
            fallbackName={fallbackName}
            onBack={() => goto("review")}
            onBuilt={(built) => {
              setResult(built);
              goto("done");
            }}
          />
        </>
      ) : null}

      {view === "done" && result ? (
        <>
          <h1 className="sr-only">{t.tools["scan-to-pdf"].name}</h1>
          <ResultScreen
            s={s}
            result={result}
            downloadRef={downloadRef}
            onBackToReview={() => goto("review")}
            onNewScan={() => {
              void api.startOver();
              setResult(null);
              setCameraLayer(null);
              setEditorId(null);
              setSheetId(null);
              setCornersId(null);
              goto("start");
              void api.refreshSaved();
            }}
          />
        </>
      ) : null}

      {cameraLayer ? (
        <CameraScreen
          s={s}
          settings={api.settings}
          onSettings={api.setSettings}
          pageCount={pages.length}
          lastThumb={lastPage ? (lastPage.thumb ?? lastPage.original) : null}
          lastNumber={lastIndex + 1}
          canUndoLast={lastPage !== null}
          idSide={idSide}
          target={targetLabel}
          onCapture={onCapture}
          onUndoLast={onUndoLast}
          onImport={(files) => {
            const accepted = acceptFiles(files);
            addLibrary(accepted, cameraLayer.target.kind === "retake" ? cameraLayer.target : cameraLayer.target.kind === "insert" ? { kind: "insert", at: insertCursor.current } : { kind: "append" });
            if (cameraLayer.target.kind === "insert") insertCursor.current += accepted.length;
            if (cameraLayer.target.kind === "retake") closeCamera("review");
          }}
          onDone={() => closeCamera("review")}
          onClose={() => closeCamera("review")}
          closeAfterCapture={closeAfterCapture}
          onModeChange={onSettingsMode}
        />
      ) : null}

      {editorPage ? (
        <PageEditor
          s={s}
          pages={pages}
          pageId={editorPage.id}
          isFresh={api.isFullFresh}
          onNeedFull={api.ensureFull}
          onSelect={(id) => setEditorId(id)}
          onClose={closeEditor}
          onRotate={(id) => api.rotateIds([id], 90, `rotate:${id}`)}
          onFilter={(id, filter) => api.applyFilter([id], filter)}
          onAdjust={(id, brightness, contrast) => api.applyAdjust([id], brightness, contrast)}
          onCrop={(id) => setCornersId(id)}
          onRetake={(id) => {
            setEditorId(null);
            openCamera({ kind: "retake", id });
          }}
          onViewSheet={(id) => setSheetId(id)}
          onApplyAll={api.applyToAll}
        />
      ) : null}

      {sheetPage ? (
        <SheetViewer
          s={s}
          pages={pages}
          pageId={sheetPage.id}
          onNeedFull={api.ensureFull}
          onSelect={(id) => setSheetId(id)}
          onClose={() => setSheetId(null)}
          onEdit={(id) => {
            setSheetId(null);
            setEditorId(id);
          }}
        />
      ) : null}

      {cornersPage ? (
        <CornerEditor
          source={cornersPage.original}
          corners={cornersPage.corners ?? DEFAULT_QUAD}
          onCancel={() => setCornersId(null)}
          onConfirm={(corners) => {
            api.applyCorners(cornersPage.id, corners);
            setCornersId(null);
          }}
        />
      ) : null}

      <input
        ref={libraryInputRef}
        type="file"
        accept="image/*"
        multiple
        aria-label={s.inputFiles}
        aria-hidden="true"
        tabIndex={-1}
        className="sr-only"
        data-scan-input="library"
        onChange={onLibraryChange}
      />
      <input
        ref={nativeInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        aria-label={s.inputCamera}
        aria-hidden="true"
        tabIndex={-1}
        className="sr-only"
        data-scan-input="native"
        onChange={onNativeChange}
      />

      <Sheet open={leave.open} onClose={leave.onStay} title={s.leaveTitle} closeLabel={closeLabel} initialFocus="[data-leave-stay]" inertBackground>
        <p className="pb-4 text-subheadline text-muted-foreground" data-leave-reason={leave.saved ? "saved" : "unsaved"}>
          {leave.saved ? s.leaveBodySaved(leave.pages) : s.leaveBodyUnsaved(leave.pages)}
        </p>
        <div className="flex flex-col gap-2 pb-2">
          <Button size="md" fullWidth data-leave-stay="" onClick={leave.onStay}>
            {s.leaveStay}
          </Button>
          <Button variant="secondary" size="md" fullWidth onClick={leave.onLeave}>
            {s.leaveLeave}
          </Button>
        </div>
      </Sheet>
    </>
  );
}
