/// <reference types="vite/client" />

interface MclApi {
  ping: () => Promise<string>
  sha1: (filePath: string) => Promise<string>
}

interface Window {
  mcl: MclApi
}
