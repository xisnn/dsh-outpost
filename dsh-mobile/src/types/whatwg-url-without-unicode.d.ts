declare module 'whatwg-url-without-unicode' {
  /** WHATWG URL constructor; this package implements the standard URL fields. */
  export const URL: {
    new (url: string, base?: string | globalThis.URL): globalThis.URL;
  };
}
