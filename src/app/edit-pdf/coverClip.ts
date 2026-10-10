import type { CoverShape } from "@/lib/pdf/editCover";

/**
 * Recorte de la vista previa de una cobertura GIRADA con huecos (W5-U5): la exportacion pinta el
 * rectangulo girado MENOS los poligonos de los vecinos (relleno par-impar). En la vista previa el
 * rectangulo es un `div` girado; este `clip-path: path(evenodd, ...)` esta en el sistema LOCAL del
 * `div` (x a lo largo del texto, y hacia abajo, en px), asi que se lleva cada vertice del hueco
 * (espacio de usuario) a esa base. `null` si no hay huecos.
 */
export function orientedClipPath(
  shape: Extract<CoverShape, { kind: "oriented" }>,
  scale: number,
): string | null {
  if (!shape.holes || shape.holes.length === 0) return null;
  const radians = (shape.rotation * Math.PI) / 180;
  const ux = Math.cos(radians);
  const uy = Math.sin(radians);
  const round = (value: number) => Math.round(value * 100) / 100;
  const local = (point: { x: number; y: number }) => {
    const rx = point.x - shape.origin.x;
    const ry = point.y - shape.origin.y;
    const along = rx * ux + ry * uy;
    const up = -rx * uy + ry * ux; // hacia «arriba» del texto desde el borde inferior
    return `${round(along * scale)} ${round((shape.height - up) * scale)}`;
  };
  const width = round(shape.width * scale);
  const height = round(shape.height * scale);
  const outer = `M0 0H${width}V${height}H0Z`;
  const holes = shape.holes
    .filter((hole) => hole.polygon.length >= 3)
    .map((hole) => `M${hole.polygon.map(local).join("L")}Z`);
  return holes.length === 0 ? null : `path(evenodd, "${outer} ${holes.join(" ")}")`;
}
