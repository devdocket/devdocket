export type SidebarTab = 'myWork' | 'sources';
export type TabQueries = Record<SidebarTab, string>;
export type SearchBoxVisibility = Record<SidebarTab, boolean>;

export const emptyQueries: TabQueries = { myWork: '', sources: '' };
export const hiddenSearchBoxes: SearchBoxVisibility = { myWork: false, sources: false };

export function isSearchBoxEffectivelyVisible(
  tab: SidebarTab,
  searchBoxVisible: SearchBoxVisibility,
  queries: TabQueries,
  appliedQueries: TabQueries,
): boolean {
  return searchBoxVisible[tab] || queries[tab] !== '' || appliedQueries[tab] !== '';
}
