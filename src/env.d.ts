declare module "*.scm" {
  const source: string;
  export default source;
}

declare module "*.svg" {
  /** The bundled file's URL. */
  const url: string;
  export default url;
}
