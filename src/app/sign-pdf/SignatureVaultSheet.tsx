"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { FileUp, Pencil, SaveCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { Sheet } from "@/components/ui/Sheet";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";
import { localeTag, useI18n } from "@/lib/i18n";
import { downloadBlob } from "@/lib/pdf/core";
import {
  clearVault,
  deleteVaultEntry,
  normalizeSignerKey,
  saveVaultEntry,
  updateVaultEntry,
  vaultImageToDataUrl,
  type VaultEntry,
  type VaultImage,
} from "@/app/sign-pdf/signVault";
import {
  encryptionAvailable,
  exportVaultEntry,
  importVaultFile,
} from "@/app/sign-pdf/signVaultFile";
import type { SignStrings } from "@/app/sign-pdf/strings";
import { useSignatureVault } from "@/app/sign-pdf/useSignatureVault";
import {
  importReasonMessage,
  saveResultMessage,
} from "@/app/sign-pdf/vaultMessages";

/** Con puntero grueso el boton `sm` mide 44 px de verdad (mismo patron que `DocumentCanvas`). */
const COARSE_TALL = "pointer-coarse:h-11 pointer-coarse:before:hidden";

const INPUT_CLASS =
  "h-11 w-full rounded-ios-sm border border-white/14 bg-white/5 px-3 text-sm text-foreground transition-colors placeholder:text-muted-foreground/60 disabled:opacity-50 focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal";

/**
 * Boton solo-icono: caja de toque de 44 px y burbuja visible de 32. Sin
 * `outline-none` (en Tailwind v4 dejaria el anillo de foco invisible).
 * `scale` va en la lista de `transition-[…]`: `active:scale-*` compila a la
 * propiedad individual `scale`, no a `transform`.
 */
const ICON_BUTTON =
  "group flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-signal disabled:pointer-events-none disabled:opacity-50";
const ICON_BUBBLE =
  "flex size-8 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)] group-hover:bg-white/10 group-hover:text-foreground group-active:scale-90 group-active:duration-[80ms]";

type Notice = { text: string; tone: "ok" | "error" };

export type SignatureVaultSheetProps = {
  open: boolean;
  onClose: () => void;
  strings: SignStrings;
  /**
   * Que imagen hace falta ("Solo yo" y huecos de firma: la firma; huecos de
   * iniciales: las iniciales). Las entradas que no la tienen se listan (se
   * pueden editar o borrar) pero no ofrecen "Usar".
   */
  need?: "signature" | "initials";
  /** Nombre del firmante al que se va a aplicar: sus entradas salen primero. */
  preferSignerName?: string;
  /**
   * Elegir una entrada. Sin esto el sheet es solo de gestion. Con
   * `offerApplyAll`, el segundo argumento dice si se marco «Aplicar a todos mis
   * bloques»; sin el, no se pasa.
   */
  onUse?: (entry: VaultEntry, options?: { applyToAll: boolean }) => void;
  /** "Crear una firma nueva" ("Solo yo"): abre el compositor. */
  onCreateNew?: () => void;
  /**
   * Ceremonia por bloques (varios documentos): ofrece la casilla «Aplicar a
   * todos mis bloques» (rellena solo los bloques vacios del firmante).
   */
  offerApplyAll?: boolean;
};

/**
 * Baul de firmas guardadas en este dispositivo (IndexedDB, nunca se sube):
 * lista con miniatura, usar, editar nombre/cargo, borrar una o todas, y un
 * exportar/importar DISCRETO (solo iconos, con `aria-label` y `title`
 * neutros). Se suscribe al baul, asi que refleja los cambios de otra pestaña.
 */
