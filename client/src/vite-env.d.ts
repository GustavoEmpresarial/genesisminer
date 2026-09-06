/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DISCORD_INVITE_URL?: string;
  readonly PORT?: string;
  readonly API_PORT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
