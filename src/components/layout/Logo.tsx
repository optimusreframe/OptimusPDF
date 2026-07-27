"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";

export function Logo({ className }: { className?: string }) {
  const t = useT();
  return (
    <Link
      href="/"
      className={cn(
        "font-mono text-base font-bold tracking-[0.02em] text-foreground",
        className,
      )}
    >
      {t.common.brandFirst}
      <span className="text-signal">{t.common.brandSecond}</span>
    </Link>
  );
}
