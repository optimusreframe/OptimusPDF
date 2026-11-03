"use client";

import { Users } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { signerDisplayName, type Signer } from "@/lib/pdf/sign";
import { useQuickSignStrings } from "@/app/sign-pdf/fillMode/fillStrings";

/**
 * «Firman: Ana, Luis · Cambiar» (W3-B2): el paso «Firmantes» se salta cuando quien firma ya estaba decidido (los mismos de la
 * ronda anterior). Esta linea dice quienes son y deja volver a cambiarlos con un toque: nada se esconde.
 */
export function SignersRecap({ signers, defaultName, onChange }: { signers: readonly Signer[]; defaultName: (index: number) => string; onChange: () => void }) {
  const strings = useQuickSignStrings();
  if (signers.length === 0) return null;
  const names = signers.map((signer, index) => signerDisplayName(signer.name, index, defaultName)).join(", ");
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-signers-recap="">
      <p className="flex min-w-0 items-center gap-2 text-footnote font-semibold text-foreground [overflow-wrap:anywhere]">
        <Users aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        {strings.signersRecap(names)}
      </p>
      <Button
        variant="ghost"
        size="sm"
        className="pointer-coarse:h-11 pointer-coarse:before:hidden"
        aria-label={`${strings.signersChange}. ${strings.signersChangeHint}`}
        onClick={onChange}
      >
        {strings.signersChange}
      </Button>
    </div>
  );
}
