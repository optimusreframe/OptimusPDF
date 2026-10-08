import { cn } from "@/lib/cn";

export type SpinnerProps = {
  className?: string;
  label?: string;
};

/*
 * Indicador de actividad al estilo UIActivityIndicator: ocho radios con
 * opacidad graduada que giran con `animate-spin`. Bajo
 * prefers-reduced-motion el token --animate-spin pasa a `none`
 * (globals.css), asi que queda estatico y el estado de carga se sigue
 * comunicando por `label`/role="status".
 */
const SPOKES = Array.from({ length: 8 }, (_, index) => index);

export function Spinner({ className, label }: SpinnerProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden={label ? undefined : "true"}
      aria-label={label}
      role={label ? "status" : undefined}
      className={cn(
        "size-5 shrink-0 animate-spin text-muted-foreground",
        className,
      )}
    >
      {SPOKES.map((index) => (
        <rect
          key={index}
          x="11"
          y="2"
          width="2"
          height="6.5"
          rx="1"
          opacity={(index + 1) / SPOKES.length}
          transform={`rotate(${index * 45} 12 12)`}
        />
      ))}
    </svg>
  );
}
