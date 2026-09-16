import type { McpeasyApi } from "../../shared/ipc";

declare global {
  interface Window {
    /**
     * Optional on purpose: when the renderer runs in a plain browser (the
     * vite dev server without Electron, e.g. for UI testing) there is no
     * preload, so every call site must degrade instead of crashing.
     */
    mcpeasy?: McpeasyApi;
  }
}

export {};
