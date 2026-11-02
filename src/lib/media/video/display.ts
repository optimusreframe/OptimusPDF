/** Duracion legible: `0:07`, `2:05`, `1:02:03`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (value: number) => String(value).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** Fotogramas por segundo sin ruido decimal: 30, 29,97 -> «29.97», 24 -> «24». */
export function formatFps(fps: number | null): string | null {
  if (fps === null || !(fps > 0)) return null;
  const rounded = Math.round(fps * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, "");
}

/** Medidas «1920 × 1080». */
export function formatDimensions(width: number, height: number): string {
  return `${width} × ${height}`;
}
