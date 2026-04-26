import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncProviderDescriptions } from '../services/descriptionSync';

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

describe('syncProviderDescriptions', () => {
  let workGraph: ReturnType<typeof createMockWorkGraph>;
  let providerRegistry: ReturnType<typeof createMockProviderRegistry>;

  beforeEach(() => {
    vi.clearAllMocks();
    workGraph = createMockWorkGraph();
    providerRegistry = createMockProviderRegistry();
  });

  it('updates WorkItem description when provider description differs', async () => {
    providerRegistry.getAllDiscoveredItems.mockReturnValue(new Map([
      ['github', [{ externalId: '42', description: 'New description' }]],
    ]));
    workGraph.findItemByProvenance.mockReturnValue({ id: 'item-1', description: 'Old description' });

    await syncProviderDescriptions(providerRegistry as any, workGraph as any);

    expect(workGraph.findItemByProvenance).toHaveBeenCalledWith('github', '42');
    expect(workGraph.updateItem).toHaveBeenCalledWith('item-1', { description: 'New description' });
  });

  it('does not update when descriptions match', async () => {
    providerRegistry.getAllDiscoveredItems.mockReturnValue(new Map([
      ['github', [{ externalId: '42', description: 'Same description' }]],
    ]));
    workGraph.findItemByProvenance.mockReturnValue({ id: 'item-1', description: 'Same description' });

    await syncProviderDescriptions(providerRegistry as any, workGraph as any);

    expect(workGraph.updateItem).not.toHaveBeenCalled();
  });

  it('skips discovered items without matching WorkItem', async () => {
    providerRegistry.getAllDiscoveredItems.mockReturnValue(new Map([
      ['github', [{ externalId: '99', description: 'Orphan' }]],
    ]));
    workGraph.findItemByProvenance.mockReturnValue(undefined);

    await syncProviderDescriptions(providerRegistry as any, workGraph as any);

    expect(workGraph.updateItem).not.toHaveBeenCalled();
  });

  it('handles multiple providers and items', async () => {
    providerRegistry.getAllDiscoveredItems.mockReturnValue(new Map([
      ['github', [
        { externalId: '1', description: 'Updated GH desc' },
        { externalId: '2', description: 'Same GH desc' },
      ]],
      ['ado', [
        { externalId: '100', description: 'Updated ADO desc' },
      ]],
    ]));
    workGraph.findItemByProvenance
      .mockReturnValueOnce({ id: 'gh-1', description: 'Old GH desc' })
      .mockReturnValueOnce({ id: 'gh-2', description: 'Same GH desc' })
      .mockReturnValueOnce({ id: 'ado-1', description: 'Old ADO desc' });

    await syncProviderDescriptions(providerRegistry as any, workGraph as any);

    expect(workGraph.updateItem).toHaveBeenCalledTimes(2);
    expect(workGraph.updateItem).toHaveBeenCalledWith('gh-1', { description: 'Updated GH desc' });
    expect(workGraph.updateItem).toHaveBeenCalledWith('ado-1', { description: 'Updated ADO desc' });
  });

  it('continues syncing other items when one update fails', async () => {
    providerRegistry.getAllDiscoveredItems.mockReturnValue(new Map([
      ['github', [
        { externalId: '1', description: 'Fail' },
        { externalId: '2', description: 'Updated' },
      ]],
    ]));
    workGraph.findItemByProvenance
      .mockReturnValueOnce({ id: 'item-1', description: 'Old1' })
      .mockReturnValueOnce({ id: 'item-2', description: 'Old2' });
    workGraph.updateItem
      .mockRejectedValueOnce(new Error('write error'))
      .mockResolvedValueOnce(undefined);

    await syncProviderDescriptions(providerRegistry as any, workGraph as any);

    expect(workGraph.updateItem).toHaveBeenCalledTimes(2);
    expect(workGraph.updateItem).toHaveBeenCalledWith('item-2', { description: 'Updated' });
  });

  it('does nothing when no providers have items', async () => {
    providerRegistry.getAllDiscoveredItems.mockReturnValue(new Map());

    await syncProviderDescriptions(providerRegistry as any, workGraph as any);

    expect(workGraph.findItemByProvenance).not.toHaveBeenCalled();
    expect(workGraph.updateItem).not.toHaveBeenCalled();
  });

  it('syncs cleared description (undefined) when provider has no description', async () => {
    providerRegistry.getAllDiscoveredItems.mockReturnValue(new Map([
      ['github', [{ externalId: '42', description: undefined }]],
    ]));
    workGraph.findItemByProvenance.mockReturnValue({ id: 'item-1', description: 'Old description' });

    await syncProviderDescriptions(providerRegistry as any, workGraph as any);

    expect(workGraph.updateItem).toHaveBeenCalledWith('item-1', { description: undefined });
  });

  it('does not update when both descriptions are undefined', async () => {
    providerRegistry.getAllDiscoveredItems.mockReturnValue(new Map([
      ['github', [{ externalId: '42', description: undefined }]],
    ]));
    workGraph.findItemByProvenance.mockReturnValue({ id: 'item-1', description: undefined });

    await syncProviderDescriptions(providerRegistry as any, workGraph as any);

    expect(workGraph.updateItem).not.toHaveBeenCalled();
  });

  it('does not clear description when provider omits description property', async () => {
    providerRegistry.getAllDiscoveredItems.mockReturnValue(new Map([
      ['github', [{ externalId: '42', title: 'Bug' }]],
    ]));
    workGraph.findItemByProvenance.mockReturnValue({ id: 'item-1', description: 'Existing description' });

    await syncProviderDescriptions(providerRegistry as any, workGraph as any);

    expect(workGraph.updateItem).not.toHaveBeenCalled();
  });
});
