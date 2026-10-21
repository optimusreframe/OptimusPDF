"use client";

import { useEffect, useRef, useState } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import type { PdfErrorCode } from "@/lib/pdf/core";
import { EditNotices, type EditNotice } from "@/app/edit-pdf/EditNotices";
import { EditPrivacyNotice } from "@/app/edit-pdf/EditPrivacyNotice";
import { TrayPortal } from "@/components/tool/trayRouting";
import { EditWorkspace } from "@/app/edit-pdf/EditWorkspace";
import { PasswordSheet } from "@/app/edit-pdf/PasswordSheet";
import {
  getRememberedPage,
  setRememberedPage,
  type PrepareResult,
  type PreparedDocument,
} from "@/app/edit-pdf/editPrepare";
import type { EditFlowStrings } from "@/app/edit-pdf/flowStrings";
import type { EditStrings } from "@/app/edit-pdf/strings";
import { useEditDrafts } from "@/app/edit-pdf/useEditDrafts";
import { useEditPrepare } from "@/app/edit-pdf/useEditPrepare";
import type { Tool } from "@/app/edit-pdf/editTools";
import type { UseEditSession } from "@/app/edit-pdf/useEditSession";

/*
 * Puerta del documento del editor (Wave 5 · U5): antes de montar el lienzo
 * comprueba el archivo (cifrado, firmas digitales, formularios), pide la
 * contrasena si hace falta y busca un borrador del mismo PDF. Nada de esto es un
 * modal bloqueante salvo la contrasena (sin ella no hay documento): los demas
 * avisos son filas discretas sobre el lienzo.
 */

export type EditDocumentGateProps = {
  file: File;
  session: UseEditSession;
  strings: EditStrings;
  flow: EditFlowStrings;
  existingText: boolean;
  /** Publica un error en el banner del shell. */
  onError: (code: PdfErrorCode) => void;
  /** El documento esta listo (con su copia de trabajo) o ya no lo esta (`null`). */
  onPrepared: (document: PreparedDocument | null) => void;
  /** La persona renuncia a este documento (cancelar la contrasena, «otro archivo»). */
  onCancelFile: () => void;
  /** Inyectable para pruebas. */
  prepare?: (file: File, password?: string) => Promise<PrepareResult>;
};

function GateCard({
  children,
  busy,
}: {
  children: React.ReactNode;
  busy?: boolean;
}) {
  return (
    <div
      data-edit-gate=""
      className="surface-card rounded-ios-lg flex flex-col items-start gap-3 p-5"
      aria-busy={busy || undefined}
    >
      {children}
    </div>
  );
}

