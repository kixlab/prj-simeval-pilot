/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_AGENT_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
