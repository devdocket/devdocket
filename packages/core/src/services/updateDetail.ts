import type { ActivityDetailRender } from '@devdocket/shared';
import { logger } from './logger';

/** Supported work-item fields that can appear in an `'updated'` activity entry. */
export const UPDATED_DETAIL_FIELDS = ['title', 'notes', 'description', 'url'] as const;

export type UpdatedDetailField = typeof UPDATED_DETAIL_FIELDS[number];

export interface UpdatedFieldDiffV1 {
  from?: string;
  to?: string;
}

/**
 * Versioned schema for the `detail` field of an `'updated'` activity log entry.
 *
 * Legacy entries stored a plain comma-separated list of changed field names.
 * New entries store per-field before/after values so the activity log can answer
 * historical questions like “what did the title used to be?”. Any incompatible
 * change to this payload must bump `v` and extend {@link decodeUpdatedDetail}.
 */
export interface UpdatedDetailV1 {
  v: 1;
  changes: Partial<Record<UpdatedDetailField, UpdatedFieldDiffV1>>;
}

export type UpdatedDetailInput = Partial<Record<UpdatedDetailField, UpdatedFieldDiffV1>>;

export interface LegacyUpdatedDetail {
  kind: 'legacy';
  fields: string[];
}

export interface VersionedUpdatedDetail {
  kind: 'v1';
  detail: UpdatedDetailV1;
}

export type DecodedUpdatedDetail = LegacyUpdatedDetail | VersionedUpdatedDetail;

export const UPDATED_DETAIL_VERSION = 1 as const;
export const UPDATED_DETAIL_VALUE_MAX_LENGTH = 500;

export function encodeUpdatedDetail(input: Readonly<UpdatedDetailInput>): string {
  const changes: UpdatedDetailV1['changes'] = {};

  for (const field of UPDATED_DETAIL_FIELDS) {
    const change = input[field];
    if (!change) {
      continue;
    }

    const encodedChange: UpdatedFieldDiffV1 = {};
    if (change.from !== undefined) {
      encodedChange.from = truncateUpdatedDetailValue(change.from);
    }
    if (change.to !== undefined) {
      encodedChange.to = truncateUpdatedDetailValue(change.to);
    }
    changes[field] = encodedChange;
  }

  return JSON.stringify({ v: UPDATED_DETAIL_VERSION, changes } satisfies UpdatedDetailV1);
}

export function decodeUpdatedDetail(detail: string | undefined): DecodedUpdatedDetail | undefined {
  if (!detail) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return decodeLegacyUpdatedDetail(detail);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const obj = parsed as Record<string, unknown>;
  const version = obj.v;
  if (version !== UPDATED_DETAIL_VERSION) {
    logger.warn(`Unknown updated activity detail version: ${String(version)}; structured diff rendering will be skipped for this entry.`);
    return undefined;
  }

  if (typeof obj.changes !== 'object' || obj.changes === null || Array.isArray(obj.changes)) {
    logger.warn('updated activity detail is missing an object "changes" field; structured diff rendering will be skipped for this entry.');
    return undefined;
  }

  const rawChanges = obj.changes as Record<string, unknown>;
  const changes: UpdatedDetailV1['changes'] = {};

  for (const field of UPDATED_DETAIL_FIELDS) {
    const rawChange = rawChanges[field];
    if (typeof rawChange !== 'object' || rawChange === null || Array.isArray(rawChange)) {
      continue;
    }

    const changeObject = rawChange as Record<string, unknown>;
    const from = typeof changeObject.from === 'string' ? changeObject.from : undefined;
    const to = typeof changeObject.to === 'string' ? changeObject.to : undefined;

    const change: UpdatedFieldDiffV1 = {};
    if (from !== undefined) {
      change.from = from;
    }
    if (to !== undefined) {
      change.to = to;
    }
    changes[field] = change;
  }

  if (Object.keys(changes).length === 0) {
    logger.warn('updated activity detail did not contain any recognized field diffs; structured diff rendering will be skipped for this entry.');
    return undefined;
  }

  return { kind: 'v1', detail: { v: UPDATED_DETAIL_VERSION, changes } };
}

function decodeLegacyUpdatedDetail(detail: string): LegacyUpdatedDetail | undefined {
  if (!/^[a-z]+(?:\s*,\s*[a-z]+)*$/i.test(detail.trim())) {
    return undefined;
  }

  const fields = detail
    .split(',')
    .map(field => field.trim())
    .filter((field): field is string => field.length > 0);

  return fields.length > 0 ? { kind: 'legacy', fields } : undefined;
}

export function renderUpdatedActivityDetail(detail: string | undefined): ActivityDetailRender | undefined {
  const decoded = decodeUpdatedDetail(detail);
  if (!decoded) {
    return renderUnknownUpdatedActivityDetail(detail);
  }
  if (decoded.kind === 'legacy') {
    return { kind: 'text', text: `fields changed: ${decoded.fields.join(', ')}` };
  }

  const rows = UPDATED_DETAIL_FIELDS
    .map((field) => {
      const change = decoded.detail.changes[field];
      return change
        ? { label: updatedFieldLabel(field), value: formatUpdatedFieldDiff(change) }
        : undefined;
    })
    .filter((row): row is { label: string; value: string } => row !== undefined);

  return rows.length > 0 ? { kind: 'fields', rows } : { kind: 'text', text: 'fields updated' };
}

function renderUnknownUpdatedActivityDetail(detail: string | undefined): ActivityDetailRender | undefined {
  if (!detail) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(detail) as { v?: unknown };
    if (typeof parsed === 'object' && parsed !== null && 'v' in parsed) {
      return { kind: 'text', text: 'fields updated' };
    }
  } catch {
    // Non-JSON details are handled by the legacy decoder path above.
  }

  return undefined;
}

function truncateUpdatedDetailValue(value: string): string {
  return value.length <= UPDATED_DETAIL_VALUE_MAX_LENGTH
    ? value
    : `${value.slice(0, UPDATED_DETAIL_VALUE_MAX_LENGTH - 1)}…`;
}

function updatedFieldLabel(field: UpdatedDetailField): string {
  switch (field) {
    case 'title':
      return 'Title';
    case 'notes':
      return 'Notes';
    case 'description':
      return 'Description';
    case 'url':
      return 'URL';
  }
}

function formatUpdatedFieldDiff(change: UpdatedFieldDiffV1): string {
  if (change.from === undefined && change.to === undefined) {
    return 'value changed';
  }
  return `${formatUpdatedFieldValue(change.from)} → ${formatUpdatedFieldValue(change.to)}`;
}

function formatUpdatedFieldValue(value: string | undefined): string {
  return value === undefined ? 'unknown' : `'${value}'`;
}
