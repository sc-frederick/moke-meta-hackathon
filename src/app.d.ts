declare global {
  interface Window {
    /** Stage an actual OS-dropped file at the trusted Electron boundary. Paths stay in Electron. */
    mokeFiles: { stageDrop: (file: File) => Promise<{ token: string; name: string } | null> };
  }
}

export {};
