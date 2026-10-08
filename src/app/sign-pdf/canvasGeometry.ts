/*
 * Geometria pura del lienzo del paso "Documento" (W2-B). Sin React ni DOM:
 * se prueba aislada y la usan `DocumentCanvas` y `FloatingFieldBar`.
 *
 * - `expandHitTargets`: zonas de toque ampliadas para puntero grueso
 *   (WCAG 2.2 · 2.5.8) que NUNCA se solapan entre si ni invaden la caja de
 *   otro elemento.
 * - `placeFloatingBar`: donde colocar la barra flotante respecto al
 *   elemento seleccionado (arriba o abajo, volteo y desplazamiento).
 * - `findFreeSpot`: donde poner un duplicado.
 */

export type PxRect = { x: number; y: number; width: number; height: number };

export type Insets = { top: number; right: number; bottom: number; left: number };

/* ------------------------------------------------------------------ *
 * Zonas de toque
 * ------------------------------------------------------------------ */

/** Lado ideal (WCAG 2.5.5 AAA, guias de Apple): se intenta cuando hay espacio libre. */
export const IDEAL_TARGET_PX = 44;

type Edges = { l: number; t: number; r: number; b: number };

const toEdges = (rect: PxRect): Edges => ({
  l: rect.x,
  t: rect.y,
  r: rect.x + rect.width,
  b: rect.y + rect.height,
});

const intersects = (a: Edges, b: Edges): boolean =>
  a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;

/**
 * Amplia la zona de toque de cada elemento hasta `target` px por eje
 * (crece solo lo que falta, repartido a ambos lados), sin sobrepasar la
 * pagina, y despues la recorta para que:
 *
 *  1. ninguna zona ampliada invada la caja ORIGINAL de otro elemento, y
 *  2. dos zonas ampliadas nunca se solapen: el espacio libre entre dos
 *     elementos se reparte por la mitad (cada punto de la franja libre
 *     pertenece al elemento mas cercano).
 *
 * Los recortes solo encogen, asi que un solo recorrido por pares basta
 * (encoger nunca crea un solapamiento nuevo). Si las cajas originales de dos
 * elementos ya se solapan entre si no se les impone ninguna restriccion
 * mutua (decide el orden de apilado), pero ninguno invade a un tercero.
 *
 * Devuelve, por id, cuanto crece la zona respecto de la caja (px, >= 0). Con
 * `target` en px de la HOJA: con zoom `z` hay que pasar `24 / z`.
 */
