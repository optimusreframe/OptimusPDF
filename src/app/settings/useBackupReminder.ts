"use client";

import { useCallback, useEffect, useState } from "react";
import { BACKUP_STATE_EVENT } from "@/lib/backup/lastBackup";
import { reminderStatus, snoozeBackupReminder, startReminderClock, type ReminderStatus } from "@/lib/backup/backupReminder";
import { hasBackupWorthyData } from "@/lib/backup/globalPackage";

/**
 * Recordatorio de respaldo (U4.7): se evalúa en el navegador (nunca en el servidor) al montar y cada vez que cambia el
 * estado de respaldo (esta pestaña o las demás). Solo avisa si toca por días o por cambios, no está pospuesto y de verdad
 * hay algo que respaldar. `snooze` lo pospone 7 días.
 */
export function useBackupReminder(): { status: ReminderStatus | null; visible: boolean; snooze: () => boolean } {
  const [status, setStatus] = useState<ReminderStatus | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let alive = true;
    const evaluate = () => {
      startReminderClock();
      const next = reminderStatus();
      if (!alive) return;
      setStatus(next);
      if (!next.due) {
        setVisible(false);
        return;
      }
      void hasBackupWorthyData().then((has) => {
        if (alive) setVisible(has);
      });
    };
    evaluate();
    window.addEventListener(BACKUP_STATE_EVENT, evaluate);
    window.addEventListener("storage", evaluate);
    return () => {
      alive = false;
      window.removeEventListener(BACKUP_STATE_EVENT, evaluate);
      window.removeEventListener("storage", evaluate);
    };
  }, []);

  const snooze = useCallback(() => snoozeBackupReminder(), []);
  return { status, visible, snooze };
}
