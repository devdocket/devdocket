import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockMemento } from 'vscode';
import { ProviderLabelCache } from '../storage/providerLabelCache';

describe('ProviderLabelCache', () => {
  let memento: InstanceType<typeof MockMemento>;

  beforeEach(() => {
    memento = new MockMemento();
  });

  it('returns undefined for unknown providers', () => {
    const cache = new ProviderLabelCache(memento);
    expect(cache.get('unknown')).toBeUndefined();
  });

  it('returns the label after set', async () => {
    const cache = new ProviderLabelCache(memento);
    await cache.set('github', 'GitHub Issues');
    expect(cache.get('github')).toBe('GitHub Issues');
  });

  it('persists labels to globalState', async () => {
    const cache = new ProviderLabelCache(memento);
    await cache.set('github', 'GitHub Issues');

    const persisted = memento.get<Record<string, string>>('devdocket.provider-labels');
    expect(persisted).toEqual({ github: 'GitHub Issues' });
  });

  it('loads labels from globalState', async () => {
    await memento.update('devdocket.provider-labels', { github: 'GitHub Issues', jira: 'Jira' });

    const cache = new ProviderLabelCache(memento);
    await cache.load();

    expect(cache.get('github')).toBe('GitHub Issues');
    expect(cache.get('jira')).toBe('Jira');
  });

  it('handles missing data gracefully on load', async () => {
    const cache = new ProviderLabelCache(memento);
    await cache.load();
    expect(cache.get('anything')).toBeUndefined();
  });

  it('handles array data gracefully on load', async () => {
    await memento.update('devdocket.provider-labels', ['not', 'an', 'object']);

    const cache = new ProviderLabelCache(memento);
    await cache.load();
    expect(cache.get('not')).toBeUndefined();
  });

  it('does not write to globalState when value is unchanged', async () => {
    const cache = new ProviderLabelCache(memento);
    await cache.set('github', 'GitHub Issues');

    const spy = vi.spyOn(memento, 'update');
    await cache.set('github', 'GitHub Issues'); // same value
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('round-trips multiple labels', async () => {
    const cache1 = new ProviderLabelCache(memento);
    await cache1.set('github', 'GitHub Issues');
    await cache1.set('jira', 'Jira Board');
    await cache1.set('ado', 'Azure DevOps');

    const cache2 = new ProviderLabelCache(memento);
    await cache2.load();

    expect(cache2.get('github')).toBe('GitHub Issues');
    expect(cache2.get('jira')).toBe('Jira Board');
    expect(cache2.get('ado')).toBe('Azure DevOps');
  });
});
