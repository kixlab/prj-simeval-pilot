/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_AGENT_MODE?: string;
  readonly VITE_APP_VERSION: string;
  readonly VITE_APP_COMMIT: string;
  readonly VITE_AGENT_PROMPT_VERSION: string;
  readonly VITE_AGENT_PROMPT_HASH: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
