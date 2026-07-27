"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Info,
  KeyRound,
  Scale,
  ShieldAlert,
  ShieldCheck,
  Signature,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { PasswordField } from "@/app/protect-pdf/PasswordField";
import { Checkbox } from "@/components/ui/Checkbox";
import { Spinner } from "@/components/ui/Spinner";
import { UNLOCK_STRINGS, type UnlockStrings } from "@/app/unlock-pdf/strings";
import { useI18n } from "@/lib/i18n";
import {
  MAX_SAFE_FILE_SIZE,
  withSuffix,
  type ProgressCallback,
} from "@/lib/pdf/core";
import {
  DEFAULT_UNLOCK_OPTIONS,
  UnlockError,
  inspectProtection,
  removeProtection,
  type ProtectionProfile,
  type UnlockFailure,
  type UnlockOptions,
} from "@/lib/pdf/unlock";
import { getTool } from "@/lib/tools-registry";

const TOOL = getTool("unlock-pdf");

/**
 * Identidad del archivo elegido: el propio objeto `File`, comparado con
 * `===`.
 *
 * Antes se usaba una clave derivada (`nombre:tamano:ultimaModificacion`).
 * Esa terna puede coincidir entre dos PDFs distintos —mismo nombre, mismo
 * tamano, misma marca de tiempo—, y entonces el consentimiento dado para
 * uno se habria dado por valido para el otro. La identidad de objeto de
 * JavaScript no puede colisionar: cada seleccion del usuario produce un
 * `File` nuevo, asi que en cuanto cambia el archivo todo lo aceptado para
 * el anterior deja de coincidir en el mismo render, sin ventana en la que
 * un efecto todavia no haya corrido.
 */

/**
 * Estado de la inspeccion, siempre etiquetado con el archivo al que
 * pertenece. `failed` es un estado propio y no un `profile` nulo: cuando
 * no se ha podido leer la estructura NO se puede afirmar que el documento
 * sea seguro de procesar, asi que el boton se queda apagado.
 */
type Inspection =
  | { status: "idle"; file: null }
  | { status: "pending"; file: File }
  | { status: "ready"; file: File; profile: ProtectionProfile }
  | { status: "failed"; file: File };

/**
 * Puente entre el archivo que gobierna `ToolShell` y el estado de esta
 * herramienta. `ToolShell` es el dueno de la lista de archivos y solo la
 * expone al renderizar, asi que este componente sin pintura avisa cuando
 * cambia el primero.
 *
 * El componente se desmonta mientras se procesa y vuelve a montarse al
 * terminar; por eso solo publica el `File` y es el padre —que nunca se
 * desmonta— quien decide si hay que inspeccionar de nuevo. Asi un error
 * de contrasena no se borra solo al volver al area de trabajo.
 */
function FileWatcher({
  file,
  setOptions,
  onFile,
}: {
  file: File | undefined;
  setOptions: (patch: Partial<UnlockOptions>) => void;
  onFile: (
    file: File | null,
    setOptions: (patch: Partial<UnlockOptions>) => void,
  ) => void;
}) {
  useEffect(() => {
    onFile(file ?? null, setOptions);
  }, [file, onFile, setOptions]);
  return null;
}

