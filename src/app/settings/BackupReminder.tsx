"use client";

import { useRef } from "react";
import { Archive } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useI18n } from "@/lib/i18n";
import { fillText } from "@/app/documents/backupModel";
import { useBackupReminder } from "@/app/settings/useBackupReminder";

/**
 * Aviso NO intrusivo de que conviene hacer un respaldo (30 días o 10 cambios desde el último, U4.7). Una tarjeta discreta con
 * dos botones de 44 px: «Respaldar ahora» (abre «Exportar mi paquete») y «Recordármelo luego» (7 días). Sin ventanas
 * emergentes ni bloqueos; solo se pinta en Ajustes y en «Mis documentos», nunca en una pantalla de trabajo. NO tiene región
 * viva propia (la página ya tiene una): al posponer avisa por `announce` y el foco pasa al contenedor, que no desaparece.
 */
export function BackupReminder({
  onBackup,
  announce,
  className,
  level = 2,
  showWhy = true,
}: {
  onBackup: () => void;
  announce: (message: string) => void;
  className?: string;
  level?: 2 | 3;
  /** El motivo (Safari borra los datos tras 7 días sin uso). Ajustes ya lo dice justo encima y no lo repite. */
  showWhy?: boolean;
}) {
  const { t } = useI18n();
  const copy = t.settings.backup;
  const { status, visible, snooze } = useBackupReminder();
  const hostRef = useRef<HTMLDivElement>(null);
  const Heading = level === 3 ? "h3" : "h2";

  if (!visible || status === null) return <div ref={hostRef} tabIndex={-1} className="outline-none" data-backup-reminder-host="" />;
  const text =
    status.reason === "changes"
      ? fillText(copy.reminderChanges, { n: status.changes })
      : status.lastBackup === null
        ? fillText(copy.reminderDaysNever, { n: status.days ?? 0 })
        : fillText(copy.reminderDays, { n: status.days ?? 0 });

  return (
    <div ref={hostRef} tabIndex={-1} className={className ? `${className} outline-none` : "outline-none"} data-backup-reminder-host="">
      <section aria-labelledby="backup-reminder-title" data-backup-reminder={status.reason ?? ""} className="surface-card rounded-ios-sm border border-signal/30 p-4">
        <Heading id="backup-reminder-title" className="flex items-center gap-2 text-headline text-foreground">
          <Archive aria-hidden="true" className="size-4 shrink-0 text-signal-text" />
          {copy.reminderTitle}
        </Heading>
        <p className="mt-1 text-subheadline text-muted-foreground [overflow-wrap:anywhere]">{text}</p>
        {showWhy ? <p className="mt-1 text-footnote text-muted-foreground [overflow-wrap:anywhere]">{copy.why}</p> : null}
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button size="md" wrap onClick={onBackup} data-backup-reminder-now="">
            {copy.reminderNow}
          </Button>
          <Button
            variant="secondary"
            size="md"
            wrap
            data-backup-reminder-later=""
            onClick={() => {
              hostRef.current?.focus();
              if (snooze()) announce(copy.reminderLaterDone);
            }}
          >
            {copy.reminderLater}
          </Button>
        </div>
      </section>
    </div>
  );
}
