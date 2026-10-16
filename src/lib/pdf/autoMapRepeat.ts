/*
 * Repeticion entre paginas (senal «c» del automapeo): una raya corta o casilla SIN etiqueta que aparece en casi
 * todas las paginas del cuerpo en una posicion casi identica es, con mucha probabilidad, la raya de iniciales de
 * pie de pagina. Se agrupan por posicion normalizada con tolerancia (agrupamiento voraz por centroide).
 */

import type { LineInfo, PageAnalysis, RepeatPoint } from "@/lib/pdf/autoMapPage";

export type RepeatOptions = {
  /** Tolerancia de posicion (fraccion de pagina). */
  tolX: number;
  tolY: number;
  /** Diferencia maxima de largo entre miembros (fraccion del largo medio). */
  widthTolerance: number;
  /** Un grupo vale si cubre al menos esta fraccion de las paginas con texto... */
  minPageRatio: number;
  /** ... y al menos este numero de paginas. */
  minPages: number;
};

export const DEFAULT_REPEAT: RepeatOptions = {
  tolX: 0.025,
  tolY: 0.02,
  widthTolerance: 0.35,
  minPageRatio: 0.6,
  minPages: 2,
};

export type RepeatCluster = {
  members: Array<{ point: RepeatPoint; page: PageAnalysis }>;
  /** Centroide normalizado (y desde arriba). */
  cx: number;
  cy: number;
  width: number;
  pageRatio: number;
};

type Working = { members: Array<{ point: RepeatPoint; page: PageAnalysis; nx: number; ny: number; nw: number }>; cx: number; cy: number; width: number };

function normalized(point: RepeatPoint, page: PageAnalysis) {
  return {
    nx: (point.x0 + point.x1) / 2 / page.width,
    ny: 1 - point.y / page.height,
    nw: (point.x1 - point.x0) / page.width,
  };
}

/** Agrupa las rayas cortas sin etiqueta de todas las paginas y devuelve los grupos que se repiten lo bastante. */
export function clusterRepeats(pages: readonly PageAnalysis[], options: RepeatOptions = DEFAULT_REPEAT): RepeatCluster[] {
  const bodyPages = pages.filter((page) => page.hasText);
  if (bodyPages.length < 2) return [];
  const clusters: Working[] = [];
  for (const page of bodyPages) {
    // Un grupo admite como mucho una raya por pagina.
    const usedInPage = new Set<Working>();
    for (const point of page.unlabeledShortLines) {
      const n = normalized(point, page);
      let best: { cluster: Working; distance: number } | null = null;
      for (const cluster of clusters) {
        if (usedInPage.has(cluster)) continue;
        const dx = Math.abs(cluster.cx - n.nx);
        const dy = Math.abs(cluster.cy - n.ny);
        if (dx > options.tolX || dy > options.tolY) continue;
        if (Math.abs(cluster.width - n.nw) > options.widthTolerance * Math.max(cluster.width, n.nw)) continue;
        const distance = dx / options.tolX + dy / options.tolY;
        if (!best || distance < best.distance) best = { cluster, distance };
      }
      if (best) {
        const cluster = best.cluster;
        cluster.members.push({ point, page, ...n });
        const count = cluster.members.length;
        cluster.cx = cluster.members.reduce((sum, m) => sum + m.nx, 0) / count;
        cluster.cy = cluster.members.reduce((sum, m) => sum + m.ny, 0) / count;
        cluster.width = cluster.members.reduce((sum, m) => sum + m.nw, 0) / count;
        usedInPage.add(cluster);
      } else {
        const created: Working = { members: [{ point, page, ...n }], cx: n.nx, cy: n.ny, width: n.nw };
        clusters.push(created);
        usedInPage.add(created);
      }
    }
  }
  const minPages = Math.max(options.minPages, Math.ceil(options.minPageRatio * bodyPages.length));
  return clusters
    .filter((cluster) => cluster.members.length >= minPages)
    .map((cluster) => ({
      members: cluster.members.map((m) => ({ point: m.point, page: m.page })),
      cx: cluster.cx,
      cy: cluster.cy,
      width: cluster.width,
      pageRatio: cluster.members.length / bodyPages.length,
    }))
    .sort((a, b) => b.pageRatio - a.pageRatio);
}

export type { LineInfo };
