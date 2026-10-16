"use client";

import Link from "next/link";
import { FilePlus2, FolderOpen } from "lucide-react";
import { keepTemplate } from "@/app/documents/documentActions";
import { DocumentCard } from "@/app/documents/DocumentCard";
import { HOME_LIMIT } from "@/app/documents/documentsModel";
import { useDocumentLibrary } from "@/app/documents/useDocumentLibrary";
import { useOpenInSign } from "@/app/documents/useOpenInSign";
import { buttonClasses } from "@/components/ui/Button";
import { useT } from "@/lib/i18n";

/**
 * Seccion compacta «Mis documentos» de Inicio (sobre «Mas usadas»): hasta 4 documentos con su ✓/✗ y «Firmar» /
 * «Configurar plantilla», y «Ver todos». Vacia: invita a anadir el primer contrato. Sin IndexedDB no pinta nada (la
 * pagina completa explica por que).
 */
export function MyDocumentsHomeSection() {
  const t = useT();
  const openInSign = useOpenInSign();
  const { loaded, available, documents, statuses, refresh } = useDocumentLibrary();
  if (!loaded || !available) return null;

  const shown = documents.slice(0, HOME_LIMIT);
  return (
    <section className="mb-12" aria-labelledby="my-documents-title" data-home-documents="">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id="my-documents-title" className="text-title-3 text-foreground">
          {t.documents.title}
        </h2>
        <Link
          href="/documents"
          className="inline-flex h-11 items-center rounded-ios-sm px-1 text-footnote font-semibold text-signal-text hover:text-glow"
        >
          {t.documents.seeAll}
        </Link>
      </div>
      {shown.length === 0 ? (
        <div className="surface-card flex flex-col items-start gap-3 rounded-ios p-4 sm:flex-row sm:items-center" data-home-documents-empty="">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white/6">
            <FolderOpen aria-hidden="true" className="size-5 text-muted-foreground" />
          </span>
          <p className="min-w-0 flex-1 text-subheadline text-muted-foreground">{t.documents.emptyTitle}</p>
          <Link href="/documents" className={buttonClasses("secondary", "md", undefined, true)}>
            <FilePlus2 aria-hidden="true" className="size-4 shrink-0" />
            {t.documents.add}
          </Link>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2" aria-label={t.documents.listLabel}>
          {shown.map((doc) => (
            <DocumentCard
              key={doc.id}
              doc={doc}
              status={statuses.get(doc.id)}
              onSign={() => openInSign([doc.id], "sign")}
              onConfigure={() => openInSign([doc.id], "configure")}
              onKeepTemplate={() => void keepTemplate(doc).then(() => refresh())}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
