import type { ProviderItem } from '../api/types';
import type { ItemAuthorData } from './mainTypes';

export function toItemAuthorData(providerItem: ProviderItem | undefined): ItemAuthorData | undefined {
  return providerItem?.author
    ? { displayName: providerItem.author.displayName, handle: providerItem.author.handle }
    : undefined;
}
