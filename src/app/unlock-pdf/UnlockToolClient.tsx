"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Info,
  KeyRound,
  Scale,
  ShieldAlert,
  ShieldCheck,
  Signature,
} from "lucide-react";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { PasswordField } from "@/app/protect-pdf/PasswordField";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Spinner } from "@/components/ui/Spinner";
import { ProtectionNotice } from "@/app/unlock-pdf/ProtectionNotice";
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
  type CompleteProtectionProfile,
  type UnsupportedEncryptionInfo,
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
 * pertenece.
 *
 * No se guarda ningun `PDFDocument` descifrado aqui: solo la contrasena
 * viaja en `options` y el perfil ya resuelto (planos, serializables).
 * `removeProtection` vuelve a cargar y a verificar desde cero al
 * procesar, que es la barrera de seguridad real; este estado es
 * unicamente para decidir que pintar.
 *
 * - `"pending"` / `"validating"`: inspeccion en curso (automatica o
 *   tras pulsar "Abrir y comprobar").
 * - `"ready"`: documento genuinamente accesible, con perfil completo.
 * - `"passwordRequired"`: el intento automatico con contrasena vacia no
 *   abrio el documento; hace falta una de verdad.
 * - `"unsupported"`: manejador de cifrado que esta herramienta no sabe
 *   abrir (certificado digital u otro).
 * - `"failed"`: la estructura no se pudo comprobar con seguridad
 *   (`inspectionIncomplete`) u otro error de lectura. Fallar cerrado: el
 *   boton de procesar se queda apagado.
 */
type Inspection =
  | { status: "idle"; file: null }
  | { status: "pending"; file: File }
  | { status: "validating"; file: File }
  | { status: "ready"; file: File; profile: CompleteProtectionProfile }
  | { status: "passwordRequired"; file: File }
  | { status: "unsupported"; file: File; encryption: UnsupportedEncryptionInfo }
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

/** Estado con spinner: inspeccionando o comprobando una contrasena. */
function ProtectionSpinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <Spinner />
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}

