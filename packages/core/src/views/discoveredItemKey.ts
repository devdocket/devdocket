export interface DiscoveredItemKey {
  providerId: string;
  externalId: string;
}

export function getDiscoveredItemKey(providerId: string, externalId: string): string {
  return `${providerId}::${externalId}`;
}

export function parseDiscoveredItemKey(value: string): DiscoveredItemKey | undefined {
  const separatorIndex = value.indexOf('::');
  if (separatorIndex <= 0) {
    return undefined;
  }

  return {
    providerId: value.slice(0, separatorIndex),
    externalId: value.slice(separatorIndex + 2),
  };
}
