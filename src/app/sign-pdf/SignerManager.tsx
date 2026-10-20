"use client";

import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import {
  signerColorAt,
  signerDisplayName,
  type Signer,
} from "@/lib/pdf/sign";
import { MAX_SIGNERS } from "@/app/sign-pdf/signLimits";
import {
  SignerBlockList,
  type SignerBlocksApi,
} from "@/app/sign-pdf/SignerBlocks";
import type { SignStrings } from "@/app/sign-pdf/strings";

/**
 * Limite de altas (2). Vive en `signLimits.ts` para que los modulos de datos
 * lo usen sin importar este componente; se re-exporta aqui por ser donde lo
 * busca quien trabaja con firmantes. `SIGNER_COLORS` queda aparte y entera.
 */
export { MAX_SIGNERS };

export type SignerManagerProps = {
  signers: Signer[];
  onSignersChange: (signers: Signer[]) => void;
  activeSignerId: string | null;
  onActiveSignerIdChange: (id: string | null) => void;
  /** Huecos ya reservados por firmante, indexados por `id`. */
  fieldCounts?: Record<string, number>;
  strings: SignStrings;
  /**
   * Varios documentos: cada tarjeta muestra los bloques del firmante
   * (alcance, anadir, quitar). Ausente = la interfaz de siempre.
   */
  blocks?: SignerBlocksApi;
};

/** Identificadores estables sin depender de `crypto.randomUUID`. Exportado por el mismo motivo que `nextFieldId` en `DocumentCanvas.tsx`. */
let signerCounter = 0;
export function nextSignerId(): string {
  signerCounter += 1;
  return `sg-${signerCounter}`;
}

/** Mismo motivo que `reserveFieldIds` en `DocumentCanvas.tsx`, para firmantes (`sg-N`). */
export function reserveSignerIds(ids: readonly string[]): void {
  for (const id of ids) {
    const match = /^sg-(\d+)$/.exec(id);
    if (match) signerCounter = Math.max(signerCounter, Number(match[1]));
  }
}

/**
 * El color no se guarda al crear el firmante sino que se reparte por
 * posicion cada vez que la lista cambia: asi, al quitar a alguien de en
 * medio, no quedan dos personas con el mismo color. Exportado: restaurar
 * un firmante borrado (`SignToolClient.tsx`) tiene que recalcular los
 * colores de TODOS con el mismo criterio, no solo insertar el suyo, o
 * quedarian dos firmantes con el mismo color tras deshacer.
 */
export function recolor(signers: Signer[]): Signer[] {
  return signers.map((signer, index) => ({
    ...signer,
    color: signerColorAt(index),
  }));
}

export function SignerManager({
  signers,
  onSignersChange,
  activeSignerId,
  onActiveSignerIdChange,
  fieldCounts,
  strings,
  blocks,
}: SignerManagerProps) {
  // Solo limita el ALTA: una lista heredada con mas firmantes (borrador,
  // configuracion) se muestra tal cual, con el boton de alta deshabilitado.
  const full = signers.length >= MAX_SIGNERS;

  const add = () => {
    if (full) return;
    const signer: Signer = {
      id: nextSignerId(),
      name: "",
      color: signerColorAt(signers.length),
    };
    onSignersChange(recolor([...signers, signer]));
    onActiveSignerIdChange(signer.id);
  };

  const rename = (id: string, name: string) => {
    onSignersChange(
      signers.map((signer) => (signer.id === id ? { ...signer, name } : signer)),
    );
  };

  const remove = (id: string) => {
    const next = recolor(signers.filter((signer) => signer.id !== id));
    onSignersChange(next);
    if (activeSignerId === id) {
      onActiveSignerIdChange(next[0]?.id ?? null);
    }
  };

  return (
    <section>
      <div className="mb-3">
        <h3 className="ui-label text-muted-foreground">
          {strings.signersTitle}
        </h3>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {strings.signersHint}
        </p>
      </div>

      <ul
        role="radiogroup"
        aria-label={strings.activeSignerLabel}
        className="space-y-2"
      >
        {signers.map((signer, index) => {
          const active = signer.id === activeSignerId;
          const count = fieldCounts?.[signer.id] ?? 0;
          return (
            <li
              key={signer.id}
              // La lista es un `radiogroup`: sus `li` no son elementos de lista para un lector de pantalla (axe «listitem»).
              role="none"
              className={cn(
                "surface-card rounded-ios p-3 transition-colors",
                // Con bloques la tarjeta se apila: fila del firmante + sus bloques.
                blocks ? "space-y-3" : "flex items-center gap-3",
                active ? "border border-signal/50" : "border border-white/10",
              )}
            >
              <div className={blocks ? "flex items-center gap-3" : "contents"}>
              <button
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={signerDisplayName(
                  signer.name,
                  index,
                  strings.defaultSignerName,
                )}
                onClick={() => onActiveSignerIdChange(signer.id)}
                // 44 px de caja con puntero grueso (margen negativo: el aspecto no cambia).
                className="flex size-6 shrink-0 items-center justify-center rounded-full pointer-coarse:size-11 pointer-coarse:-m-2.5"
              >
                <span
                  aria-hidden="true"
                  className="block size-6 rounded-full border-2 transition-all duration-200 ease-spring"
                  /* Color del firmante: es dato del documento, no un token del tema. */
                  style={{
                    backgroundColor: signer.color,
                    borderColor: active ? "var(--color-signal)" : "transparent",
                  }}
                />
              </button>

              <input
                type="text"
                value={signer.name}
                maxLength={40}
                placeholder={strings.defaultSignerName(index + 1)}
                aria-label={strings.signerNameLabel(index + 1)}
                onChange={(event) => rename(signer.id, event.target.value)}
                onFocus={() => onActiveSignerIdChange(signer.id)}
                className="h-9 pointer-coarse:h-11 min-w-0 flex-1 rounded-ios-sm border border-white/14 bg-white/5 px-3 text-sm pointer-coarse:text-base text-foreground transition-colors placeholder:text-muted-foreground/60 focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal"
              />

              <span className="shrink-0 text-caption text-muted-foreground tabular-nums">
                {strings.signerFieldCount(count)}
              </span>

              <button
                type="button"
                aria-label={strings.removeSigner(
                  signerDisplayName(signer.name, index, strings.defaultSignerName),
                )}
                onClick={() => remove(signer.id)}
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/8 text-muted-foreground transition-colors hover:bg-white/15 hover:text-destructive pointer-coarse:size-11 pointer-coarse:-m-1.5"
              >
                <X aria-hidden="true" className="size-4" />
              </button>
              </div>
              {blocks ? (
                <SignerBlockList
                  signer={signer}
                  signers={signers}
                  api={blocks}
                  strings={strings}
                />
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="mt-3">
        <Button variant="secondary" size="md" disabled={full} onClick={add}>
          <Plus aria-hidden="true" className="size-4" />
          {strings.addSigner}
        </Button>
      </div>

      {full ? (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          {strings.signerLimit}
        </p>
      ) : null}

      {signers.length === 0 ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {strings.noSigners}
        </p>
      ) : (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          {strings.activeSignerHint}
        </p>
      )}
    </section>
  );
}
