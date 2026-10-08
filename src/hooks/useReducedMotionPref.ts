"use client";

import { useSyncExternalStore } from "react";
import { REDUCED_MOTION_QUERY } from "@/lib/motion";

/*
 * Store externo sobre matchMedia con useSyncExternalStore.
 *
 * Lo que garantiza: en un montaje puramente en cliente (sin HTML del
 * servidor) el primer render ya devuelve el valor real; en un arbol
 * hidratado React usa getServerSnapshot (`false`) durante la hidratacion
 * y corrige en un efecto pasivo, asi que el PRIMER frame hidratado ve
 * `false`. Por eso este hook NO es el mecanismo para las animaciones de
 * `motion`: eso lo resuelve <MotionConfig reducedMotion="user"> (en
 * Providers.tsx) dentro del motor, clave por clave y sin depender del
 * ciclo de render. El hook sirve para logica propia del componente:
 * `dragMomentum={!reduced}`, elegir un snap instantaneo, no arrancar un
 * autoplay, etc.
 */

let mediaQueryList: MediaQueryList | null | undefined;

function getMediaQueryList(): MediaQueryList | null {
  if (mediaQueryList !== undefined) return mediaQueryList;
  mediaQueryList =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(REDUCED_MOTION_QUERY)
      : null;
  return mediaQueryList;
}

function subscribe(onStoreChange: () => void): () => void {
  const mql = getMediaQueryList();
  if (!mql) return () => {};
  mql.addEventListener("change", onStoreChange);
  return () => mql.removeEventListener("change", onStoreChange);
}

function getSnapshot(): boolean {
  return getMediaQueryList()?.matches ?? false;
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * `true` si el usuario prefiere menos movimiento. En SSR y durante la
 * hidratacion devuelve `false` (se corrige justo despues); reacciona si
 * la preferencia cambia en vivo.
 *
 * Uso: logica propia, no la transicion de <motion.*> (eso ya lo hace
 * MotionConfig). Junto a src/lib/motion.ts:
 *   const reduced = useReducedMotionPref();
 *   <motion.div drag="x" dragMomentum={!reduced} … />
 *   animate(xValue, target, reducedValueTransition(springs.momentum, reduced, true))
 *   animate(el, { opacity: 1 }, reducedAnimateOptions(springs.default, reduced))
 */
export function useReducedMotionPref(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Solo para tests: olvida la MediaQueryList cacheada. */
export function resetReducedMotionPrefCache(): void {
  mediaQueryList = undefined;
}
