/**
 * Datos de LAME y de su compilacion a WebAssembly dentro de `@mediabunny/mp3-encoder`, copiados del README del paquete
 * (seccion «Provenance»). `licenses.test.ts` los contrasta con el README instalado y con el binario realmente incluido, asi que
 * si cambian (otra version del paquete) la prueba falla y esta pagina no puede decir algo que ya no es cierto.
 */
export const LAME = {
  version: "3.100",
  site: "https://lame.sourceforge.io/",
  /** Carpeta de la version 3.100 en SourceForge (de ahi sale `lame-3.100.tar.gz`). */
  sourceUrl: "https://sourceforge.net/projects/lame/files/lame/3.100/",
  tarballSha256: "ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e",
  wasmSha256: "a680e507e9d91f1a4dcd6f846b9b94ff1fec7e19ff44e803358c218ddbe446a6",
  emscripten: "4.0.21",
  /** Aviso que pide el proyecto LAME (su pagina de licencia pide una mencion con enlace a su sitio). */
  notice: "MP3 encoding by LAME",
  /** El mismo aviso partido para poner el enlace en «LAME». */
  noticeLead: "MP3 encoding by ",
  noticeLink: "LAME",
} as const;

/** Repositorio comun de mediabunny y del codificador, y rutas con la VERSION EXACTA (etiqueta `v<version>`). */
export const MEDIABUNNY_REPO = "https://github.com/Vanilagy/mediabunny";
export const sourceTreeUrl = (version: string, directory?: string) => `${MEDIABUNNY_REPO}/tree/v${version}${directory ? `/${directory}` : ""}`;
export const npmVersionUrl = (name: string, version: string) => `https://www.npmjs.com/package/${name}/v/${version}`;
export const npmTarballUrl = (name: string, version: string) => {
  const base = name.includes("/") ? name.split("/")[1] : name;
  return `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`;
};
