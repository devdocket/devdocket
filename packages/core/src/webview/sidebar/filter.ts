import type { SourceProviderData, TierData } from '../shared/types';

export function matchesQuery(text: string, query: string): boolean {
  return matchesNormalizedQuery(text, normalizeQuery(query));
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
          matchesNormalizedQuery(item.title, normalizedQuery)
          || (item.repoAnnotation ? matchesNormalizedQuery(item.repoAnnotation, normalizedQuery) : false)
          || (item.author?.displayName ? matchesNormalizedQuery(item.author.displayName, normalizedQuery) : false)
          || (item.author?.handle ? matchesNormalizedQuery(item.author.handle, normalizedQuery) || matchesNormalizedQuery(`@${item.author.handle}`, normalizedQuery) : false),
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
            const items = matchesNormalizedQuery(group.name, normalizedQuery)
              ? group.items
              : group.items.filter(item => matchesNormalizedQuery(item.title, normalizedQuery));

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

  const { lowerText, originalRanges } = buildLowercaseIndex(text);
  const segments: Array<{ text: string; isMatch: boolean }> = [];
  let lowerSearchIndex = 0;
  let originalSearchIndex = 0;

  while (originalSearchIndex < text.length) {
    const matchIndex = lowerText.indexOf(normalizedQuery, lowerSearchIndex);
    if (matchIndex === -1) {
      segments.push({ text: text.slice(originalSearchIndex), isMatch: false });
      break;
    }

    const matchStart = originalRanges[matchIndex].start;
    const matchEnd = originalRanges[matchIndex + normalizedQuery.length - 1].end;

    if (matchStart > originalSearchIndex) {
      segments.push({ text: text.slice(originalSearchIndex, matchStart), isMatch: false });
    }

    segments.push({ text: text.slice(matchStart, matchEnd), isMatch: true });
    originalSearchIndex = matchEnd;

    lowerSearchIndex = matchIndex + normalizedQuery.length;
    while (lowerSearchIndex < originalRanges.length && originalRanges[lowerSearchIndex].start < matchEnd) {
      lowerSearchIndex += 1;
    }
  }

  return segments.length > 0 ? segments : [{ text, isMatch: false }];
}

export function getGroupTotalCountKey(providerId: string, groupName: string): string {
  return `${providerId}\u0000${groupName}`;
}

function matchesNormalizedQuery(text: string, normalizedQuery: string): boolean {
  if (!normalizedQuery) {
    return true;
  }

  return text.toLowerCase().includes(normalizedQuery);
}

function buildLowercaseIndex(text: string): { lowerText: string; originalRanges: Array<{ start: number; end: number }> } {
  let lowerText = '';
  const originalRanges: Array<{ start: number; end: number }> = [];
  let originalIndex = 0;

  for (const character of text) {
    const originalEnd = originalIndex + character.length;
    const lowerCharacter = character.toLowerCase();

    lowerText += lowerCharacter;
    for (let i = 0; i < lowerCharacter.length; i++) {
      originalRanges.push({ start: originalIndex, end: originalEnd });
    }

    originalIndex = originalEnd;
  }

  return { lowerText, originalRanges };
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function getProviderItemCount(provider: SourceProviderData): number {
  return provider.groups.reduce((total, group) => total + group.items.length, 0);
}