export function SignatureVaultSheet({
  open,
  onClose,
  strings,
  need,
  preferSignerName,
  onUse,
  onCreateNew,
  offerApplyAll = false,
}: SignatureVaultSheetProps) {
  const { t, language } = useI18n();
  /** Casilla «Aplicar a todos mis bloques»: nace desmarcada en cada apertura. */
  const [applyAll, setApplyAll] = useState(false);
  const handleUse = onUse
    ? (entry: VaultEntry) => {
        const applyToAll = offerApplyAll && applyAll;
        setApplyAll(false);
        if (offerApplyAll) onUse(entry, { applyToAll });
        else onUse(entry);
      }
    : undefined;
  const handleClose = () => {
    setApplyAll(false);
    onClose();
  };
  const { status, entries } = useSignatureVault(open);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmAllOpen, setConfirmAllOpen] = useState(false);
  const [exportId, setExportId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  /** Elemento a enfocar tras el proximo render (el que lo tenia ya no existe o cambio de sitio). */
  const pendingFocusRef = useRef<string | null>(null);

  useEffect(() => {
    const target = pendingFocusRef.current;
    if (!target) return;
    pendingFocusRef.current = null;
    if (target === "list") {
      listRef.current?.focus({ preventScroll: true });
      return;
    }
    document
      .querySelector<HTMLElement>(`[data-vault-focus="${target}"]`)
      ?.focus({ preventScroll: true });
  });

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(localeTag(language), { dateStyle: "medium" }),
    [language],
  );

  // Las del firmante pedido primero; dentro de cada grupo se conserva el orden (lo ultimo usado antes).
  const preferredKey = preferSignerName
    ? normalizeSignerKey(preferSignerName)
    : "";
  const sorted = useMemo(() => {
    if (!preferredKey) return entries;
    return [
      ...entries.filter((entry) => entry.signerKey === preferredKey),
      ...entries.filter((entry) => entry.signerKey !== preferredKey),
    ];
  }, [entries, preferredKey]);

  const exportEntry = entries.find((entry) => entry.id === exportId) ?? null;

  const showNotice = (text: string, tone: Notice["tone"] = "ok") =>
    setNotice({ text, tone });

  const handleDelete = async (entry: VaultEntry) => {
    const result = await deleteVaultEntry(entry.id);
    pendingFocusRef.current = "list";
    showNotice(
      result.ok ? strings.vaultDeleted : strings.vaultOpFailed,
      result.ok ? "ok" : "error",
    );
  };

  const handleDeleteAll = async () => {
    const result = await clearVault();
    pendingFocusRef.current = "list";
    showNotice(
      result.ok ? strings.vaultDeletedAll : strings.vaultOpFailed,
      result.ok ? "ok" : "error",
    );
  };

  /** Guarda lo importado en el baul y cuenta que paso. */
  const finishImport = async (
    entry: Parameters<typeof saveVaultEntry>[0],
  ): Promise<void> => {
    const saved = await saveVaultEntry(entry);
    if (saved.ok) {
      showNotice(
        saved.duplicate
          ? strings.vaultImportedDuplicate(saved.entry.signerName)
          : strings.vaultImported(saved.entry.signerName),
      );
    } else {
      showNotice(saveResultMessage(strings, saved), "error");
    }
  };

  const handleImportFile = async (file: File) => {
    setImportBusy(true);
    setNotice(null);
    try {
      const result = await importVaultFile(file);
      if (result.ok) {
        await finishImport(result.entry);
      } else if (result.reason === "needsPassword") {
        setPendingFile(file);
        setPasswordOpen(true);
      } else {
        showNotice(importReasonMessage(strings, result.reason), "error");
      }
    } finally {
      setImportBusy(false);
    }
  };

  const showToolbar = status === "ready" || status === "loading";

  return (
    <Sheet
      open={open}
      onClose={handleClose}
      title={strings.vaultTitle}
      closeLabel={t.common.close}
    >
      <div className="space-y-4 pb-2">
        <p className="text-subheadline text-muted-foreground">
          {strings.vaultIntro}
        </p>

        {offerApplyAll && onUse ? (
          <Checkbox
            label={strings.vaultApplyAll}
            hint={strings.vaultApplyAllHint}
            checked={applyAll}
            onChange={setApplyAll}
          />
        ) : null}

        {onCreateNew ? (
          <Button variant="secondary" size="md" fullWidth onClick={onCreateNew}>
            {strings.vaultCreateNew}
          </Button>
        ) : null}

        {showToolbar ? (
          <div className="flex items-center justify-between gap-2">
            {/* Variante destructiva del sistema (texto `destructive-text` sobre fondo tintado, AA). */}
            <Button
              variant="destructive"
              size="sm"
              className={COARSE_TALL}
              disabled={entries.length === 0}
              onClick={() => setConfirmAllOpen(true)}
            >
              {strings.vaultDeleteAll}
            </Button>
            {/* Importar: solo icono, nombre y tooltip neutros. */}
            <button
              type="button"
              aria-label={strings.vaultImport}
              title={strings.vaultImport}
              disabled={importBusy}
              onClick={() => importInputRef.current?.click()}
              data-vault-focus="import"
              className={ICON_BUTTON}
            >
              <span className={ICON_BUBBLE}>
                {importBusy ? (
                  <Spinner className="size-4" />
                ) : (
                  <FileUp aria-hidden="true" className="size-4" />
                )}
              </span>
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept=".zip,application/zip"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void handleImportFile(file);
              }}
            />
          </div>
        ) : null}

        {/* Region de estado siempre montada: solo cambia su contenido. */}
        <p
          role="status"
          aria-live="polite"
          className={cn(
            "text-footnote",
            notice
              ? notice.tone === "error"
                ? "text-destructive-text"
                : "text-success-text"
              : "sr-only",
          )}
        >
          {importBusy ? strings.vaultImportWorking : (notice?.text ?? "")}
        </p>

        <div
          ref={listRef}
          tabIndex={-1}
          aria-label={strings.vaultTitle}
          role="region"
          className="rounded-ios-sm"
        >
          {status === "loading" ? (
            <div className="flex justify-center py-8">
              <Spinner label={strings.vaultLoading} />
            </div>
          ) : status === "unavailable" ? (
            <p className="rounded-ios-sm border border-white/10 bg-white/5 p-4 text-subheadline leading-relaxed text-muted-foreground">
              {strings.vaultUnavailable}
            </p>
          ) : sorted.length === 0 ? (
            <p className="py-4 text-subheadline text-muted-foreground">
              {strings.vaultEmpty}
            </p>
          ) : (
            <ul className="space-y-2">
              {sorted.map((entry) => (
                <li key={entry.id}>
                  <VaultCard
                    entry={entry}
                    strings={strings}
                    need={need}
                    matches={
                      preferredKey !== "" && entry.signerKey === preferredKey
                    }
                    editing={editingId === entry.id}
                    lastUsed={dateFormatter.format(new Date(entry.lastUsedAt))}
                    onUse={handleUse}
                    onStartEdit={() => {
                      setNotice(null);
                      setEditingId(entry.id);
                    }}
                    onStopEdit={(saved) => {
                      pendingFocusRef.current = `edit-${entry.id}`;
                      setEditingId(null);
                      if (saved) showNotice(strings.vaultEdited);
                    }}
                    onExport={() => {
                      setNotice(null);
                      setExportId(entry.id);
                      setExportOpen(true);
                    }}
                    onDelete={() => void handleDelete(entry)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <ConfirmSheet
        open={confirmAllOpen}
        onClose={() => setConfirmAllOpen(false)}
        onConfirm={() => void handleDeleteAll()}
        title={strings.vaultDeleteAllTitle}
        body={strings.vaultDeleteAllBody}
        confirmLabel={strings.vaultDeleteAll}
        cancelLabel={strings.confirmCancel}
        closeLabel={strings.confirmClose}
      />

      <Sheet
        open={exportOpen && exportEntry !== null}
        onClose={() => setExportOpen(false)}
        title={strings.vaultExportTitle}
        closeLabel={t.common.close}
      >
        {exportEntry ? (
          <ExportForm
            entry={exportEntry}
            strings={strings}
            onDone={(message) => {
              setExportOpen(false);
              pendingFocusRef.current = `export-${exportEntry.id}`;
              showNotice(message);
            }}
          />
        ) : null}
      </Sheet>

      <Sheet
        open={passwordOpen && pendingFile !== null}
        onClose={() => setPasswordOpen(false)}
        title={strings.vaultImportPasswordTitle}
        closeLabel={t.common.close}
      >
        {pendingFile ? (
          <ImportPasswordForm
            file={pendingFile}
            strings={strings}
            onDone={async (entry) => {
              setPasswordOpen(false);
              pendingFocusRef.current = "import";
              await finishImport(entry);
            }}
          />
        ) : null}
      </Sheet>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ *
 * Tarjeta de una entrada
 * ------------------------------------------------------------------ */

type VaultCardProps = {
  entry: VaultEntry;
  strings: SignStrings;
  need?: "signature" | "initials";
  matches: boolean;
  editing: boolean;
  lastUsed: string;
  onUse?: (entry: VaultEntry) => void;
  onStartEdit: () => void;
  onStopEdit: (saved: boolean) => void;
  onExport: () => void;
  onDelete: () => void;
};

function Thumb({ image, alt }: { image: VaultImage; alt: string }) {
  const src = useMemo(() => vaultImageToDataUrl(image), [image]);
  return (
    <span className="rounded-ios-sm flex h-12 min-w-14 items-center justify-center border border-white/10 bg-white px-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        className="max-h-10 w-auto max-w-32 object-contain"
      />
    </span>
  );
}

function VaultCard({
  entry,
  strings,
  need,
  matches,
  editing,
  lastUsed,
  onUse,
  onStartEdit,
  onStopEdit,
  onExport,
  onDelete,
}: VaultCardProps) {
  const usable = need ? entry[need] !== null : true;

  return (
    <div className="surface-card rounded-ios-sm space-y-3 p-3">
      <div className="flex items-center gap-3">
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {entry.signature ? (
            <Thumb
              image={entry.signature}
              alt={strings.vaultSignatureAlt(entry.signerName)}
            />
          ) : null}
          {entry.initials ? (
            <Thumb
              image={entry.initials}
              alt={strings.vaultInitialsAlt(entry.signerName)}
            />
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-callout font-semibold text-foreground">
            {entry.signerName}
          </p>
          {entry.role ? (
            <p className="truncate text-footnote text-muted-foreground">
              {entry.role}
            </p>
          ) : null}
          <p className="text-caption text-muted-foreground [overflow-wrap:anywhere]">
            {entry.sourceDocument
              ? `${strings.vaultUsedIn(entry.sourceDocument)} · `
              : ""}
            {strings.vaultLastUsed(lastUsed)}
          </p>
          {matches ? (
            <p className="text-caption font-medium text-signal-text">
              {strings.vaultMatchesSigner}
            </p>
          ) : null}
        </div>
      </div>

      {editing ? (
        <EditForm entry={entry} strings={strings} onDone={onStopEdit} />
      ) : (
        <div className="flex items-center justify-between gap-2">
          {onUse ? (
            usable ? (
              <Button
                size="sm"
                className={COARSE_TALL}
                aria-label={strings.vaultUseFor(entry.signerName)}
                onClick={() => onUse(entry)}
              >
                {strings.vaultUse}
              </Button>
            ) : (
              <p className="min-w-0 flex-1 text-caption text-muted-foreground">
                {need === "initials"
                  ? strings.vaultLacksInitials
                  : strings.vaultLacksSignature}
              </p>
            )
          ) : (
            <span />
          )}
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              aria-label={strings.vaultEditLabel(entry.signerName)}
              title={strings.vaultEditLabel(entry.signerName)}
              data-vault-focus={`edit-${entry.id}`}
              onClick={onStartEdit}
              className={ICON_BUTTON}
            >
              <span className={ICON_BUBBLE}>
                <Pencil aria-hidden="true" className="size-4" />
              </span>
            </button>
            {/* Exportar: solo icono, nombre y tooltip neutros. */}
            <button
              type="button"
              aria-label={strings.vaultExportFor(entry.signerName)}
              title={strings.vaultExport}
              data-vault-focus={`export-${entry.id}`}
              onClick={onExport}
              className={ICON_BUTTON}
            >
              <span className={ICON_BUBBLE}>
                <SaveCheck aria-hidden="true" className="size-4" />
              </span>
            </button>
            <button
              type="button"
              aria-label={strings.vaultDeleteLabel(entry.signerName)}
              title={strings.vaultDeleteLabel(entry.signerName)}
              onClick={onDelete}
              className={ICON_BUTTON}
            >
              <span className={cn(ICON_BUBBLE, "group-hover:text-destructive-text")}>
                <Trash2 aria-hidden="true" className="size-4" />
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Editar nombre y cargo
 * ------------------------------------------------------------------ */

function EditForm({
  entry,
  strings,
  onDone,
}: {
  entry: VaultEntry;
  strings: SignStrings;
  onDone: (saved: boolean) => void;
}) {
  const [name, setName] = useState(entry.signerName);
  const [role, setRole] = useState(entry.role ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const nameId = `vault-name-${entry.id}`;
  const roleId = `vault-role-${entry.id}`;

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const result = await updateVaultEntry(entry.id, {
      signerName: name,
      role,
    });
    setBusy(false);
    if (result.ok) {
      onDone(true);
      return;
    }
    setError(
      result.reason === "invalid" ? strings.vaultEditInvalid : strings.vaultOpFailed,
    );
    nameRef.current?.focus();
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3">
      <div>
        <label
          htmlFor={nameId}
          className="ui-label mb-1.5 block text-muted-foreground"
        >
          {strings.vaultEditNameLabel}
        </label>
        <input
          ref={nameRef}
          id={nameId}
          type="text"
          value={name}
          maxLength={200}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setName(event.target.value);
            setError("");
          }}
          className={INPUT_CLASS}
        />
      </div>
      <div>
        <label
          htmlFor={roleId}
          className="ui-label mb-1.5 block text-muted-foreground"
        >
          {strings.vaultEditRoleLabel}
        </label>
        <input
          id={roleId}
          type="text"
          value={role}
          maxLength={200}
          onChange={(event) => setRole(event.target.value)}
          className={INPUT_CLASS}
        />
      </div>
      <p
        role="status"
        aria-live="polite"
        className={cn("text-footnote", error ? "text-destructive-text" : "sr-only")}
      >
        {error}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="md" disabled={busy}>
          {strings.vaultEditSave}
        </Button>
        <Button variant="ghost" size="md" onClick={() => onDone(false)}>
          {strings.vaultEditCancel}
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * Exportar
 * ------------------------------------------------------------------ */

function ExportForm({
  entry,
  strings,
  onDone,
}: {
  entry: VaultEntry;
  strings: SignStrings;
  onDone: (message: string) => void;
}) {
  const canEncrypt = encryptionAvailable();
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  /**
   * El nombre del archivo identifica al firmante Y al documento
   * (`Firma-<firmante>-<documento>.zip`): por defecto la casilla va MARCADA
   * cuando la entrada tiene documento de origen, tambien con contraseña (el
   * aviso de que el nombre es visible aunque el contenido vaya cifrado se
   * mantiene junto a ella). Sin documento de origen no hay casilla y el
   * nombre es `Firma-<firmante>.zip`.
   */
  const [includeDocument, setIncludeDocument] = useState(
    entry.sourceDocument.trim() !== "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const aliveRef = useRef(true);

  // Si se cierra el sheet mientras se cifra, el resultado se descarta
  // en vez de descargar un archivo que nadie esta esperando.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const wantsPassword = canEncrypt && password !== "";

  const submit = async () => {
    if (busy) return;
    if (wantsPassword && password !== repeat) {
      setError(strings.vaultExportPasswordMismatch);
      return;
    }
    setError("");
    setBusy(true);
    const result = await exportVaultEntry(entry, {
      password: wantsPassword ? password : undefined,
      includeDocumentName: includeDocument,
    });
    if (!aliveRef.current) return;
    setBusy(false);
    if (!result.ok) {
      setError(
        result.reason === "encryptionUnavailable"
          ? strings.vaultExportPasswordUnavailable
          : strings.vaultExportFailed,
      );
      return;
    }
    downloadBlob(result.blob, result.filename);
    onDone(strings.vaultExportDone(result.filename, result.encrypted));
  };

  const passwordId = `vault-export-pass-${entry.id}`;
  const repeatId = `vault-export-repeat-${entry.id}`;
  const hintId = `${passwordId}-hint`;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="space-y-4 pb-2"
    >
      <p className="text-subheadline text-muted-foreground">
        {strings.vaultExportBody}
      </p>

      <div>
        <label
          htmlFor={passwordId}
          className="ui-label mb-1.5 block text-muted-foreground"
        >
          {strings.vaultExportPasswordLabel}
        </label>
        <input
          id={passwordId}
          type="password"
          autoComplete="new-password"
          value={password}
          disabled={!canEncrypt || busy}
          aria-describedby={hintId}
          onChange={(event) => {
            setPassword(event.target.value);
            setError("");
          }}
          className={INPUT_CLASS}
        />
        <p id={hintId} className="mt-1.5 text-footnote text-muted-foreground">
          {canEncrypt
            ? strings.vaultExportPasswordHint
            : strings.vaultExportPasswordUnavailable}
        </p>
      </div>

      {wantsPassword ? (
        <div>
          <label
            htmlFor={repeatId}
            className="ui-label mb-1.5 block text-muted-foreground"
          >
            {strings.vaultExportPasswordConfirmLabel}
          </label>
          <input
            id={repeatId}
            type="password"
            autoComplete="new-password"
            value={repeat}
            disabled={busy}
            onChange={(event) => {
              setRepeat(event.target.value);
              setError("");
            }}
            className={INPUT_CLASS}
          />
        </div>
      ) : null}

      {entry.sourceDocument ? (
        <Checkbox
          label={strings.vaultExportIncludeDocument}
          hint={strings.vaultExportIncludeDocumentHint}
          checked={includeDocument}
          disabled={busy}
          onChange={setIncludeDocument}
        />
      ) : null}

      {!wantsPassword ? (
        <p className="rounded-ios-sm border border-white/10 bg-white/5 p-3 text-footnote leading-relaxed text-muted-foreground">
          {strings.vaultExportPlainWarning}
        </p>
      ) : null}

      <p
        role="status"
        aria-live="polite"
        className={cn(
          "flex items-center gap-2 text-footnote",
          error ? "text-destructive-text" : busy ? "text-muted-foreground" : "sr-only",
        )}
      >
        {busy ? <Spinner className="size-4" /> : null}
        {busy ? strings.vaultExportWorking : error}
      </p>

      <Button type="submit" size="md" fullWidth disabled={busy}>
        {strings.vaultExportConfirm}
      </Button>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * Importar un archivo cifrado
 * ------------------------------------------------------------------ */

function ImportPasswordForm({
  file,
  strings,
  onDone,
}: {
  file: File;
  strings: SignStrings;
  onDone: (entry: Parameters<typeof saveVaultEntry>[0]) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const aliveRef = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    aliveRef.current = true;
    // El Sheet enfoca su panel en SU efecto, que corre despues del de sus hijos:
    // enfocar aqui mismo lo pierde. Se aplaza un tick para que el campo lo conserve.
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      aliveRef.current = false;
      window.clearTimeout(focusTimer);
    };
  }, []);

  const submit = async () => {
    if (busy || password === "") return;
    setError("");
    setBusy(true);
    const result = await importVaultFile(file, { password });
    if (!aliveRef.current) return;
    setBusy(false);
    if (result.ok) {
      await onDone(result.entry);
      return;
    }
    setError(importReasonMessage(strings, result.reason));
    inputRef.current?.focus();
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="space-y-4 pb-2"
    >
      <p className="text-subheadline text-muted-foreground">
        {strings.vaultImportPasswordBody}
      </p>
      <div>
        <label
          htmlFor="vault-import-password"
          className="ui-label mb-1.5 block text-muted-foreground"
        >
          {strings.vaultImportPasswordLabel}
        </label>
        <input
          ref={inputRef}
          id="vault-import-password"
          type="password"
          autoComplete="current-password"
          value={password}
          // `readOnly`, no `disabled`: un campo deshabilitado pierde el foco y,
          // al volver a habilitarse, el navegador no lo recupera (caia en <body>).
          readOnly={busy}
          aria-busy={busy || undefined}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setPassword(event.target.value);
            setError("");
          }}
          className={INPUT_CLASS}
        />
      </div>
      <p
        role="status"
        aria-live="polite"
        className={cn(
          "flex items-center gap-2 text-footnote",
          error ? "text-destructive-text" : busy ? "text-muted-foreground" : "sr-only",
        )}
      >
        {busy ? <Spinner className="size-4" /> : null}
        {busy ? strings.vaultImportWorking : error}
      </p>
      <Button type="submit" size="md" fullWidth disabled={busy || password === ""}>
        {strings.vaultImportPasswordConfirm}
      </Button>
    </form>
  );
}
