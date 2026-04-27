import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncProviderTitles } from '../services/titleSync';

function createMockWorkGraph() {
  return {
    findItemByProvenance: vi.fn(),
    updateItem: vi.fn(async () => {}),
  };
}

function createMockProviderRegistry() {
  return {
    getAllDiscoveredItems: vi.fn(() => new Map<string, any[]>()),
  };
}

describe('syncProviderTitles', () => {
  let workGraph: ReturnType<typeof createMockWorkGraph>;
  let providerRegistry: ReturnType<typeof createMockProviderRegistry>;

  beforeEach(() => {
    vi.clearAllMocks();
    workGraph = createMockWorkGraph();
    providerRegistry = createMockProviderRegistry();
  });

  it('updates WorkItem title when provider title differs', async () => {
    providerRegistry.getAllDiscoveredItems.mockReturnValue(new Map([
      ['github', [{ externalId: '42', title: 'New Title' }]],
    ]));
    workGraph.findItemByProvenance.mockReturnValue({ id: 'item-1', title: 'Old Title' });

    await syncProviderTitles('github', providerRegistry as any, workGraph as any);

    expect(workGraph.findItemByProvenance).toHaveBeenCalledWith('github', '42');
    expect(workGraph.updateItem).toHaveBeenCalledWith('item-1', { title: 'New Title' });
  });

  it('does not update when titles match', async () => {
    providerRegistry.getAllDiscoveredItems.mockReturnValue(new Map([
      ['github', [{ externalId: '42', title: 'Same Title' }]],
    ]));
    workGraph.findItemByProvenance.mockReturnValue({ id: 'item-1', title: 'Same Title' });

    await syncProviderTitles('github', providerRegistry as any, workGraph as any);

    expect(workGraph.updateItem).not.toHaveBeenCalled();
  });

  it('skips discovered items without matching WorkItem', async () => {
    providerRegistry.getAllDiscoveredItems.mockReturnValue(new Map([
      ['github', [{ externalId: '99', title: 'Orphan' }]],
    ]));
    workGraph.findItemByProvenance.mockReturnValue(undefined);

    await syncProviderTitles('github', providerRegistry as any, workGraph as any);

    expect(workGraph.updateItem).not.toHaveBeenCalled();
  });

  it('only scans the specified provider, not others', async () => {
    providerRegistry.getAllDiscoveredItems.mockReturnValue(new Map([
      ['github', [
        { externalId: '1', title: 'Updated GH' },
      ]],
      ['ado', [
        { externalId: '100', title: 'Updated ADO' },
      ]],
    ]));
    workGraph.findItemByProvenance
      .mockReturnValueOnce({ id: 'gh-1', title: 'Old GH' });

    await syncProviderTitles('github', providerRegistry as any, workGraph as any);

    expect(workGraph.updateItem).toHaveBeenCalledTimes(1);
    expect(workGraph.updateItem).toHaveBeenCalledWith('gh-1', { title: 'Updated GH' });
    expect(workGraph.findItemByProvenance).not.toHaveBeenCalledWith('ado', expect.anything());
  });

  it('handles multiple items within the specified provider', async () => {
    providerRegistry.getAllDiscoveredItems.mockReturnValue(new Map([
      ['github', [
        { externalId: '1', title: 'Updated GH' },
        { externalId: '2', title: 'Same GH' },
      ]],
    ]));
    workGraph.findItemByProvenance
      .mockReturnValueOnce({ id: 'gh-1', title: 'Old GH' })
      .mockReturnValueOnce({ id: 'gh-2', title: 'Same GH' });

    await syncProviderTitles('github', providerRegistry as any, workGraph as any);

    expect(workGraph.updateItem).toHaveBeenCalledTimes(1);
    expect(workGraph.updateItem).toHaveBeenCalledWith('gh-1', { title: 'Updated GH' });
  });

  it('continues syncing other items when one update fails', async () => {
    providerRegistry.getAllDiscoveredItems.mockReturnValue(new Map([
      ['github', [
        { externalId: '1', title: 'Fail' },
        { externalId: '2', title: 'Updated' },
      ]],
    ]));
    workGraph.findItemByProvenance
      .mockReturnValueOnce({ id: 'item-1', title: 'Old1' })
      .mockReturnValueOnce({ id: 'item-2', title: 'Old2' });
    workGraph.updateItem
      .mockRejectedValueOnce(new Error('write error'))
      .mockResolvedValueOnce(undefined);

    await syncProviderTitles('github', providerRegistry as any, workGraph as any);

    expect(workGraph.updateItem).toHaveBeenCalledTimes(2);
    expect(workGraph.updateItem).toHaveBeenCalledWith('item-2', { title: 'Updated' });
  });

  it('does nothing when provider has no items', async () => {
    providerRegistry.getAllDiscoveredItems.mockReturnValue(new Map());

    await syncProviderTitles('github', providerRegistry as any, workGraph as any);

    expect(workGraph.findItemByProvenance).not.toHaveBeenCalled();
    expect(workGraph.updateItem).not.toHaveBeenCalled();
  });

  it('does not overwrite persisted title with empty provider title', async () => {
    providerRegistry.getAllDiscoveredItems.mockReturnValue(new Map([
      ['github', [{ externalId: '42', title: '' }]],
    ]));
    workGraph.findItemByProvenance.mockReturnValue({ id: 'item-1', title: 'Good Title' });

    await syncProviderTitles('github', providerRegistry as any, workGraph as any);

    expect(workGraph.updateItem).not.toHaveBeenCalled();
  });

  it('does not overwrite persisted title with whitespace-only provider title', async () => {
    providerRegistry.getAllDiscoveredItems.mockReturnValue(new Map([
      ['github', [{ externalId: '42', title: '   ' }]],
    ]));
    workGraph.findItemByProvenance.mockReturnValue({ id: 'item-1', title: 'Good Title' });

    await syncProviderTitles('github', providerRegistry as any, workGraph as any);

    expect(workGraph.updateItem).not.toHaveBeenCalled();
  });
});
