import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ProviderLabelCache } from '../storage/providerLabelCache';

describe('ProviderLabelCache', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workcenter-label-cache-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined for unknown providers', () => {
    const cache = new ProviderLabelCache(tmpDir);
    expect(cache.get('unknown')).toBeUndefined();
  });

  it('returns the label after set', async () => {
    const cache = new ProviderLabelCache(tmpDir);
    await cache.set('github', 'GitHub Issues');
    expect(cache.get('github')).toBe('GitHub Issues');
  });

  it('persists labels to disk', async () => {
    const cache = new ProviderLabelCache(tmpDir);
    await cache.set('github', 'GitHub Issues');

    const filePath = path.join(tmpDir, 'provider-labels.json');
    const raw = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(raw);
    expect(data).toEqual({ github: 'GitHub Issues' });
  });

  it('loads labels from disk', async () => {
    // Write a cache file manually
    const filePath = path.join(tmpDir, 'provider-labels.json');
    await fs.writeFile(filePath, JSON.stringify({ github: 'GitHub Issues', jira: 'Jira' }), 'utf-8');

    const cache = new ProviderLabelCache(tmpDir);
    await cache.load();

    expect(cache.get('github')).toBe('GitHub Issues');
    expect(cache.get('jira')).toBe('Jira');
  });

  it('handles missing file gracefully on load', async () => {
    const cache = new ProviderLabelCache(tmpDir);
    await cache.load(); // should not throw
    expect(cache.get('anything')).toBeUndefined();
  });

  it('handles corrupted file gracefully on load', async () => {
    const filePath = path.join(tmpDir, 'provider-labels.json');
    await fs.writeFile(filePath, 'not-valid-json!!!', 'utf-8');

    const cache = new ProviderLabelCache(tmpDir);
    await cache.load(); // should not throw
    expect(cache.get('anything')).toBeUndefined();
  });

  it('handles array JSON gracefully on load', async () => {
    const filePath = path.join(tmpDir, 'provider-labels.json');
    await fs.writeFile(filePath, '["not", "an", "object"]', 'utf-8');

    const cache = new ProviderLabelCache(tmpDir);
    await cache.load(); // should not throw — arrays are skipped
    expect(cache.get('not')).toBeUndefined();
  });

  it('skips non-string values on load', async () => {
    const filePath = path.join(tmpDir, 'provider-labels.json');
    await fs.writeFile(filePath, JSON.stringify({ github: 'GitHub Issues', bad: 42 }), 'utf-8');

    const cache = new ProviderLabelCache(tmpDir);
    await cache.load();

    expect(cache.get('github')).toBe('GitHub Issues');
    expect(cache.get('bad')).toBeUndefined();
  });

  it('does not write to disk when value is unchanged', async () => {
    const cache = new ProviderLabelCache(tmpDir);
    await cache.set('github', 'GitHub Issues');

    const filePath = path.join(tmpDir, 'provider-labels.json');
    const statBefore = await fs.stat(filePath);

    // Wait a tiny bit so mtime would differ if written
    await new Promise(r => setTimeout(r, 50));
    await cache.set('github', 'GitHub Issues'); // same value

    const statAfter = await fs.stat(filePath);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });

  it('creates storage directory if it does not exist', async () => {
    const nestedDir = path.join(tmpDir, 'nested', 'dir');
    const cache = new ProviderLabelCache(nestedDir);
    await cache.set('github', 'GitHub Issues');

    const filePath = path.join(nestedDir, 'provider-labels.json');
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual({ github: 'GitHub Issues' });
  });

  it('round-trips multiple labels', async () => {
    const cache1 = new ProviderLabelCache(tmpDir);
    await cache1.set('github', 'GitHub Issues');
    await cache1.set('jira', 'Jira Board');
    await cache1.set('ado', 'Azure DevOps');

    const cache2 = new ProviderLabelCache(tmpDir);
    await cache2.load();

    expect(cache2.get('github')).toBe('GitHub Issues');
    expect(cache2.get('jira')).toBe('Jira Board');
    expect(cache2.get('ado')).toBe('Azure DevOps');
  });
});
