export type LinkRelation = 'closes' | 'linked';
export type LinkDirection = 'forward' | 'reverse';

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
  direction: LinkDirection,
  externalId?: string,
  fallback?: string,
): string {
  const label = formatLinkedReference(externalId, fallback) ?? 'item';
  if (relation === 'closes') {
    // Forward: parent has relatedItems pointing to child → child is being closed
    // Reverse: child has relatedItems pointing to parent → child closes the parent
    return direction === 'reverse' ? `Closes ${label}` : `Closed by ${label}`;
  }
  return `Linked to ${label}`;
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
