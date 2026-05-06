import type { SourceProviderData, TierData } from '../shared/types';

export function matchesQuery(text: string, query: string): boolean {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) {
    return true;
  }

  return text.toLowerCase().includes(normalizedQuery);
}

export function filterTiers(tiers: TierData[], query: string): { tiers: TierData[]; totalCounts: Map<string, number> } {
  const normalizedQuery = normalizeQuery(query);
  const totalCounts = new Map<string, number>();

  for (const tier of tiers) {
    totalCounts.set(tier.id, tier.items.length);
  }

  if (!normalizedQuery) {
    return { tiers, totalCounts };
  }

  return {
    tiers: tiers
      .map(tier => ({
        ...tier,
        items: tier.items.filter(item =>
          matchesQuery(item.title, normalizedQuery) || (item.repoAnnotation ? matchesQuery(item.repoAnnotation, normalizedQuery) : false),
        ),
      }))
      .filter(tier => tier.items.length > 0),
    totalCounts,
  };
}

export function filterProviders(
  providers: SourceProviderData[],
  query: string,
): { providers: SourceProviderData[]; totalCounts: Map<string, number> } {
  const normalizedQuery = normalizeQuery(query);
  const totalCounts = new Map<string, number>();

  for (const provider of providers) {
    totalCounts.set(provider.providerId, getProviderItemCount(provider));
    for (const group of provider.groups) {
      totalCounts.set(getGroupTotalCountKey(provider.providerId, group.name), group.items.length);
    }
  }

  if (!normalizedQuery) {
    return { providers, totalCounts };
  }

  return {
    providers: providers
      .map(provider => ({
        ...provider,
        groups: provider.groups
          .map(group => {
            const items = matchesQuery(group.name, normalizedQuery)
              ? group.items
              : group.items.filter(item => matchesQuery(item.title, normalizedQuery));

            return { ...group, items };
          })
          .filter(group => group.items.length > 0),
      }))
      .filter(provider => provider.groups.some(group => group.items.length > 0)),
    totalCounts,
  };
}

export function splitOnMatches(text: string, query: string): Array<{ text: string; isMatch: boolean }> {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery || text.length === 0) {
    return [{ text, isMatch: false }];
  }

  const lowerText = text.toLowerCase();
  const segments: Array<{ text: string; isMatch: boolean }> = [];
  let searchIndex = 0;

  while (searchIndex < text.length) {
    const matchIndex = lowerText.indexOf(normalizedQuery, searchIndex);
    if (matchIndex === -1) {
      segments.push({ text: text.slice(searchIndex), isMatch: false });
      break;
    }

    if (matchIndex > searchIndex) {
      segments.push({ text: text.slice(searchIndex, matchIndex), isMatch: false });
    }

    const matchEnd = matchIndex + normalizedQuery.length;
    segments.push({ text: text.slice(matchIndex, matchEnd), isMatch: true });
    searchIndex = matchEnd;
  }

  return segments.length > 0 ? segments : [{ text, isMatch: false }];
}

export function getGroupTotalCountKey(providerId: string, groupName: string): string {
  return `${providerId}\u0000${groupName}`;
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function getProviderItemCount(provider: SourceProviderData): number {
  return provider.groups.reduce((total, group) => total + group.items.length, 0);
}
