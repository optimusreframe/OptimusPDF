"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";

/*
 * Wordmark en la fuente del sistema (como "Final Cut Pro" o "Keynote"):
 * semibold, tracking negativo por el tamaño, "PDF" en el azul de marca.
 * Nada de mono ni mayusculas forzadas: el texto lo ponen los locales.
 */
export function Logo({ className }: { className?: string }) {
  const t = useT();
  return (
    <Link
      href="/"
      className={cn(
        "inline-flex h-11 items-center rounded-ios-sm text-headline tracking-[-0.02em] text-foreground",
        className,
      )}
    >
      {t.common.brandFirst}
      <span className="text-signal-text">{t.common.brandSecond}</span>
    </Link>
  );
}
