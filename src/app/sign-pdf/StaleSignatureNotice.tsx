import { AlertTriangle } from "lucide-react";

export type StaleSignatureNoticeProps = {
  /** Una frase por firmante cuya firma ya hecha dejo de valer (ya traducida): «La firma de Ana ya no es valida porque...». */
  items: readonly { signerId: string; text: string }[];
};

/**
 * Que paso y quien tiene que volver a firmar (F0-fix, D7): una firma YA hecha dejo de valer porque se cambio el texto del
 * documento (o sus huecos de firma) despues de firmar. Sin esto la persona solo veia al firmante «sin firmar» otra vez y
 * no sabia por que. Es texto de la pagina, no una region viva propia: la ceremonia lo anuncia por la suya (unica).
 */
export function StaleSignatureNotice({ items }: StaleSignatureNoticeProps) {
  if (items.length === 0) return null;
  return (
    <div
      data-stale-signatures=""
      className="rounded-ios-sm flex items-start gap-2 border border-white/10 bg-white/5 p-3"
    >
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive-text" />
      <div className="min-w-0 flex-1 space-y-1 text-footnote font-medium text-foreground">
        {items.map((item) => (
          <p key={item.signerId} data-stale-signer-note={item.signerId} className="[overflow-wrap:anywhere]">
            {item.text}
          </p>
        ))}
      </div>
    </div>
  );
}
