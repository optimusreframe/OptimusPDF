import { deleteEditDraft } from "@/app/edit-pdf/editDrafts";
import { deleteProDraft } from "@/app/pdf-pro/proDrafts";
import type { UnfinishedItem } from "@/app/recent/unfinishedWork";
import { deleteDraft, deleteSessionDraft } from "@/app/sign-pdf/signDrafts";
import { scanSessionStore } from "@/lib/scan/sessionStore";

/** Borra el borrador real de la herramienta (bytes y metadatos). Ninguna de estas funciones lanza. */
export async function discardItem(item: UnfinishedItem): Promise<void> {
  switch (item.target.kind) {
    case "session":
      await deleteSessionDraft(item.target.id);
      return;
    case "sign":
      await deleteDraft(item.target.id);
      return;
    case "edit":
      await deleteEditDraft(item.target.id);
      return;
    case "pro":
      await deleteProDraft(item.target.id);
      return;
    case "scan":
      await scanSessionStore.remove(item.target.id);
      return;
  }
}
