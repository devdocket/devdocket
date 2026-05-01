export type LinkRelation = 'closes' | 'linked';

function formatLinkedReference(externalId?: string, fallback?: string): string | undefined {
  const trimmedExternalId = externalId?.trim();
  if (trimmedExternalId) {
    const issueNumberMatch = trimmedExternalId.match(/#\d+$/);
    return issueNumberMatch?.[0] ?? trimmedExternalId;
  }

  const trimmedFallback = fallback?.trim();
  return trimmedFallback && trimmedFallback.length > 0 ? trimmedFallback : undefined;
}

export function buildLinkDescription(
  relation: LinkRelation,
  externalId?: string,
  fallback?: string,
): string {
  const label = formatLinkedReference(externalId, fallback) ?? 'item';
  return relation === 'closes' ? `Closes ${label}` : `Linked to ${label}`;
}

export function sortLinkedNodes<T extends { title: string; linkedRelation: LinkRelation }>(nodes: T[]): T[] {
  return nodes.sort((a, b) => {
    const relationDifference = getRelationPriority(a.linkedRelation) - getRelationPriority(b.linkedRelation);
    if (relationDifference !== 0) {
      return relationDifference;
    }

    return a.title.localeCompare(b.title);
  });
}

function getRelationPriority(relation: LinkRelation): number {
  return relation === 'closes' ? 0 : 1;
}
