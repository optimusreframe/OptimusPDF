"use client";

import { useMemo, useRef, useState } from "react";
import { FilePlus2, FolderOpen, ShieldCheck, TriangleAlert } from "lucide-react";
import { addDocument, deleteDoc, keepTemplate, renameDoc, replaceDoc } from "@/app/documents/documentActions";
import { DocumentCard } from "@/app/documents/DocumentCard";
import { ExportBackupSheet } from "@/app/documents/ExportBackupSheet";
import { ImportBackupSheet } from "@/app/documents/ImportBackupSheet";
import { AddDocumentSheet, DocumentMenuSheet, RenameSheet } from "@/app/documents/DocumentSheets";
import { MAX_SELECTION, pruneSelection, toggleSelection, type ErrorKey } from "@/app/documents/documentsModel";
import { StoragePanel } from "@/app/documents/StoragePanel";
import { useDocumentLibrary } from "@/app/documents/useDocumentLibrary";
import { useOpenInSign } from "@/app/documents/useOpenInSign";
import { Button } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { readLastBackup } from "@/lib/backup/lastBackup";
import { requestPersistence } from "@/lib/docLibrary/store";
import type { DocumentEntry } from "@/lib/docLibrary/types";
import { useT } from "@/lib/i18n";

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/**
 * «Mis documentos» (U2.5), pagina completa `/documents`: los contratos guardados en este navegador con el estado de su
 * plantilla (✓ lista / ✓ de 1 firmante / ✗ sin plantilla), «Firmar», «Configurar plantilla», un menu (renombrar,
 * reemplazar PDF, borrar), seleccion multiple (hasta 10), almacenamiento persistente y un aviso de privacidad.
 * Firmar recoge los ids por el traspaso `signHandoff` (otra unidad). Se refresca en vivo con `subscribeToLibrary`.
 */
