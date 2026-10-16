/**
 * Elegir un PDF para configurar su plantilla (boton «Configurar plantilla» de la barra de Firmar). El `<input type="file">`
 * se crea en el momento del toque y se quita al elegir o cancelar: no hay un segundo selector de PDF fijo en la pagina (la
 * zona de carga de la herramienta es el unico, y asi lo siguen encontrando las pruebas y los lectores de pantalla).
 */
export function pickPdfFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pdf,application/pdf";
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    input.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;";
    const finish = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => finish(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => finish(null), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}
