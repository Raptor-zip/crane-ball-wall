// Vite env variables used by the client (GAME_DESIGN.md §7.12, §7.13, §10.6). Owner: O0.
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 'off' in the single-HTML build (.env.single): the API is never called. */
  readonly VITE_NET?: string;
  /** '1' in `npm run build:test` (dist-test/): exposes window.__YP_TEST__. */
  readonly VITE_TEST?: string;
  /** Absolute origin for share URLs and og:url / og:image (optional). */
  readonly VITE_PUBLIC_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