export function expandHitTargets(
  items: ReadonlyArray<{ id: string; rect: PxRect }>,
  page: { width: number; height: number },
  target: number = IDEAL_TARGET_PX,
): Map<string, Insets> {
  const boxes = items.map((item) => toEdges(item.rect));
  const zones: Edges[] = boxes.map((box) => {
    const growX = Math.max(0, target - (box.r - box.l)) / 2;
    const growY = Math.max(0, target - (box.b - box.t)) / 2;
    return {
      l: Math.max(0, box.l - growX),
      r: Math.min(page.width, box.r + growX),
      t: Math.max(0, box.t - growY),
      b: Math.min(page.height, box.b + growY),
    };
  });

  /** Corta `zone` contra la caja `other` por el lado en que `own` y `other` estan separadas. */
  const clipAgainstBox = (zone: Edges, own: Edges, other: Edges) => {
    if (!intersects(zone, other)) return;
    // Eje en el que las cajas estan separadas; si lo estan en los dos, el
    // de menor perdida (el que recorta menos area).
    const options: Array<{ loss: number; apply: () => void }> = [];
    if (own.r <= other.l) {
      options.push({
        loss: zone.r - other.l,
        apply: () => {
          zone.r = Math.min(zone.r, other.l);
        },
      });
    } else if (own.l >= other.r) {
      options.push({
        loss: other.r - zone.l,
        apply: () => {
          zone.l = Math.max(zone.l, other.r);
        },
      });
    }
    if (own.b <= other.t) {
      options.push({
        loss: zone.b - other.t,
        apply: () => {
          zone.b = Math.min(zone.b, other.t);
        },
      });
    } else if (own.t >= other.b) {
      options.push({
        loss: other.b - zone.t,
        apply: () => {
          zone.t = Math.max(zone.t, other.b);
        },
      });
    }
    if (options.length === 0) return; // cajas originales solapadas: sin restriccion
    options.sort((a, b) => a.loss - b.loss)[0].apply();
  };

  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = 0; j < boxes.length; j += 1) {
      if (i === j) continue;
      if (intersects(boxes[i], boxes[j])) continue;
      clipAgainstBox(zones[i], boxes[i], boxes[j]);
    }
  }

  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (intersects(boxes[i], boxes[j])) continue;
      if (!intersects(zones[i], zones[j])) continue;
      // Separacion por el eje de menor perdida; el corte va en el punto
      // medio del hueco libre entre las dos CAJAS (no entre las zonas).
      const a = boxes[i];
      const b = boxes[j];
      const cuts: Array<{ loss: number; apply: () => void }> = [];
      if (a.r <= b.l || b.r <= a.l) {
        const [left, right] = a.r <= b.l ? [i, j] : [j, i];
        const mid = (boxes[left].r + boxes[right].l) / 2;
        cuts.push({
          loss: Math.max(0, zones[left].r - mid) + Math.max(0, mid - zones[right].l),
          apply: () => {
            zones[left].r = Math.min(zones[left].r, mid);
            zones[right].l = Math.max(zones[right].l, mid);
          },
        });
      }
      if (a.b <= b.t || b.b <= a.t) {
        const [top, bottom] = a.b <= b.t ? [i, j] : [j, i];
        const mid = (boxes[top].b + boxes[bottom].t) / 2;
        cuts.push({
          loss: Math.max(0, zones[top].b - mid) + Math.max(0, mid - zones[bottom].t),
          apply: () => {
            zones[top].b = Math.min(zones[top].b, mid);
            zones[bottom].t = Math.max(zones[bottom].t, mid);
          },
        });
      }
      if (cuts.length > 0) cuts.sort((x, y) => x.loss - y.loss)[0].apply();
    }
  }

  const result = new Map<string, Insets>();
  items.forEach((item, index) => {
    const box = boxes[index];
    const zone = zones[index];
    result.set(item.id, {
      top: Math.max(0, box.t - zone.t),
      right: Math.max(0, zone.r - box.r),
      bottom: Math.max(0, zone.b - box.b),
      left: Math.max(0, box.l - zone.l),
    });
  });
  return result;
}

/* ------------------------------------------------------------------ *
 * Barra flotante
 * ------------------------------------------------------------------ */

export type BarSide = "top" | "bottom" | "overlay";

export type BarPlacementInput = {
  /** Caja del elemento seleccionado en coordenadas de la ventana (ya con zoom). */
  anchor: PxRect;
  /** Lo que sobresale del elemento por cada lado (etiqueta arriba, tirador abajo a la derecha). */
  anchorPad?: Partial<Insets>;
  /** Tamano de la barra. */
  bar: { width: number; height: number };
  /** Hoja visible (el elemento anfitrion), para voltear cerca de sus bordes. */
  page: PxRect;
  /** Region util de la ventana: sin cabecera fija ni barras fijas inferiores. */
  safe: PxRect;
  /** Limites horizontales del escenario (el contenedor del lienzo). */
  stage: { left: number; right: number };
  /** Separacion entre el elemento y la barra. */
  gap?: number;
  /** Lado preferido cuando caben los dos. */
  prefer?: "top" | "bottom";
};

export type BarPlacement = { x: number; y: number; side: BarSide };

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * Coloca la barra arriba o abajo del elemento, centrada sobre el y
 * desplazada para no salirse del escenario ni de la ventana. Orden de
 * preferencia (la primera opcion que cabe):
 *
 *  1. el lado preferido dentro de la hoja visible,
 *  2. el otro lado dentro de la hoja visible,
 *  3. el lado preferido dentro de la ventana util (fuera de la hoja),
 *  4. el otro lado dentro de la ventana util,
 *  5. superpuesta (`overlay`): pegada al borde util mas cercano al
 *     elemento. Solo ocurre con ventanas diminutas; no tapa el elemento si
 *     queda sitio a algun lado, y si no, cubre lo minimo.
 *
 * Nunca tapa la caja del elemento salvo en el caso 5.
 */
