"use client";

import { Sheet } from "@/components/ui/Sheet";
import { useI18n } from "@/lib/i18n";
import { getProStrings } from "@/app/pdf-pro/proStrings";
import { RecentDocumentsList } from "@/app/pdf-pro/session/RecentDocuments";
import { getSessionStrings } from "@/app/pdf-pro/session/sessionStrings";
import { useProDraftList } from "@/app/pdf-pro/useProDrafts";

/** Hoja «Documentos recientes» de la suite (los borradores de este navegador), para pasar a otro documento. */
export function RecentSheet({
  open,
  onClose,
  onOpen,
}: {
  open: boolean;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const { t, language } = useI18n();
  const s = getSessionStrings(language);
  return (
    <Sheet open={open} onClose={onClose} title={s.recentsTitle} closeLabel={t.common.close}>
      {open ? <RecentBody onOpen={onOpen} onClose={onClose} /> : null}
    </Sheet>
  );
}

function RecentBody({ onOpen, onClose }: { onOpen: (id: string) => void; onClose: () => void }) {
  const { language } = useI18n();
  const strings = getProStrings(language);
  const s = getSessionStrings(language);
  const { drafts, loaded, supported } = useProDraftList();
  if (!loaded) return <p className="pb-2 text-subheadline text-muted-foreground">{s.recentsLoading}</p>;
  if (!supported) return <p className="pb-2 text-subheadline text-muted-foreground">{strings.empty.draftsUnavailable}</p>;
  if (drafts.length === 0) return <p className="pb-2 text-subheadline text-muted-foreground">{strings.empty.recentEmpty}</p>;
  return (
    <div className="pb-2">
      <RecentDocumentsList
        drafts={drafts}
        language={language}
        busy={false}
        onOpen={(id) => {
          onClose();
          onOpen(id);
        }}
      />
    </div>
  );
}
