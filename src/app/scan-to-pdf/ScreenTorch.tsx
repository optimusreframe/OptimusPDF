"use client";

import { Sun } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useI18n } from "@/lib/i18n";
import { STRINGS } from "@/app/scan-to-pdf/strings";

export type ScreenTorchProps = {
  active: boolean;
  onChange: (active: boolean) => void;
};

/**
 * Ayuda de iluminacion honesta: no enciende el flash del telefono —los
 * navegadores moviles no lo exponen desde `getUserMedia`— sino que llena
 * la pantalla de blanco alrededor del visor para rebotar luz sobre el
 * documento. Por eso el copy nunca dice "flash".
 */
export function ScreenTorch({ active, onChange }: ScreenTorchProps) {
  const { language } = useI18n();
  const s = STRINGS[language];

  return (
    <>
      {active ? (
        // Blanco literal: el token `white` del proyecto se invierte con el
        // tema claro (ver globals.css) y aqui hace falta luz de verdad. La
        // capa queda por debajo de la tarjeta de la camara, que lleva z-20.
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-10 bg-[#ffffff]"
        />
      ) : null}

      <Button
        variant="ghost"
        size="sm"
        aria-pressed={active}
        onClick={() => onChange(!active)}
      >
        <Sun aria-hidden="true" className="size-3.5" />
        {active ? s.screenTorchOff : s.screenTorchOn}
      </Button>
    </>
  );
}