/** Elige el bloque que corresponde al estado de inspeccion actual. */
function ProtectionSummary({
  s,
  file,
  inspection,
}: {
  s: UnlockStrings;
  file: File | null;
  inspection: Inspection;
}) {
  // Sin archivo, o inspeccion de un archivo anterior que todavia no se
  // ha limpiado en este render: estado neutro, nunca datos obsoletos.
  if (!file || inspection.file !== file) {
    return (
      <ProtectionNotice
        icon={Info}
        tone="neutral"
        title={s.infoTitle}
        body={s.infoBody}
      />
    );
  }

  if (inspection.status === "pending") {
    return <ProtectionSpinner label={s.inspecting} />;
  }

  if (inspection.status === "validating") {
    return <ProtectionSpinner label={s.checkingPassword} />;
  }

  if (inspection.status === "failed") {
    return (
      <ProtectionNotice
        icon={ShieldAlert}
        tone="warning"
        title={s.infoTitle}
        body={s.errors.inspectionIncomplete}
      />
    );
  }

  if (inspection.status === "unsupported") {
    // `/Adobe.PubSec` es el unico esquema del que podemos afirmar que es
    // un certificado; cualquier otro filtro solo es desconocido.
    const isCertificate = inspection.encryption.securityHandler === "/Adobe.PubSec";
    return (
      <ProtectionNotice
        icon={ShieldAlert}
        tone="warning"
        title={isCertificate ? s.certificateTitle : s.unsupportedHandlerTitle}
        body={isCertificate ? s.certificateBody : s.unsupportedHandlerBody}
      />
    );
  }

  if (inspection.status === "passwordRequired") {
    return (
      <ProtectionNotice
        icon={KeyRound}
        tone="security"
        title={s.passwordNeededTitle}
        body={s.passwordNeededBody}
      />
    );
  }

  // inspection.status === "ready"
  const { profile } = inspection;

  if (profile.encrypted) {
    return (
      <ProtectionNotice
        icon={KeyRound}
        tone="security"
        title={s.standardTitle}
        body={s.standardBody}
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

  // `profile.hasActiveSignatures` en solitario (sin cifrado y sin
  // restriccion de firma real) no cuenta como "algo que hacer": es la
  // decision de producto de la ronda 6 en el motor (`unlock.ts`,
  // "notProtected" para ese caso exacto). No se pinta un estado propio
  // para ella; cae al mismo aviso neutro que "sin proteccion".
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

  /**
   * Contador creciente que identifica cada intento de validar una
   * contrasena escrita a mano (`checkPassword`). Si el usuario edita la
   * contrasena MIENTRAS una validacion anterior sigue en curso, esa
   * edicion incrementa el contador; cuando la validacion vieja por fin
   * resuelve, su numero ya no coincide con el actual y su resultado se
   * descarta. Sin esto, una respuesta tardia de la contrasena ANTERIOR
   * podia sobreescribir el estado con un perfil "ready" que en realidad
   * no corresponde a lo que el campo muestra ahora.
   */
  const validationSeqRef = useRef(0);

  const handleFile = useCallback(
    (next: File | null, setOptions: (patch: Partial<UnlockOptions>) => void) => {
      // Mismo objeto: no se reinspecciona ni se borra el error de
      // contrasena solo porque el area de trabajo se vuelva a montar.
      if (attendedFileRef.current === next) return;
      attendedFileRef.current = next;
      setFailure(null);
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

  // Inspeccion automatica: se prueba SIEMPRE la contrasena vacia primero,
  // sin que el usuario tenga que pedirlo.
  useEffect(() => {
    if (inspection.status !== "pending") return;
    const { file } = inspection;

    let cancelled = false;
    inspectProtection(file)
      .then((result) => {
        if (cancelled || attendedFileRef.current !== file) return;
        if (result.kind === "ready") {
          setInspection({ status: "ready", file, profile: result.profile });
        } else if (result.kind === "passwordRequired") {
          setInspection({ status: "passwordRequired", file });
        } else {
          setInspection({ status: "unsupported", file, encryption: result.encryption });
        }
      })
      .catch(() => {
        // No se ha podido leer la estructura con seguridad: no se afirma
        // nada sobre el documento y el procesado queda deshabilitado.
        if (cancelled || attendedFileRef.current !== file) return;
        setInspection({ status: "failed", file });
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
        // error tal cual para volver al area de trabajo. `removeProtection`
        // vuelve a analizar el documento desde cero, asi que si discrepa
        // de lo que la inspeccion previa mostraba, el estado local se
        // corrige aqui en vez de dejar pintado un perfil que ya no vale.
        if (error instanceof UnlockError) {
          setFailure(error.reason);
          if (error.reason === "wrongPassword") {
            setInspection({ status: "passwordRequired", file });
            setConsentedFile(null);
          } else if (error.reason === "inspectionIncomplete") {
            setInspection({ status: "failed", file });
          }
        }
        throw error;
      }
    },
    [consentedFile, s.filenameSuffix, s.filenameSuffixSignatures],
  );

  /**
   * Se procesa unicamente con una inspeccion resuelta CON EXITO
   * (`"ready"`) y que pertenezca al archivo que se va a procesar.
   * Cualquier otro estado —sin archivo, inspeccion en curso, contrasena
   * pendiente, manejador no soportado, inspeccion fallida, o perfil de
   * un archivo anterior— deja el boton apagado: fallar cerrado.
   */
  const canRun = useCallback(
    (files: File[]) => {
      const file = files[0];
      if (!file) return false;
      if (inspection.status !== "ready" || inspection.file !== file) {
        return false;
      }

      const { profile } = inspection;
      // Matriz de decision (debe seguir exactamente a la del motor en
      // `unlock.ts`): primero, ¿hay algo que hacer? Sin cifrado y sin
      // restriccion de firma real no hay operacion que ofrecer, aunque
      // haya una firma activa sin restriccion (decision de producto de
      // la ronda 6): el motor devolveria `notProtected`.
      const hasSomethingToDo = profile.encrypted || profile.hasSignatureRestrictions;
      if (!hasSomethingToDo) return false;
      // Solo si hay algo que hacer tiene sentido preguntar si ademas hace
      // falta consentimiento: guardar el documento invalida cualquier
      // firma activa, restrinja o no cambios, asi que se necesita el
      // mismo consentimiento en ambos casos.
      const needsSignatureConsent =
        profile.hasSignatureRestrictions || profile.hasActiveSignatures;
      if (needsSignatureConsent) return consentedFile === file;
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
      // Desbloquear recibe PDF cifrados a proposito: tiene su propio flujo de contrasena.
      inputPolicy={{ encrypted: "allow" }}
      renderMain={({ files, setOptions }) => {
        const file = files[0] ?? null;
        const current =
          inspection.status === "ready" && inspection.file === file
            ? inspection.profile
            : null;
        // Misma matriz que `canRun`: el panel de consentimiento solo
        // aparece cuando hay algo que hacer (cifrado o restriccion real
        // de firma) Y ademas, por eso, hace falta consentimiento (firma
        // restrictiva o activa). Una firma activa sin restriccion, sin
        // cifrado, no cuenta como "algo que hacer" por si sola: no se le
        // ofrece al usuario el checkbox para invalidar una firma que no
        // le impedia nada.
        const hasSomethingToDo =
          (current?.encrypted || current?.hasSignatureRestrictions) ?? false;
        const showSignatureConsent =
          hasSomethingToDo &&
          ((current?.hasSignatureRestrictions || current?.hasActiveSignatures) ?? false);
        // Solo para elegir el texto de advertencia: distingue "esta firma
        // te impedia editar" de "esta firma no te impedia editar, pero se
        // invalida igual al guardar".
        const signatureWasRestrictive = current?.hasSignatureRestrictions ?? false;

        return (
          <>
            <FileWatcher
              file={files[0]}
              setOptions={setOptions}
              onFile={handleFile}
            />

            <section className="surface-card rounded-ios p-5">
              <ProtectionSummary s={s} file={file} inspection={inspection} />

              {showSignatureConsent && file !== null ? (
                <div className="rounded-ios mt-4 border border-destructive/40 bg-destructive/10 p-4">
                  <p className="text-sm leading-relaxed text-foreground">
                    {signatureWasRestrictive ? s.signaturesWarning : s.activeSignatureWarning}
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
      renderOptions={({ files, options, setOptions }) => {
        const file = files[0] ?? null;
        // El campo de contrasena solo tiene sentido mientras se sabe (o se
        // sospecha) que el documento es de cifrado estandar: pendiente de
        // contrasena real, comprobandola, o ya listo pero cifrado (para
        // poder corregirla). En cualquier otro estado no aporta nada.
        const showPasswordField =
          file !== null &&
          inspection.file === file &&
          (inspection.status === "passwordRequired" ||
            inspection.status === "validating" ||
            (inspection.status === "ready" && inspection.profile.encrypted));

        const canCheckPassword =
          file !== null && inspection.status === "passwordRequired";

        const checkPassword = async () => {
          if (!file || inspection.status !== "passwordRequired") return;
          setFailure(null);
          // Se reserva este intento con un numero propio: si el usuario
          // edita la contrasena antes de que la respuesta llegue, ese
          // numero deja de ser el actual y el resultado se descarta en vez
          // de pintar un perfil que ya no corresponde a lo que hay escrito.
          const seq = (validationSeqRef.current += 1);
          setInspection({ status: "validating", file });
          try {
            const result = await inspectProtection(file, {
              password: options.password,
            });
            if (attendedFileRef.current !== file || validationSeqRef.current !== seq) return;
            if (result.kind === "ready") {
              setInspection({ status: "ready", file, profile: result.profile });
            } else if (result.kind === "unsupported") {
              setInspection({ status: "unsupported", file, encryption: result.encryption });
            } else {
              // El motor solo puede devolver "passwordRequired" aqui si no
              // se aporto contrasena; como sí se aporto, no deberia pasar.
              // Fallar cerrado igualmente en vez de asumir nada.
              setInspection({ status: "failed", file });
            }
          } catch (error) {
            if (attendedFileRef.current !== file || validationSeqRef.current !== seq) return;
            if (error instanceof UnlockError) {
              setFailure(error.reason);
              if (error.reason === "wrongPassword") {
                setInspection({ status: "passwordRequired", file });
                return;
              }
            }
            setInspection({ status: "failed", file });
          }
        };

        return (
          <>
            {showPasswordField ? (
              <>
                <PasswordField
                  label={s.passwordLabel}
                  value={options.password}
                  onChange={(password) => {
                    setFailure(null);
                    setOptions({ password });
                    // Cualquier validacion en curso (o ya resuelta) quedo
                    // atada a la contrasena ANTERIOR: se invalida su numero
                    // de secuencia para que, si todavia esta en vuelo, su
                    // resultado se descarte al llegar en vez de pisar el
                    // estado con un perfil que no corresponde a lo que hay
                    // escrito ahora.
                    validationSeqRef.current += 1;
                    // Editar la contrasena tras haberla validado invalida
                    // el perfil (y el consentimiento) que se calculo con
                    // la anterior: hace falta volver a comprobarla. Y si
                    // hay una validacion en curso, se vuelve a habilitar el
                    // boton de inmediato en vez de esperar a que esa
                    // peticion vieja resuelva. El campo solo esta visible en
                    // "passwordRequired", "validating" o "ready" (cifrado),
                    // asi que estos son los unicos dos casos que cambian.
                    if (file && inspection.status === "ready") {
                      setInspection({ status: "passwordRequired", file });
                      setConsentedFile(null);
                    } else if (file && inspection.status === "validating") {
                      setInspection({ status: "passwordRequired", file });
                    }
                  }}
                  showLabel={s.showPassword}
                  hideLabel={s.hidePassword}
                  autoComplete="current-password"
                  invalid={failure === "wrongPassword"}
                  hint={s.passwordHint}
                />
                {canCheckPassword ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    className="mt-3"
                    onClick={() => void checkPassword()}
                  >
                    {s.checkPasswordButton}
                  </Button>
                ) : null}
              </>
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
        );
      }}
    />
  );
}
