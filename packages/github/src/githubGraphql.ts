import { combineSignals, type RelatedItemRef } from '@devdocket/shared';
import { getGitHubAuthHeaders } from './githubApiHelpers';

export interface PrCrossReferencesInput {
  owner: string;
  name: string;
  number: number;
}

export const PR_CROSS_REFERENCES_QUERY = `
query PrCrossReferences($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT, DISCONNECTED_EVENT], first: 100) {
        nodes {
          __typename
          ... on CrossReferencedEvent {
            willCloseTarget
            source {
              __typename
              ... on Issue       { number repository { nameWithOwner } }
              ... on PullRequest { number repository { nameWithOwner } }
            }
          }
          ... on ConnectedEvent {
            subject {
              __typename
              ... on Issue       { number repository { nameWithOwner } }
              ... on PullRequest { number repository { nameWithOwner } }
            }
          }
          ... on DisconnectedEvent {
            subject {
              __typename
              ... on Issue       { number repository { nameWithOwner } }
              ... on PullRequest { number repository { nameWithOwner } }
            }
          }
        }
      }
    }
  }
}`;

export async function fetchPrCrossReferences(
  token: string,
  input: PrCrossReferencesInput,
  signal?: AbortSignal,
): Promise<RelatedItemRef[]> {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      ...getGitHubAuthHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: PR_CROSS_REFERENCES_QUERY,
      variables: input,
    }),
    signal: combineSignals(signal, 30_000),
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed: ${response.status} ${response.statusText}`.trim());
  }

  const payload = await response.json() as {
    data?: { repository?: { pullRequest?: { timelineItems?: { nodes?: unknown[] } | null } | null } | null };
    errors?: Array<{ message?: string }>;
  };

  if (payload.errors?.length) {
    const message = payload.errors.map(error => error.message).filter(Boolean).join('; ') || 'Unknown GraphQL error';
    throw new Error(`GitHub GraphQL request failed: ${message}`);
  }

  return mapPrCrossReferencesToRelatedItems(payload.data?.repository?.pullRequest?.timelineItems?.nodes);
}

export function mapPrCrossReferencesToRelatedItems(nodes: unknown): RelatedItemRef[] {
  if (!Array.isArray(nodes)) {
    return [];
  }

  const relatedItems = new Map<string, RelatedItemRef>();
  for (const node of nodes.slice(0, 100)) {
    if (!node || typeof node !== 'object') {
      continue;
    }

    const event = node as { __typename?: string; willCloseTarget?: unknown; source?: unknown; subject?: unknown };
    switch (event.__typename) {
      case 'CrossReferencedEvent': {
        const ref = toRelatedItemRef(event.source, event.willCloseTarget === true ? 'closes' : 'linked');
        if (ref) { upsertRelatedItem(relatedItems, ref); }
        break;
      }
      case 'ConnectedEvent': {
        const ref = toRelatedItemRef(event.subject, 'closes');
        if (ref) { upsertRelatedItem(relatedItems, ref); }
        break;
      }
      case 'DisconnectedEvent': {
        const ref = toRelatedItemRef(event.subject, 'linked');
        if (ref) { relatedItems.delete(relatedItemKey(ref)); }
        break;
      }
    }
  }

  return Array.from(relatedItems.values());
}

function toRelatedItemRef(subject: unknown, relation: RelatedItemRef['relation']): RelatedItemRef | undefined {
  if (!subject || typeof subject !== 'object') {
    return undefined;
  }

  const value = subject as { __typename?: string; number?: unknown; repository?: { nameWithOwner?: unknown } | null };
  const itemType = value.__typename === 'Issue'
    ? 'issue'
    : value.__typename === 'PullRequest'
      ? 'pr'
      : undefined;
  if (!itemType || typeof value.number !== 'number' || !value.repository || typeof value.repository.nameWithOwner !== 'string') {
    return undefined;
  }

  return {
    externalId: `${value.repository.nameWithOwner}#${value.number}`,
    relation,
    itemType,
  };
}

function upsertRelatedItem(relatedItems: Map<string, RelatedItemRef>, ref: RelatedItemRef): void {
  const key = relatedItemKey(ref);
  const existing = relatedItems.get(key);
  if (!existing || (existing.relation === 'linked' && ref.relation === 'closes')) {
    relatedItems.set(key, ref);
  }
}

function relatedItemKey(ref: Pick<RelatedItemRef, 'externalId' | 'itemType'>): string {
  return `${ref.itemType}\0${ref.externalId}`;
}