export function MyDocumentsView() {
  const t = useT();
  const library = useDocumentLibrary({ withUsage: true });
  const openInSign = useOpenInSign();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const replaceTargetRef = useRef<string | null>(null);
  const moreRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const deletingRef = useRef(false);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [warning, setWarning] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [backupSheet, setBackupSheet] = useState<"export" | "import" | null>(null);
  // El panel de almacenamiento solo se pinta cuando la biblioteca ya cargó (en el navegador): leer aquí no desajusta la hidratación.
  const [lastBackup, setLastBackup] = useState<Date | null>(() => (typeof window === "undefined" ? null : readLastBackup()));

  const { documents, statuses, loaded, available, usage, meta, refresh } = library;
  const byId = useMemo(() => new Map(documents.map((doc) => [doc.id, doc])), [documents]);
  const selectedIds = useMemo(() => pruneSelection(selected, documents), [selected, documents]);
  const menuDoc = menuId ? (byId.get(menuId) ?? null) : null;
  const renameTarget = renameId ? (byId.get(renameId) ?? null) : null;
  const deleteTarget = deleteId ? (byId.get(deleteId) ?? null) : null;
  const say = (message: string) => setAnnouncement(message);
  /** Las hojas de renombrar / borrar se abren desde el menu (ya cerrado): al cerrarse devuelven el foco al boton del menu. */
  const focusMore = (id: string | null) => {
    if (id) window.setTimeout(() => moreRefs.current.get(id)?.focus({ preventScroll: true }), 0);
  };
  const errorText = (key: ErrorKey) => t.documents[key];

  async function handleAdd(input: { file: File; name: string; docType: string }): Promise<ErrorKey | null> {
    const result = await addDocument(input, documents.length);
    if (!result.ok) return result.error;
    await refresh();
    say(fill(t.documents.announceAdded, { name: result.value.name }));
    return null;
  }

  async function handleRename(name: string): Promise<ErrorKey | null> {
    if (!renameTarget) return "errorNotFound";
    const result = await renameDoc(renameTarget, name);
    if (!result.ok) {
      await refresh();
      return result.error;
    }
    await refresh();
    say(fill(t.documents.announceRenamed, { name: result.value.name }));
    return null;
  }

  async function handleReplace(file: File) {
    const target = replaceTargetRef.current ? byId.get(replaceTargetRef.current) : undefined;
    replaceTargetRef.current = null;
    if (!target) return;
    const status = statuses.get(target.id);
    const result = await replaceDoc(target, file, Boolean(status?.templateId));
    await refresh();
    focusMore(target.id);
    if (!result.ok) {
      setWarning(errorText(result.error));
      say(errorText(result.error));
      return;
    }
    const { verdict, entry } = result.value;
    if (verdict.kind === "mismatch") {
      const text = fill(t.documents.replacedMismatch, { name: entry.name });
      setWarning(text);
      say(text);
    } else if (verdict.kind === "review") {
      const text = fill(t.documents.replacedReview, { name: entry.name, n: String(verdict.pages) });
      setWarning(text);
      say(text);
    } else {
      setWarning("");
      say(fill(t.documents.announceReplaced, { name: entry.name }));
    }
  }

  async function handleKeepTemplate(doc: DocumentEntry) {
    const result = await keepTemplate(doc);
    await refresh();
    if (!result.ok) {
      setWarning(errorText(result.error));
      say(errorText(result.error));
      return;
    }
    setWarning("");
    say(fill(t.documents.announceKept, { name: doc.name }));
  }

  async function handleDelete() {
    const target = deleteTarget;
    if (!target) return;
    deletingRef.current = true;
    const result = await deleteDoc(target);
    await refresh();
    deletingRef.current = false;
    if (!result.ok) {
      setWarning(errorText(result.error));
      say(errorText(result.error));
      return;
    }
    setSelected((previous) => {
      const next = new Set(previous);
      next.delete(target.id);
      return next;
    });
    say(fill(t.documents.announceDeleted, { name: target.name }));
    headingRef.current?.focus({ preventScroll: true });
  }

  async function handlePersistence() {
    setRequesting(true);
    const state = await requestPersistence();
    await refresh();
    setRequesting(false);
    say(state.granted ? t.documents.announcePersistGranted : t.documents.announcePersistDenied);
  }

  const showEmpty = loaded && available && documents.length === 0;
  const full = selectedIds.length >= MAX_SELECTION;

  return (
    <div className="mx-auto max-w-[1000px] px-4 pt-10 pb-16 md:px-6 md:pt-16">
      <header className="mb-6">
        <h1 ref={headingRef} tabIndex={-1} className="text-title-1 text-foreground outline-none">
          {t.documents.title}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t.documents.subtitle}</p>
        <p className="mt-2 flex items-start gap-2 text-footnote text-muted-foreground" data-documents-privacy="">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success-text" />
          <span className="min-w-0">{t.documents.privacy}</span>
        </p>
      </header>

      {/* Una sola region viva para toda la pagina. */}
      <p role="status" aria-live="polite" className="sr-only" data-documents-live="">
        {announcement}
      </p>

      {warning ? (
        <p
          data-documents-warning=""
          className="mb-4 flex items-start gap-2 rounded-ios-sm border border-accent-edit/40 bg-accent-edit/10 p-3 text-subheadline text-foreground"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-edit" />
          <span className="min-w-0">{warning}</span>
        </p>
      ) : null}

      {!loaded ? (
        <p className="text-subheadline text-muted-foreground" data-documents-loading="">
          {t.documents.loading}
        </p>
      ) : null}

      {loaded && !available ? (
        <section data-documents-unavailable="" className="surface-card flex flex-col items-start rounded-ios p-5">
          <h2 className="text-title-3 text-foreground">{t.documents.unavailableTitle}</h2>
          <p className="mt-2 text-subheadline text-muted-foreground">{t.documents.unavailableBody}</p>
        </section>
      ) : null}

      {showEmpty ? (
        <section data-documents-empty="" className="surface-card flex flex-col items-center rounded-ios px-6 py-12 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-white/6">
            <FolderOpen aria-hidden="true" className="size-5 text-muted-foreground" />
          </span>
          <h2 className="mt-4 max-w-md text-title-3 text-foreground">{t.documents.emptyTitle}</h2>
          <p className="mt-2 max-w-md text-subheadline text-muted-foreground">{t.documents.emptyBody}</p>
          <Button size="md" wrap className="mt-6" onClick={() => setAddOpen(true)}>
            <FilePlus2 aria-hidden="true" className="size-4 shrink-0" />
            {t.documents.add}
          </Button>
        </section>
      ) : null}

      {loaded && available && documents.length > 0 ? (
        <section aria-labelledby="documents-list-title">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 id="documents-list-title" className="text-title-3 text-foreground">
              {t.documents.listLabel}
            </h2>
            <Button size="md" variant="secondary" wrap onClick={() => setAddOpen(true)}>
              <FilePlus2 aria-hidden="true" className="size-4 shrink-0" />
              {t.documents.add}
            </Button>
          </div>
          <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2" data-documents-list="">
            {documents.map((doc) => {
              const isSelected = selectedIds.includes(doc.id);
              return (
                <DocumentCard
                  key={doc.id}
                  doc={doc}
                  status={statuses.get(doc.id)}
                  selected={isSelected}
                  selectDisabled={!isSelected && full}
                  onToggle={() => setSelected((previous) => toggleSelection(previous, doc.id))}
                  onSign={() => openInSign([doc.id], "sign")}
                  onConfigure={() => openInSign([doc.id], "configure")}
                  onKeepTemplate={() => void handleKeepTemplate(doc)}
                  onMore={() => setMenuId(doc.id)}
                  moreRef={(element) => {
                    moreRefs.current.set(doc.id, element);
                  }}
                />
              );
            })}
          </ul>
        </section>
      ) : null}

      {selectedIds.length > 0 ? (
        <div
          data-documents-selection=""
          className="sticky bottom-[5.5rem] z-30 mt-4 flex flex-wrap items-center gap-2 rounded-ios border border-hairline-strong bg-elevated p-3 shadow-elevation-3 md:bottom-4"
        >
          <p className="mr-auto min-w-0 text-subheadline font-medium text-foreground">
            {selectedIds.length === 1 ? t.documents.selectedOne : fill(t.documents.selectedCount, { n: String(selectedIds.length) })}
            {full ? <span className="block text-footnote font-normal text-muted-foreground">{fill(t.documents.selectionMax, { max: String(MAX_SELECTION) })}</span> : null}
          </p>
          <Button variant="ghost" size="md" wrap onClick={() => setSelected(new Set())}>
            {t.documents.clearSelection}
          </Button>
          <Button size="md" wrap onClick={() => openInSign(selectedIds, "sign")}>
            {fill(t.documents.signSelected, { n: String(selectedIds.length) })}
          </Button>
        </div>
      ) : null}

      {loaded && available ? (
        <StoragePanel
          usage={usage}
          meta={meta}
          onRequestPersistence={() => void handlePersistence()}
          requesting={requesting}
          lastBackup={lastBackup}
          onExport={() => setBackupSheet("export")}
          onImport={() => setBackupSheet("import")}
        />
      ) : null}

      <input
        ref={replaceInputRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        aria-hidden="true"
        tabIndex={-1}
        data-replace-input=""
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void handleReplace(file);
          else replaceTargetRef.current = null;
        }}
      />

      <ExportBackupSheet
        open={backupSheet === "export"}
        onClose={() => {
          setLastBackup(readLastBackup());
          setBackupSheet(null);
        }}
        onDone={(message) => {
          setLastBackup(readLastBackup());
          say(message);
        }}
      />
      <ImportBackupSheet
        open={backupSheet === "import"}
        onClose={() => setBackupSheet(null)}
        onDone={(message) => {
          void refresh();
          say(message);
        }}
      />

      <AddDocumentSheet open={addOpen} onClose={() => setAddOpen(false)} onSave={handleAdd} />

      <DocumentMenuSheet
        name={menuDoc?.name ?? ""}
        open={menuDoc !== null}
        onClose={() => setMenuId(null)}
        onRename={() => {
          setRenameId(menuId);
          setMenuId(null);
        }}
        onReplace={() => {
          replaceTargetRef.current = menuId;
          setMenuId(null);
          replaceInputRef.current?.click();
        }}
        onDelete={() => {
          setDeleteId(menuId);
          setMenuId(null);
        }}
      />

      <RenameSheet
        open={renameTarget !== null}
        initialName={renameTarget?.name ?? ""}
        onClose={() => {
          focusMore(renameId);
          setRenameId(null);
        }}
        onSave={handleRename}
      />

      <ConfirmSheet
        open={deleteTarget !== null}
        onClose={() => {
          // «Cancelar»/cerrar devuelve el foco al menu de la tarjeta; «Borrar» lo lleva al titulo (la tarjeta ya no esta).
          if (!deletingRef.current) focusMore(deleteId);
          setDeleteId(null);
        }}
        onConfirm={() => void handleDelete()}
        // La tarjeta desaparece: el foco no vuelve a su boton (lo coloca `handleDelete`).
        restoreFocusOnClose={() => false}
        title={fill(t.documents.deleteTitle, { name: deleteTarget?.name ?? "" })}
        body={t.documents.deleteBody}
        confirmLabel={t.documents.deleteConfirm}
        cancelLabel={t.common.cancel}
        closeLabel={t.common.close}
      />
    </div>
  );
}
