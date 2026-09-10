/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Origin of the generation backend. Empty (the default) means same-origin,
   * which is what `npm run dev` provides. Point it at a deployed proxy to keep
   * one shared key server-side; leave it unset for a static build, where each
   * visitor supplies their own key.
   */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
