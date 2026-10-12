"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { TextField } from "@/components/tool/OptionControls";
import { useI18n } from "@/lib/i18n";
import type { ProtectedExport } from "@/app/pdf-pro/ops/protectExport";
import { ensurePdfName, type SavePrompt } from "@/app/pdf-pro/save/proSave";
import { getSaveStrings } from "@/app/pdf-pro/save/saveStrings";
import { ProtectPanel } from "@/app/pdf-pro/tabs/ProtectPanel";

/**
 * Hojas del guardado de PDF Pro (Wave 7 · U8): confirmar antes de descargar (firmas digitales, copia sin cifrar),
 * «Guardar como…» (nombre) y «Guardar con contraseña…» (integra `ProtectPanel`: el resultado se descarga y el
 * historial NO cambia).
 */

export function SaveConfirmSheet({
  open,
  prompt,
  onClose,
  onDownload,
  onProtect,
}: {
  open: boolean;
  prompt: SavePrompt | null;
  onClose: () => void;
  onDownload: () => void;
  onProtect: () => void;
}) {
  const { t, language } = useI18n();
  const s = getSaveStrings(language);
  return (
    <Sheet open={open} onClose={onClose} title={s.confirmTitle} closeLabel={t.common.close}>
      <div className="space-y-3 pb-4" data-save-confirm="">
        {prompt?.signatures ? (
          <p className="flex items-start gap-2 text-subheadline text-foreground">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-edit" />
            {s.confirmSignatures}
          </p>
        ) : null}
        {prompt?.decrypted ? (
          <p className="flex items-start gap-2 text-subheadline text-foreground">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-edit" />
            {s.confirmDecrypted}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-2 pb-2">
        <Button size="md" fullWidth onClick={onDownload} data-save-confirm-download="">
          {prompt?.decrypted && !prompt.signatures ? s.confirmDownloadPlain : s.confirmDownload}
        </Button>
        {prompt?.decrypted ? (
          <Button size="md" variant="secondary" fullWidth onClick={onProtect}>
            {s.confirmProtect}
          </Button>
        ) : null}
        <Button size="md" variant="ghost" fullWidth onClick={onClose}>
          {s.cancel}
        </Button>
      </div>
    </Sheet>
  );
}

export function SaveAsSheet({
  open,
  defaultName,
  onClose,
  onSubmit,
}: {
  open: boolean;
  defaultName: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const { t, language } = useI18n();
  const s = getSaveStrings(language);
  return (
    <Sheet open={open} onClose={onClose} title={s.saveAsTitle} closeLabel={t.common.close} initialFocus="[data-save-as] input">
      {/* El estado del campo vive en un hijo: cada vez que la hoja se abre arranca con el nombre vigente. */}
      <SaveAsForm key={`${open}-${defaultName}`} defaultName={defaultName} onSubmit={onSubmit} onClose={onClose} />
    </Sheet>
  );
}

function SaveAsForm({
  defaultName,
  onSubmit,
  onClose,
}: {
  defaultName: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const { language } = useI18n();
  const s = getSaveStrings(language);
  const [name, setName] = useState(defaultName);
  const cleaned = ensurePdfName(name);
  return (
    <form
      data-save-as=""
      onSubmit={(event) => {
        event.preventDefault();
        if (cleaned) onSubmit(cleaned);
      }}
      className="space-y-4 pb-2"
    >
      <p className="text-subheadline text-muted-foreground">{s.saveAsBody}</p>
      <TextField label={s.nameLabel} value={name} maxLength={150} onChange={setName} hint={cleaned ? `${cleaned} · ${s.nameHint}` : s.nameEmpty} />
      <div className="flex flex-col gap-2">
        <Button type="submit" size="md" fullWidth aria-disabled={!cleaned || undefined}>
          {s.saveAsButton}
        </Button>
        <Button type="button" size="md" variant="ghost" fullWidth onClick={onClose}>
          {s.cancel}
        </Button>
      </div>
    </form>
  );
}

export function ProtectSaveSheet({
  open,
  onClose,
  onProtected,
}: {
  open: boolean;
  onClose: () => void;
  onProtected: (result: ProtectedExport, fileName: string) => void;
}) {
  const { t, language } = useI18n();
  const s = getSaveStrings(language);
  return (
    <Sheet open={open} onClose={onClose} title={s.protectTitle} closeLabel={t.common.close}>
      <div data-protect-save-sheet="" className="pb-2">
        <ProtectPanel onProtected={onProtected} />
      </div>
    </Sheet>
  );
}
