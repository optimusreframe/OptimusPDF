"use client";

import { useState } from "react";
import {
  ceremonyAt,
  firstPendingTurn,
  resolveCeremony,
  type CeremonyStage,
  type CeremonyState,
} from "@/app/sign-pdf/blockModel";

export type CeremonyTurnArgs = {
  /** Turno guardado en la sesion; `null`/ausente = sin turno guardado (se deriva de lo que falta). */
  stored?: CeremonyState | null;
  /**
   * Escribe el turno en la sesion. Sin esto la ceremonia lleva su turno en su
   * propio estado (usos sueltos y pruebas); con esto, el turno sobrevive a que
   * la ceremonia se vuelva a montar.
   */
  onChange?: (next: CeremonyState | null) => void;
  /** Firmantes con turno, en el orden en que les toca. */
  queue: readonly { id: string }[];
  /** El firmante ya tiene todo lo suyo. */
  isDone: (signerId: string) => boolean;
  /**
   * El primer firmante cuya firma YA hecha dejo de valer (F0-fix, D7): el turno vuelve a el en lugar de quedarse con otro.
   * Ver `resolveCeremony`.
   */
  staleSignerId?: string | null;
};

export type CeremonyTurn = {
  /** Posicion (0..n) del turno en la cola; `queue.length` = ya no hay turno (todos terminaron). */
  position: number;
  stage: CeremonyStage;
  /** Va al turno `index` de la cola, en la etapa dada (por defecto, el traspaso). */
  goTo: (index: number, stage?: CeremonyStage) => void;
  /** Cambia de etapa dentro del turno de ahora. */
  setStage: (stage: CeremonyStage) => void;
  /** Pasa al primer firmante PENDIENTE (nunca al que ya firmo); sin ninguno, cierra la ronda. */
  advance: () => void;
  /** Queda alguien, distinto del turno de ahora, por firmar. */
  othersPending: boolean;
};

/**
 * El turno de la ceremonia (de quien es y en que etapa). Se DERIVA de lo que
 * falta -- el primer firmante pendiente, en el traspaso -- mientras nadie haya
 * guardado otra cosa, y desde que alguien actua se GUARDA en la sesion: asi no
 * depende de que el componente siga montado (pestanas de documento, «Atras»,
 * recarga).
 *
 * No escribe nada por su cuenta al montar: solo las acciones de la persona
 * guardan un turno, de modo que cambios ajenos (huellas que llegan, huecos que
 * se anaden en el paso anterior) siguen moviendo el turno derivado.
 */
export function useCeremonyTurn({
  stored,
  onChange,
  queue,
  isDone,
  staleSignerId,
}: CeremonyTurnArgs): CeremonyTurn {
  const [local, setLocal] = useState<CeremonyState | null>(null);
  const controlled = onChange !== undefined;
  const current = controlled ? (stored ?? null) : local;
  const { index: position, stage } = resolveCeremony(current, queue, isDone, staleSignerId);

  const write = (next: CeremonyState | null) => {
    if (onChange) onChange(next);
    else setLocal(next);
  };

  const goTo = (index: number, nextStage: CeremonyStage = "handoff") =>
    write(ceremonyAt(queue, index, nextStage));

  const currentSigner = queue[position];
  return {
    position,
    stage,
    goTo,
    setStage: (nextStage) => goTo(position, nextStage),
    advance: () => goTo(firstPendingTurn(queue, isDone), "handoff"),
    othersPending: queue.some(
      (signer) => signer.id !== currentSigner?.id && !isDone(signer.id),
    ),
  };
}
