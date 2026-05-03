import type { WebviewMessage } from './types';

declare const acquireVsCodeApi: () => {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

let vscodeApi: ReturnType<typeof acquireVsCodeApi> | undefined;

export function getVsCodeApi() {
  if (!vscodeApi) {
    vscodeApi = acquireVsCodeApi();
  }
  return vscodeApi;
}

export function postMessage(message: WebviewMessage): void {
  getVsCodeApi().postMessage(message);
}