/** Bloque explicativo con icono, del mismo formato para los cuatro casos. */
function ProtectionNotice({
  icon: Icon,
  tone,
  title,
  body,
  children,
}: {
  icon: LucideIcon;
  tone: "security" | "warning" | "neutral";
  title: string;
  body: string;
  children?: ReactNode;
}) {
  const iconClass =
    tone === "warning"
      ? "text-destructive"
      : tone === "security"
        ? "text-accent-security"
        : "text-muted-foreground";

  return (
    <div className="flex items-start gap-3">
      <Icon
        aria-hidden="true"
        className={cn("mt-0.5 size-5 shrink-0", iconClass)}
      />
      <div className="min-w-0">
        <h3 className="hud-label text-[11px] text-foreground">{title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {body}
        </p>
        {children}
      </div>
    </div>
  );
}

/** Elige el bloque que corresponde al perfil detectado. */
function ProtectionSummary({
  s,
  profile,
  inspecting,
  passwordRequired,
}: {
  s: UnlockStrings;
  profile: ProtectionProfile | null;
  inspecting: boolean;
  passwordRequired: boolean;
}) {
  if (inspecting) {
    return (
      <div className="flex items-center gap-3">
        <Spinner />
        <p className="text-sm text-muted-foreground">{s.inspecting}</p>
      </div>
    );
  }

  if (!profile) {
    return (
      <ProtectionNotice
        icon={Info}
        tone="neutral"
        title={s.infoTitle}
        body={s.infoBody}
      />
    );
  }

  if (profile.encryptionFilter === "unsupported") {
    // `/Adobe.PubSec` es el unico esquema del que podemos afirmar que es
    // un certificado; cualquier otro filtro solo es desconocido.
    const isCertificate = profile.securityHandler === "/Adobe.PubSec";
    return (
      <ProtectionNotice
        icon={ShieldAlert}
        tone="warning"
        title={isCertificate ? s.certificateTitle : s.unsupportedHandlerTitle}
        body={isCertificate ? s.certificateBody : s.unsupportedHandlerBody}
      />
    );
  }

  if (profile.encrypted) {
    // Tras un intento fallido el mensaje cambia: ya sabemos que la
    // contrasena vacia no vale y que hace falta una de verdad.
    return (
      <ProtectionNotice
        icon={KeyRound}
        tone="security"
        title={passwordRequired ? s.passwordNeededTitle : s.standardTitle}
        body={passwordRequired ? s.passwordNeededBody : s.standardBody}
      />
    );
  }

  if (profile.hasSignatureRestrictions) {
    return (
      <ProtectionNotice
        icon={Signature}
        tone="security"
        title={s.signaturesTitle}
        body={s.signaturesBody}
      />
    );
  }

  return (
    <ProtectionNotice
      icon={ShieldCheck}
      tone="neutral"
      title={s.noProtectionTitle}
      body={s.noProtectionBody}
    />
  );
}

export function UnlockToolClient() {
  const { language } = useI18n();
  const s = UNLOCK_STRINGS[language];

  const [failure, setFailure] = useState<UnlockFailure | null>(null);
  /**
   * Se enciende cuando el intento sin contrasena falla y ya no se apaga
   * mientras siga el mismo archivo: el campo debe seguir en pantalla
   * mientras el usuario escribe, aunque el mensaje de error se limpie.
   */
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [inspection, setInspection] = useState<Inspection>({
    status: "idle",
    file: null,
  });
  /**
   * Archivo EXACTO para el que el usuario acepto invalidar las firmas. No
   * es un booleano a proposito: un booleano sobrevive al cambio de archivo
   * si algo falla al limpiarlo. Y no es una clave derivada de metadatos,
   * porque dos PDFs distintos pueden compartirlos; una referencia de
   * objeto no puede pertenecer a otro archivo.
   */
  const [consentedFile, setConsentedFile] = useState<File | null>(null);

  /** Ultimo archivo atendido, para no reinspeccionar en cada remontaje. */
  const attendedFileRef = useRef<File | null>(null);

  const handleFile = useCallback(
    (next: File | null, setOptions: (patch: Partial<UnlockOptions>) => void) => {
      // Mismo objeto: no se reinspecciona ni se borra el error de
      // contrasena solo porque el area de trabajo se vuelva a montar.
      if (attendedFileRef.current === next) return;
      attendedFileRef.current = next;
      setFailure(null);
      setPasswordRequired(false);
      setConsentedFile(null);
      // El campo de contrasena se oculta al cambiar de archivo, pero
      // ocultarlo no vacia su valor: `ToolShell` conserva las opciones
      // entre archivos. Sin este reinicio el siguiente PDF se intentaria
      // abrir con la contrasena del anterior en vez de con `""`, que es lo
      // que el flujo promete probar primero.
      setOptions({ password: "" });
      setInspection(
        next ? { status: "pending", file: next } : { status: "idle", file: null },
      );
    },
    [],
  );

  useEffect(() => {
    if (inspection.status !== "pending") return;
    const { file } = inspection;

    let cancelled = false;
    inspectProtection(file)
      .then((profile) => {
        if (cancelled) return;
        setInspection((previous) =>
          previous.file === file ? { status: "ready", file, profile } : previous,
        );
      })
      .catch(() => {
        // No se ha podido leer la estructura: no se afirma nada sobre el
        // documento y el procesado queda deshabilitado.
        if (cancelled) return;
        setInspection((previous) =>
          previous.file === file ? { status: "failed", file } : previous,
        );
      });

    return () => {
      cancelled = true;
    };
  }, [inspection]);

  const process = useCallback(
    async (
      files: File[],
      options: UnlockOptions,
      onProgress: ProgressCallback,
    ): Promise<ProcessResult> => {
      const file = files[0];
      setFailure(null);
      try {
        const { blob, action } = await removeProtection(
          file,
          {
            ...options,
            // El consentimiento viaja al motor atado al archivo concreto:
            // si no es EXACTAMENTE el objeto para el que se acepto, no hay
            // consentimiento que valga.
            acknowledgeSignatureInvalidation: consentedFile === file,
          },
          onProgress,
        );
        const suffix =
          action === "passwordRemoved"
            ? s.filenameSuffix
            : s.filenameSuffixSignatures;
        return { blob, filename: withSuffix(file.name, suffix) };
      } catch (error) {
        // El motivo exacto se muestra en el panel; `ToolShell` recibe el
        // error tal cual para volver al area de trabajo.
        if (error instanceof UnlockError) {
          setFailure(error.reason);
          if (error.reason === "wrongPassword") setPasswordRequired(true);
        }
        throw error;
      }
    },
    [consentedFile, s.filenameSuffix, s.filenameSuffixSignatures],
  );

  /**
   * Se procesa unicamente con una inspeccion resuelta CON EXITO y que
   * pertenezca al archivo que se va a procesar. Cualquier otro estado
   * —sin archivo, inspeccion en curso, inspeccion fallida, o perfil de un
   * archivo anterior— deja el boton apagado: fallar cerrado.
   */
  const canRun = useCallback(
    (files: File[]) => {
      const file = files[0];
      if (!file) return false;
      if (inspection.status !== "ready" || inspection.file !== file) {
        return false;
      }

      const { profile } = inspection;
      if (profile.encryptionFilter === "unsupported") return false;
      if (!profile.encrypted && !profile.hasSignatureRestrictions) return false;
      if (profile.hasSignatureRestrictions) return consentedFile === file;
      return true;
    },
    [consentedFile, inspection],
  );

  return (
    <ToolShell<UnlockOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_UNLOCK_OPTIONS}
      process={process}
      canRun={canRun}
      renderMain={({ files, setOptions }) => {
        const file = files[0] ?? null;
        // Solo se muestra el perfil del archivo que hay ahora mismo en el
        // area de trabajo. Con otro objeto —o sin resolver— se pinta el
        // estado neutro, nunca la lectura del archivo anterior.
        const current =
          inspection.status === "ready" && inspection.file === file
            ? inspection.profile
            : null;
        const inspecting =
          inspection.status === "pending" ||
          (file !== null && inspection.file !== file);
        const showSignatureConsent = current?.hasSignatureRestrictions ?? false;

        return (
          <>
            <FileWatcher
              file={files[0]}
              setOptions={setOptions}
              onFile={handleFile}
            />

            <section className="glass rounded-ios p-5">
              <ProtectionSummary
                s={s}
                profile={current}
                inspecting={inspecting}
                passwordRequired={passwordRequired}
              />

              {showSignatureConsent && file !== null ? (
                <div className="rounded-ios mt-4 border border-destructive/40 bg-destructive/10 p-4">
                  <p className="text-sm leading-relaxed text-foreground">
                    {s.signaturesWarning}
                  </p>
                  <Checkbox
                    className="mt-4"
                    label={s.signaturesConsent}
                    hint={s.signaturesConsentHint}
                    checked={consentedFile === file}
                    onChange={(accepted) =>
                      setConsentedFile(accepted ? file : null)
                    }
                  />
                </div>
              ) : null}

              <div className="rounded-ios mt-4 flex items-start gap-3 border border-white/10 bg-white/5 p-4">
                <Scale
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                />
                <p className="text-xs leading-relaxed text-foreground">
                  {s.legalNote}
                </p>
              </div>

              {failure ? (
                <p role="alert" className="mt-4 text-sm text-destructive">
                  {s.errors[failure]}
                </p>
              ) : null}
            </section>
          </>
        );
      }}
      renderOptions={({ files, options, setOptions }) => (
        <>
          {passwordRequired ? (
            <PasswordField
              label={s.passwordLabel}
              value={options.password}
              onChange={(password) => {
                setFailure(null);
                setOptions({ password });
              }}
              showLabel={s.showPassword}
              hideLabel={s.hidePassword}
              autoComplete="current-password"
              invalid={failure === "wrongPassword"}
              hint={s.passwordHint}
            />
          ) : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {s.infoBody}
            </p>
          )}

          {files[0] && files[0].size > MAX_SAFE_FILE_SIZE ? (
            <p className="text-xs leading-relaxed text-destructive">
              {s.largeFile}
            </p>
          ) : null}
        </>
      )}
    />
  );
}
