import type { EditorItemData } from './types';

export type SerializedEditorState =
  | { version: 1; itemId: string }
  | { version: 1; providerId: string; externalId: string };

export function getSerializedEditorState(item: EditorItemData): SerializedEditorState | undefined {
  if (item.isIncoming && item.providerId && item.externalId) {
    return {
      version: 1,
      providerId: item.providerId,
      externalId: item.externalId,
    };
  }

  if (!item.isIncoming) {
    return {
      version: 1,
      itemId: item.id,
    };
  }

  return undefined;
}