export function EditDocumentGate({
  file,
  session,
  strings,
  flow,
  existingText,
  onError,
  onPrepared,
  onCancelFile,
  prepare,
}: EditDocumentGateProps) {
  const { state, submitPassword } = useEditPrepare(file, prepare, onError);
  const [sheetOpen, setSheetOpen] = useState(true);
  const wasPassword = useRef(false);
  const openSheetButtonRef = useRef<HTMLButtonElement>(null);

  const preparedDocument = state.phase === "ready" ? state.document : null;
  useEffect(() => {
    onPrepared(preparedDocument);
    return () => onPrepared(null);
  }, [preparedDocument, onPrepared]);

  /* Tras abrir con contrasena la hoja se desmonta con su foco: pasa al lienzo, nunca a <body>. */
  useEffect(() => {
    if (state.phase === "password") {
      wasPassword.current = true;
      return;
    }
    if (state.phase !== "ready" || !wasPassword.current) return;
    wasPassword.current = false;
    const frame = window.requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      document
        .querySelector<HTMLElement>("[data-edit-workspace] button:not([disabled])")
        ?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [state.phase]);

  /* Cerrar la hoja con Esc: su disparador (la zona de carga) ya no existe; el foco pasa a la tarjeta, nunca a <body>. */
  const closeSheet = () => {
    setSheetOpen(false);
    let attempts = 0;
    const tryFocus = () => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const button = openSheetButtonRef.current;
      if (button?.isConnected) {
        button.focus({ preventScroll: true });
        if (document.activeElement === button) return;
      }
      attempts += 1;
      if (attempts < 30) window.setTimeout(tryFocus, 50);
    };
    window.setTimeout(tryFocus, 350);
  };

  if (state.phase === "checking") {
    return (
      <GateCard busy>
        <p role="status" className="flex items-center gap-2 text-subheadline text-muted-foreground">
          <Spinner className="size-4" />
          {flow.checking}
        </p>
      </GateCard>
    );
  }

  if (state.phase === "password") {
    return (
      <>
        <GateCard>
          <div className="flex items-center gap-2 text-headline text-foreground">
            <Lock aria-hidden="true" className="size-5 text-accent-edit" />
            <h2>{flow.passwordTitle}</h2>
          </div>
          <p className="text-subheadline text-muted-foreground">{flow.passwordBody}</p>
          <div className="flex flex-wrap gap-2">
            <Button ref={openSheetButtonRef} size="md" onClick={() => setSheetOpen(true)}>
              {flow.passwordOpenSheet}
            </Button>
            <Button size="md" variant="secondary" onClick={onCancelFile}>
              {flow.tryAnotherFile}
            </Button>
          </div>
        </GateCard>
        <PasswordSheet
          open={sheetOpen}
          onClose={closeSheet}
          onSubmit={submitPassword}
          onCancel={onCancelFile}
          busy={state.busy}
          wrong={state.wrong}
          failed={state.failed}
          attempt={state.attempt}
          flow={flow}
        />
      </>
    );
  }

  if (state.phase === "blocked") {
    return (
      <GateCard>
        <p role="status" className="text-subheadline text-foreground">
          {flow.cannotOpen}
        </p>
        <Button size="md" variant="secondary" onClick={onCancelFile}>
          {flow.tryAnotherFile}
        </Button>
      </GateCard>
    );
  }

  return (
    <ReadyEditor
      document={state.document}
      session={session}
      strings={strings}
      flow={flow}
      existingText={existingText}
      onError={onError}
      onCancelFile={onCancelFile}
    />
  );
}

/**
 * El editor con todo lo que lo rodea (avisos de cifrado, firmas y formularios, borradores, privacidad) sobre un
 * documento YA preparado. Lo usan la herramienta suelta (tras `EditDocumentGate`) y los modos Editar y Anotar de
 * PDF Pro (que ya tienen la copia sin cifrar y las firmas comprobadas): un solo componente, sin duplicar codigo.
 */
export type ReadyEditorProps = {
  document: PreparedDocument;
  session: UseEditSession;
  strings: EditStrings;
  flow: EditFlowStrings;
  existingText: boolean;
  onError: (code: PdfErrorCode) => void;
  onCancelFile: () => void;
  /** (W7-U6) Dentro de PDF Pro: ocupa la altura de su region, sin pie ni paginas de mas. */
  embedded?: boolean;
  /** (W7-U6) `annotate` = modo Anotar (paleta de anotacion, sin aplanar). */
  variant?: "edit" | "annotate";
  /** (W7-U6) Pagina (base 0) con la que arranca si no se restaura un borrador. */
  initialPage?: number;
  /** (W7-U6) Pagina visible y total (PDF Pro la recuerda para volver al visor). */
  onPageChange?: (page: number, count: number) => void;
  /** (W7-U6) El aviso de formularios es un enlace a otra pagina en la herramienta suelta; en PDF Pro no hay enlace. */
  hideFormLink?: boolean;
  /** (W7-U6) Avisos extra (p. ej. «el PDF supera 100 MB») que se suman a los del documento. */
  extraNotices?: EditNotice[];
  /** (W7-U6) El modo de PDF Pro recibe aqui como borrar el borrador al aplicar o descartar. */
  draftRef?: { current: { discard: () => Promise<void> } | null };
  /** (W7-U6) Herramienta que pide la paleta de comandos de PDF Pro («Añadir imagen»...). */
  toolRequest?: { tool: Tool; nonce: number } | null;
};

