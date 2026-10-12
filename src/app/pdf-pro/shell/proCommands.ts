"use client";

import { useSyncExternalStore } from "react";

/*
 * Comandos de la paleta Cmd/Ctrl+K de PDF Pro (Wave 7 · U3).
 *
 * `registerCommand(id, { label, keywords, run })` es el punto de extension: cualquier unidad o modo puede añadir
 * un comando mientras este montado (y retirarlo al desmontar). Los comandos propios de la suite (pestañas,
 * operaciones, zoom, saltos, deshacer, exportar, herramientas sueltas) los genera `useBuiltInCommands` desde el
 * estado vivo. Este modulo es puro salvo el gancho `useRegisteredCommands`.
 */

export type ProCommandGroup = "operations" | "tabs" | "view" | "document" | "tools" | "other";

/** Orden de los grupos en la lista sin busqueda. */
export const COMMAND_GROUP_ORDER: readonly ProCommandGroup[] = [
  "document",
  "operations",
  "tabs",
  "view",
  "tools",
  "other",
];

export type ProCommandInput = {
  label: string;
  /** Palabras que tambien encuentran el comando (sinonimos, el nombre en el otro idioma...). */
  keywords?: readonly string[];
  group?: ProCommandGroup;
  /** Texto del atajo (solo informativo: `Ctrl+Z`). */
  shortcut?: string;
  run: () => void;
  /** Se muestra pero no se ejecuta (p. ej. «Deshacer» sin nada que deshacer). */
  disabled?: boolean;
};

export type ProCommand = ProCommandInput & { id: string };

class CommandRegistry {
  private commands = new Map<string, ProCommand>();
  private snapshot: readonly ProCommand[] = [];
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): readonly ProCommand[] => this.snapshot;

  private emit(): void {
    this.snapshot = [...this.commands.values()];
    for (const listener of [...this.listeners]) listener();
  }

  register(id: string, input: ProCommandInput): () => void {
    const command: ProCommand = { ...input, id };
    this.commands.set(id, command);
    this.emit();
    return () => {
      // Solo se retira si sigue siendo el mismo comando (otro pudo reutilizar el id).
      if (this.commands.get(id) === command) {
        this.commands.delete(id);
        this.emit();
      }
    };
  }

  clear(): void {
    this.commands = new Map();
    this.emit();
  }
}

const registry = new CommandRegistry();

/** Registra un comando en la paleta; devuelve la funcion que lo retira. Un mismo `id` lo sustituye. */
export function registerCommand(id: string, command: ProCommandInput): () => void {
  return registry.register(id, command);
}

/** Solo para tests: vacia los comandos registrados. */
export function __clearRegisteredCommandsForTests(): void {
  registry.clear();
}

/** Los comandos registrados con `registerCommand` (referencia estable mientras no cambien). */
export function useRegisteredCommands(): readonly ProCommand[] {
  return useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
}

/* ------------------------------------------------------------------ *
 * Busqueda difusa
 * ------------------------------------------------------------------ */

/** Minusculas y sin acentos: «Páginas» y «paginas» son lo mismo para buscar. */
export function normalizeSearch(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function isWordStart(text: string, index: number): boolean {
  return index === 0 || /[\s\-_/.:(·]/.test(text[index - 1]);
}

/**
 * Puntuacion de `query` frente a `text` (ambos YA normalizados): `null` si no coincide. Gana la subcadena
 * exacta (mas si empieza una palabra o el texto); si no, una subsecuencia con bonus por letras seguidas y por
 * inicio de palabra («rot90» encuentra «Rotar 90°»).
 */
export function fuzzyScore(query: string, text: string): number | null {
  if (query.length === 0) return 0;
  const at = text.indexOf(query);
  if (at >= 0) {
    return 200 + (at === 0 ? 60 : 0) + (isWordStart(text, at) ? 30 : 0) - at - (text.length - query.length) * 0.2;
  }
  let score = 0;
  let position = 0;
  let previous = -2;
  for (const char of query) {
    const found = text.indexOf(char, position);
    if (found < 0) return null;
    score += 2;
    if (found === previous + 1) score += 4;
    if (isWordStart(text, found)) score += 6;
    score -= Math.min(5, found - position) * 0.3;
    previous = found;
    position = found + 1;
  }
  return score;
}

/** Puntuacion de un comando: cada palabra de la consulta debe encontrarse en la etiqueta o en las palabras clave. */
export function scoreCommand(query: string, command: ProCommand): number | null {
  const tokens = normalizeSearch(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const label = normalizeSearch(command.label);
  const keywords = (command.keywords ?? []).map(normalizeSearch);
  let total = 0;
  for (const token of tokens) {
    let best: number | null = fuzzyScore(token, label);
    for (const keyword of keywords) {
      const score = fuzzyScore(token, keyword);
      if (score !== null && (best === null || score * 0.8 > best)) best = score * 0.8;
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}

/** Comandos que casan con la consulta, mejores primero; sin consulta, ordenados por grupo. */
export function searchCommands(
  commands: readonly ProCommand[],
  query: string,
  limit = 60,
): ProCommand[] {
  if (normalizeSearch(query).trim() === "") {
    const order = (command: ProCommand) => COMMAND_GROUP_ORDER.indexOf(command.group ?? "other");
    // Orden estable: dentro de un grupo se conserva el orden en que se declararon.
    return [...commands].sort((a, b) => order(a) - order(b)).slice(0, limit);
  }
  const scored: { command: ProCommand; score: number; index: number }[] = [];
  commands.forEach((command, index) => {
    const score = scoreCommand(query, command);
    if (score !== null) scored.push({ command, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map((entry) => entry.command);
}
