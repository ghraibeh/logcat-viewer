import type { AndroidLabApi } from '@shared/api'

declare global {
  interface Window {
    androidlab: AndroidLabApi
  }
}

export {}
