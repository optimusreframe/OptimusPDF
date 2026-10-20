"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { GlassCard } from "@/components/ui/GlassCard";
import { useI18n } from "@/lib/i18n";
import { BACKUP_STATE_EVENT, readLastBackup } from "@/lib/backup/lastBackup";
import { lastBackupView } from "@/app/documents/backupModel";
import { focusFallbackWhenIdle } from "@/app/settings/focusFallback";
import { BackupReminder } from "@/app/settings/BackupReminder";
import { ExportPackageSheet } from "@/app/settings/ExportPackageSheet";
import { ImportPackageSheet } from "@/app/settings/ImportPackageSheet";
import { lastBackupText } from "@/app/settings/packageModel";

/** La fecha del último respaldo, leída en el navegador (nunca en el servidor) y al día cuando cambia (esta pestaña o las demás). */
export function useLastBackup(): Date | null {
  const [last, setLast] = useState<Date | null>(null);
  useEffect(() => {
    const read = () => setLast(readLastBackup());
    read();
    window.addEventListener(BACKUP_STATE_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(BACKUP_STATE_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return last;
}

/**
 * Ajustes ➜ «Respaldo y traslado» (U4.7): «Exportar mi paquete», «Importar paquete», «Último respaldo: hace N días», el
 * recordatorio de respaldo (30 días o 10 cambios), el motivo en una línea (Safari puede borrar los datos de un sitio tras 7
 * días sin uso) y «Añadir a la pantalla de inicio». Las hojas son las del paquete global. Nada sale del dispositivo.
 */
export function BackupSection() {
  const { t } = useI18n();
  const copy = t.settings.backup;
  const lastBackup = useLastBackup();
  const [sheet, setSheet] = useState<"export" | "import" | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const exportRef = useRef<HTMLButtonElement>(null);

  /** Al cerrar una hoja, si el botón que la abrió ya no existe (el recordatorio se oculta) el foco vuelve al botón fijo de la sección. */
  const close = useCallback(() => {
    setSheet(null);
    focusFallbackWhenIdle(() => exportRef.current);
  }, []);

  return (
    <GlassCard className="p-6">
      <section aria-labelledby="settings-backup-title" id="backup" data-settings-backup="">
        <h2 id="settings-backup-title" className="text-headline text-foreground">
          {copy.title}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{copy.intro}</p>
        <p className="mt-2 text-footnote leading-relaxed text-muted-foreground" data-backup-why="">
          {copy.why}
        </p>
        <p className="mt-1 text-footnote leading-relaxed text-muted-foreground" data-backup-a2hs="">
          {copy.homeScreenTip}
        </p>
        <BackupReminder level={3} showWhy={false} className="mt-4" announce={setAnnouncement} onBackup={() => setSheet("export")} />
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button ref={exportRef} size="md" wrap onClick={() => setSheet("export")} data-backup-export-open="">
            <Download aria-hidden="true" className="size-4 shrink-0" />
            {copy.exportAction}
          </Button>
          <Button variant="secondary" size="md" wrap onClick={() => setSheet("import")} data-backup-import-open="">
            <Upload aria-hidden="true" className="size-4 shrink-0" />
            {copy.importAction}
          </Button>
        </div>
        <p className="mt-3 text-footnote text-muted-foreground" data-backup-last="">
          {lastBackupText(lastBackupView(lastBackup), copy)}
        </p>
        <p role="status" aria-live="polite" className="sr-only" data-backup-live="">
          {announcement}
        </p>
      </section>
      <ExportPackageSheet open={sheet === "export"} onClose={close} onDone={setAnnouncement} />
      <ImportPackageSheet open={sheet === "import"} onClose={close} onDone={setAnnouncement} />
    </GlassCard>
  );
}