export function placeFloatingBar(input: BarPlacementInput): BarPlacement {
  const { anchor, bar, page, safe, stage } = input;
  const gap = input.gap ?? 8;
  const pad: Insets = { top: 0, right: 0, bottom: 0, left: 0, ...input.anchorPad };
  const prefer = input.prefer ?? "top";
  const other = prefer === "top" ? "bottom" : "top";

  const xMin = Math.max(stage.left, safe.x);
  const xMax = Math.min(stage.right, safe.x + safe.width) - bar.width;
  const centered = anchor.x + anchor.width / 2 - bar.width / 2;
  const x = xMax >= xMin ? clampNumber(centered, xMin, xMax) : xMin;

  const anchorTop = anchor.y - pad.top;
  const anchorBottom = anchor.y + anchor.height + pad.bottom;
  const yTop = anchorTop - gap - bar.height;
  const yBottom = anchorBottom + gap;

  const safeTop = safe.y;
  const safeBottom = safe.y + safe.height;
  const pageTop = Math.max(page.y, safeTop);
  const pageBottom = Math.min(page.y + page.height, safeBottom);

  const fits = (side: "top" | "bottom", top: number, bottom: number): boolean => {
    const y = side === "top" ? yTop : yBottom;
    return y >= top && y + bar.height <= bottom;
  };
  const yOf = (side: "top" | "bottom") => (side === "top" ? yTop : yBottom);

  for (const side of [prefer, other] as const) {
    if (fits(side, pageTop, pageBottom)) return { x, y: yOf(side), side };
  }
  for (const side of [prefer, other] as const) {
    if (fits(side, safeTop, safeBottom)) return { x, y: yOf(side), side };
  }

  // Ningun lado cabe entero: el que mas espacio tenga, pegado al borde util.
  const spaceAbove = anchorTop - safeTop;
  const spaceBelow = safeBottom - anchorBottom;
  const side: "top" | "bottom" =
    spaceAbove === spaceBelow ? prefer : spaceAbove > spaceBelow ? "top" : "bottom";
  const y = clampNumber(yOf(side), safeTop, Math.max(safeTop, safeBottom - bar.height));
  return { x, y, side: "overlay" };
}

/* ------------------------------------------------------------------ *
 * Duplicados
 * ------------------------------------------------------------------ */

type NormalizedLike = { x: number; y: number; width: number; height: number };

const overlapsNormalized = (a: NormalizedLike, b: NormalizedLike): boolean =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;

/**
 * Sitio para la copia de `rect` (fracciones de pagina): primero justo debajo,
 * luego arriba, a la derecha y a la izquierda, siempre dentro de la pagina y
 * sin pisar a `others`; si no hay hueco libre, un desplazamiento diagonal
 * pequeno (la copia queda visible y se distingue del original).
 */
export function findFreeSpot(
  rect: NormalizedLike,
  others: readonly NormalizedLike[],
  gap = 0.008,
): NormalizedLike {
  const inside = (candidate: NormalizedLike) =>
    candidate.x >= 0 &&
    candidate.y >= 0 &&
    candidate.x + candidate.width <= 1 &&
    candidate.y + candidate.height <= 1;
  const candidates: NormalizedLike[] = [
    { ...rect, y: rect.y + rect.height + gap },
    { ...rect, y: rect.y - rect.height - gap },
    { ...rect, x: rect.x + rect.width + gap },
    { ...rect, x: rect.x - rect.width - gap },
  ];
  for (const candidate of candidates) {
    if (inside(candidate) && !others.some((other) => overlapsNormalized(candidate, other))) {
      return candidate;
    }
  }
  const dx = Math.min(0.03, Math.max(0, 1 - rect.width - rect.x));
  const dy = Math.min(0.03, Math.max(0, 1 - rect.height - rect.y));
  if (dx > 0.005 || dy > 0.005) {
    return { ...rect, x: rect.x + dx, y: rect.y + dy };
  }
  return { ...rect, x: Math.max(0, rect.x - 0.03), y: Math.max(0, rect.y - 0.03) };
}
