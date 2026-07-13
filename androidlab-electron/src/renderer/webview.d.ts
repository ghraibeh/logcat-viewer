/**
 * Minimal typing for Electron's <webview> tag (used only by the Location tab's
 * isolated MapLibre guest). We declare just the JSX element + the two methods we
 * drive imperatively, keeping the renderer decoupled from the electron package.
 */
import type { DetailedHTMLProps, HTMLAttributes } from 'react'

export interface WebviewElement extends HTMLElement {
  src: string
  /** Run code in the guest page (host -> guest bridge). */
  executeJavaScript(code: string): Promise<unknown>
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<
        HTMLAttributes<WebviewElement> & { src?: string; partition?: string },
        WebviewElement
      >
    }
  }
}
