import type { WebviewMessage } from './types';

declare const acquireVsCodeApi: () => {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

type VsCodeApi = ReturnType<typeof acquireVsCodeApi>;

declare global {
  interface Window {
    __DEVDOCKET_VSCODE_API__?: VsCodeApi;
  }
}

let vscodeApi: VsCodeApi | undefined;

export function getVsCodeApi() {
  if (!vscodeApi) {
    vscodeApi = window.__DEVDOCKET_VSCODE_API__ ?? acquireVsCodeApi();
    window.__DEVDOCKET_VSCODE_API__ = vscodeApi;
  }
  return vscodeApi;
}

export function postMessage(message: WebviewMessage): void {
  getVsCodeApi().postMessage(message);
}

export function setWebviewState(state: unknown): void {
  getVsCodeApi().setState(state);
}

export function getWebviewState(): unknown {
  return getVsCodeApi().getState();
}
