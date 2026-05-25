import { describe, expect, it } from 'vitest';
import {
  decodeUpdatedDetail,
  encodeUpdatedDetail,
  renderUpdatedActivityDetail,
  UPDATED_DETAIL_VALUE_MAX_LENGTH,
} from '../services/updateDetail';

describe('encodeUpdatedDetail', () => {
  it('stamps v1 and preserves per-field diffs', () => {
    const encoded = encodeUpdatedDetail({
      title: { from: 'Old title', to: 'New title' },
      notes: { from: '', to: 'Added repro steps' },
    });

    expect(JSON.parse(encoded)).toEqual({
      v: 1,
      changes: {
        title: { from: 'Old title', to: 'New title' },
        notes: { from: '', to: 'Added repro steps' },
      },
    });
  });

  it('truncates oversized values', () => {
    const oversized = 'x'.repeat(UPDATED_DETAIL_VALUE_MAX_LENGTH + 25);
    const encoded = encodeUpdatedDetail({ title: { from: oversized, to: oversized } });
    const decoded = decodeUpdatedDetail(encoded);

    expect(decoded).toEqual({
      kind: 'v1',
      detail: {
        v: 1,
        changes: {
          title: {
            from: `${'x'.repeat(UPDATED_DETAIL_VALUE_MAX_LENGTH - 1)}…`,
            to: `${'x'.repeat(UPDATED_DETAIL_VALUE_MAX_LENGTH - 1)}…`,
          },
        },
      },
    });
  });
});

describe('renderUpdatedActivityDetail', () => {
  it('renders legacy entries as a summary line', () => {
    expect(renderUpdatedActivityDetail('title, notes')).toEqual({ kind: 'text', text: 'fields changed: title, notes' });
  });

  it('renders v1 entries as structured rows', () => {
    expect(renderUpdatedActivityDetail('{"v":1,"changes":{"title":{"from":"Old","to":"New"},"description":{}}}')).toEqual({
      kind: 'fields',
      rows: [
        { label: 'Title', value: "'Old' → 'New'" },
        { label: 'Description', value: 'value changed' },
      ],
    });
  });

  it('renders unknown future versions as a generic summary', () => {
    expect(renderUpdatedActivityDetail('{"v":2,"changes":{"title":{"from":"Old","to":"New"}}}')).toEqual({ kind: 'text', text: 'fields updated' });
  });
});

describe('decodeUpdatedDetail', () => {
  it('accepts legacy comma-separated field lists', () => {
    expect(decodeUpdatedDetail('title, notes')).toEqual({ kind: 'legacy', fields: ['title', 'notes'] });
  });

  it('accepts current v1 payloads', () => {
    expect(decodeUpdatedDetail('{"v":1,"changes":{"title":{"from":"Old","to":"New"}}}')).toEqual({
      kind: 'v1',
      detail: {
        v: 1,
        changes: {
          title: { from: 'Old', to: 'New' },
        },
      },
    });
  });

  it('returns undefined for unknown future versions', () => {
    expect(decodeUpdatedDetail('{"v":2,"changes":{"title":{"from":"Old","to":"New"}}}')).toBeUndefined();
  });
});
