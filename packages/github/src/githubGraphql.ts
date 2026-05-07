import { combineSignals, type RelatedItemRef } from '@devdocket/shared';
import { getGitHubAuthHeaders } from './githubApiHelpers';

export interface PrCrossReferencesInput {
  owner: string;
  name: string;
  number: number;
}

export interface PrCrossReferencesBatchResult {
  relatedItems: RelatedItemRef[];
  error?: string;
}

const PR_CROSS_REFERENCES_TIMELINE_SELECTION = `
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
}`;

export const PR_CROSS_REFERENCES_QUERY = `
query PrCrossReferences($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ${PR_CROSS_REFERENCES_TIMELINE_SELECTION}
    }
  }
}`;

export async function fetchPrCrossReferences(
  token: string,
  input: PrCrossReferencesInput,
  signal?: AbortSignal,
): Promise<RelatedItemRef[]> {
  const [result] = await fetchPrCrossReferencesBatch(token, [input], signal);
  if (result?.error) {
    throw new Error(result.error);
  }
  return result?.relatedItems ?? [];
}

export async function fetchPrCrossReferencesBatch(
  token: string,
  inputs: PrCrossReferencesInput[],
  signal?: AbortSignal,
): Promise<PrCrossReferencesBatchResult[]> {
  if (inputs.length === 0) {
    return [];
  }

  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      ...getGitHubAuthHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildPrCrossReferencesBatchRequest(inputs)),
    signal: combineSignals(signal, 30_000),
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed: ${response.status} ${response.statusText}`.trim());
  }

  const payload = await response.json() as {
    data?: Record<string, { pullRequest?: { timelineItems?: { nodes?: unknown[] } | null } | null } | null>;
    errors?: Array<{ message?: string; path?: unknown[] }>;
  };

  if (payload.errors?.length && !payload.data) {
    throw new Error(`GitHub GraphQL request failed: ${formatGraphQLErrors(payload.errors)}`);
  }

  const errorsByAlias = new Map<string, string>();
  for (const error of payload.errors ?? []) {
    const alias = Array.isArray(error.path) && typeof error.path[0] === 'string' ? error.path[0] : undefined;
    if (alias) {
      errorsByAlias.set(alias, error.message || 'Unknown GraphQL error');
    }
  }

  return inputs.map((_input, index) => {
    const alias = getPrCrossReferencesRepositoryAlias(index);
    const repository = payload.data?.[alias];
    const aliasError = errorsByAlias.get(alias);
    if (aliasError) {
      return { relatedItems: [], error: `GitHub GraphQL request failed: ${aliasError}` };
    }
    return {
      relatedItems: mapPrCrossReferencesToRelatedItems(repository?.pullRequest?.timelineItems?.nodes),
    };
  });
}

function formatGraphQLErrors(errors: Array<{ message?: string }>): string {
  return errors.map(error => error.message).filter(Boolean).join('; ') || 'Unknown GraphQL error';
}

function buildPrCrossReferencesBatchRequest(inputs: PrCrossReferencesInput[]): { query: string; variables: Record<string, string | number> } {
  const variableDefinitions: string[] = [];
  const repositorySelections: string[] = [];
  const variables: Record<string, string | number> = {};

  inputs.forEach((input, index) => {
    const ownerVariable = `owner${index}`;
    const nameVariable = `name${index}`;
    const numberVariable = `number${index}`;
    variableDefinitions.push(`$${ownerVariable}: String!`, `$${nameVariable}: String!`, `$${numberVariable}: Int!`);
    repositorySelections.push(`
  ${getPrCrossReferencesRepositoryAlias(index)}: repository(owner: $${ownerVariable}, name: $${nameVariable}) {
    pullRequest(number: $${numberVariable}) {
      ${PR_CROSS_REFERENCES_TIMELINE_SELECTION}
    }
  }`);
    variables[ownerVariable] = input.owner;
    variables[nameVariable] = input.name;
    variables[numberVariable] = input.number;
  });

  return {
    query: `query PrCrossReferencesBatch(${variableDefinitions.join(', ')}) {${repositorySelections.join('')}\n}`,
    variables,
  };
}

function getPrCrossReferencesRepositoryAlias(index: number): string {
  return `repo${index}`;
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