export function ReadyEditor({
  document,
  session,
  strings,
  flow,
  existingText,
  onError,
  onCancelFile,
  embedded = false,
  variant = "edit",
  initialPage,
  onPageChange,
  hideFormLink = false,
  extraNotices = [],
  draftRef,
  toolRequest,
}: ReadyEditorProps) {
  const [position, setPosition] = useState({ page: 0, count: 0 });
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [startedFresh, setStartedFresh] = useState(false);
  const drafts = useEditDrafts({
    file: document.file,
    // Un borrador de un PDF protegido guardaria su contenido sin el cifrado.
    enabled: !document.wasEncrypted,
    session,
    pageCount: position.count > 0 ? position.count : null,
    currentPage: position.page,
    fallbackPage: initialPage ?? getRememberedPage(document.file),
  });

  const discardDraft = drafts.discard;
  useEffect(() => {
    if (!draftRef) return;
    draftRef.current = { discard: discardDraft };
    return () => {
      draftRef.current = null;
    };
  }, [draftRef, discardDraft]);

  const dismiss = (id: string) => setDismissed((previous) => new Set(previous).add(id));

  const notices = (() => {
    const list: EditNotice[] = [...extraNotices];
    if (document.wasEncrypted) {
      list.push({ id: "protected", tone: "info", text: flow.protectedCopy });
    }
    if (document.signatures === "active") {
      list.push({ id: "signatures", tone: "warning", text: flow.signaturesActive });
    } else if (document.signatures === "unknown") {
      list.push({ id: "signatures", tone: "warning", text: flow.signaturesUnknown });
    }
    if (document.formFields > 0 && !dismissed.has("form")) {
      list.push({
        id: "form",
        tone: "info",
        text: flow.formNotice,
        ...(hideFormLink ? {} : { action: { label: flow.formLink, href: "/sign-pdf" } }),
        onDismiss: () => dismiss("form"),
      });
    }
    if (drafts.restored && !dismissed.has("restored")) {
      const { count, lost } = drafts.restored;
      list.push({
        id: "restored",
        tone: "info",
        text: lost > 0 ? `${flow.draftsRestored(count)} ${flow.draftsRestoredPartial(lost)}` : flow.draftsRestored(count),
        action: {
          label: flow.draftsStartFresh,
          onClick: () => {
            void drafts.startFresh().then(() => setStartedFresh(true));
          },
        },
        onDismiss: () => dismiss("restored"),
      });
    }
    if (startedFresh && !dismissed.has("fresh")) {
      list.push({
        id: "fresh",
        tone: "info",
        text: flow.draftsStartedFresh,
        onDismiss: () => dismiss("fresh"),
      });
    }
    if (drafts.saveFailure && !dismissed.has("save-failed")) {
      list.push({
        id: "save-failed",
        tone: "warning",
        text: drafts.saveFailure === "tooBig" ? flow.draftsTooBig : flow.draftsSaveFailed,
        onDismiss: () => dismiss("save-failed"),
      });
    }
    return list;
  })();

  return (
    <div className={embedded ? "flex h-full min-h-0 flex-col gap-2" : "space-y-3"} data-edit-ready="">
      <EditNotices notices={notices} dismissLabel={flow.dismiss} />
      {drafts.checked ? (
        <div className={embedded ? "min-h-0 flex-1" : undefined}>
          <EditWorkspace
            file={document.file}
            session={session}
            strings={strings}
            flow={flow}
            existingText={existingText}
            initialPage={drafts.initialPage}
            onChooseAnother={onCancelFile}
            flattenLoss={document.flattenLoss}
            embedded={embedded}
            variant={variant}
            toolRequest={toolRequest}
            onPageChange={(page, count) => {
              setRememberedPage(document.file, page);
              setPosition((previous) =>
                previous.page === page && previous.count === count ? previous : { page, count },
              );
              onPageChange?.(page, count);
            }}
            onError={onError}
          />
        </div>
      ) : (
        <GateCard busy>
          <p role="status" className="flex items-center gap-2 text-subheadline text-muted-foreground">
            <Spinner className="size-4" />
            {flow.checking}
          </p>
        </GateCard>
      )}
      <TrayPortal slot="privacy">
        <EditPrivacyNotice flow={flow} compact={embedded} />
      </TrayPortal>
    </div>
  );
}
