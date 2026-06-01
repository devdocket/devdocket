// @vitest-environment jsdom
import axeCore from 'axe-core';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemCardData, SourceProviderData, TierData } from '../views/mainTypes';
import { ItemCard } from '../webview/sidebar/components/ItemCard';
import { TierSection } from '../webview/sidebar/components/TierSection';

interface MountedSidebar {
  container: HTMLElement;
  postMessage: ReturnType<typeof vi.fn>;
}

describe('sidebar accessibility harness', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    render(null, document.body);
    document.body.innerHTML = '';
    delete (window as any).__DEVDOCKET_VSCODE_API__;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('renders My Work roles, names, ItemCard semantics, and an axe critical/serious scan', async () => {
    const { container } = await mountSidebar();
    await sendItems(makeTiers());
    await sendSources(makeSources());
    await sendSelectedItem('ready-1');

    expect(getByRole(container, 'tab', /My Work/).getAttribute('aria-selected')).toBe('true');
    expect(getByRole(container, 'tab', /Sources/).getAttribute('aria-selected')).toBe('false');
    expect(getByRole(container, 'tabpanel', /My Work/)).toBeTruthy();
    expect(getAllByRole(container, 'listbox')).toHaveLength(5);
    expect(getAllByRole(container, 'option')).toHaveLength(7);
    expect(getButtons(container).length).toBeGreaterThan(0);

    const readyListbox = getByRole(container, 'listbox', /Ready to Start, 2 items/);
    expect(readyListbox).toBeTruthy();
    const selectedOption = getByRole(container, 'option', /Implement keyboard shortcuts/);
    expect(selectedOption.getAttribute('aria-current')).toBe('true');
    expect(selectedOption.getAttribute('aria-selected')).toBe('false');

    assertInteractiveElementsHaveNames(container);
    await expectNoSeriousOrCriticalAxeViolations(container);
  });

  it('switches tabs and exposes Sources as named browsable groups and rows', async () => {
    const { container, postMessage } = await mountSidebar();
    await sendItems(makeTiers());
    await sendSources(makeSources());

    click(getByRole(container, 'tab', /Sources/));

    expect(postMessage).toHaveBeenCalledWith({ type: 'switchTab', tab: 'sources' });
    expect(getByRole(container, 'tab', /Sources/).getAttribute('aria-selected')).toBe('true');
    expect(getByRole(container, 'tabpanel', /Sources/)).toBeTruthy();
    expect(getByRole(container, 'group', /^GitHub$/)).toBeTruthy();
    expect(getByRole(container, 'group', /Assigned, 3 items/)).toBeTruthy();
    expect(getButton(container, /Provider GitHub unhealthy — show details/)).toBeTruthy();

    // SourceItem must expose its inbox-state variant in the accessible name so
    // screen-reader users can distinguish available / accepted / dismissed
    // rows. Regressions that drop the variant segment must fail here.
    const available = getButton(container, /Fix source import, available, GitHub, Issue/);
    const accepted = getButton(container, /Accepted PR review, accepted, has related items, Pull Request/);
    const dismissed = getButton(container, /Dismissed bug report, dismissed, Issue/);
    expect(available.tagName).toBe('BUTTON');
    expect(accepted.tagName).toBe('BUTTON');
    expect(dismissed.tagName).toBe('BUTTON');

    // SourceItem rows are native <button>s so Enter/Space activation is the
    // browser default; verify a click (the synthesized event for both) reaches
    // the message handler with the expected payload.
    postMessage.mockClear();
    click(available);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'openSourceItem',
      providerId: 'github',
      externalId: 'src-1',
    });

    assertInteractiveElementsHaveNames(container);
    await expectNoSeriousOrCriticalAxeViolations(container);
  });

  it('labels and focuses search boxes when search is toggled', async () => {
    const { container } = await mountSidebar();
    await sendItems(makeTiers());

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'toggleSearch' } }));
    });

    const search = getSearchbox(container, 'Search My Work');
    expect(document.activeElement).toBe(search);
    input(search, 'keyboard');
    expect(search.value).toBe('keyboard');
    expect(getButton(container, /Clear Search My Work/)).toBeTruthy();
  });

  it('supports tier collapse/expand, arrow-key focus traversal, Enter, and Alt+Arrow reorder', () => {
    const onItemClick = vi.fn();
    const onReorderItems = vi.fn();
    const container = renderInto(h(TierSection, {
      tier: makeTiers()[2],
      onItemClick,
      onReorderItems,
    }));

    const header = getButton(container, /Ready to Start.*\(2\)/);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(queryByRole(container, 'listbox', /Ready to Start/)).toBeUndefined();

    click(header);
    const listbox = getByRole(container, 'listbox', /Ready to Start, 2 items/);
    const options = getAllByRole(listbox, 'option');
    options[0].focus();
    keydown(options[0], 'ArrowDown');
    expect(document.activeElement).toBe(options[1]);
    keydown(options[1], 'ArrowUp');
    expect(document.activeElement).toBe(options[0]);

    keydown(options[0], 'Enter');
    expect(onItemClick).toHaveBeenCalledWith('ready-1', { shift: false, toggle: false });

    keydown(options[0], 'ArrowDown', { altKey: true });
    expect(onReorderItems).toHaveBeenCalledWith(['ready-2', 'ready-1']);
  });

  it('follows ItemCard aria-selected and aria-current semantics documented for multi-select listboxes', () => {
    const item = makeItem({ id: 'selected-editor-item', title: 'Selected editor item', isSelected: true });
    const container = document.createElement('div');
    document.body.appendChild(container);

    render(h(ItemCard, { item, tabIndex: 0, onClick: vi.fn(), isMultiSelectListbox: true, isInMultiSelection: false }), container);
    let card = getByRole(container, 'option', /Selected editor item/);
    expect(card.getAttribute('aria-current')).toBe('true');
    expect(card.getAttribute('aria-selected')).toBe('false');
    expect(card.getAttribute('aria-label')).not.toContain('selected');

    render(h(ItemCard, { item, tabIndex: 0, onClick: vi.fn(), isMultiSelectListbox: true, isInMultiSelection: true }), container);
    card = getByRole(container, 'option', /Selected editor item/);
    expect(card.getAttribute('aria-current')).toBe('true');
    expect(card.getAttribute('aria-selected')).toBe('true');
    expect(card.getAttribute('aria-label')).toContain('selected');

    render(h(ItemCard, { item, tabIndex: 0, onClick: vi.fn(), isMultiSelectListbox: false, isInMultiSelection: false }), container);
    card = getByRole(container, 'option', /Selected editor item/);
    expect(card.getAttribute('aria-current')).toBe('true');
    expect(card.getAttribute('aria-selected')).toBe('true');
  });

  it('names and activates every ItemCard action, and restores card focus on Escape without trapping Tab', () => {
    const callbacks = {
      onAccept: vi.fn(),
      onAcceptToFocus: vi.fn(),
      onDismiss: vi.fn(),
      onTransition: vi.fn(),
    };
    const cases: Array<{ item: ItemCardData; labels: string[] }> = [
      { item: makeItem({ id: 'incoming-action', title: 'Incoming action', tierType: 'incoming', providerId: 'github', externalId: '1' }), labels: ['Accept (move to Ready to Start)', 'Start (accept and move to In Progress)', 'Dismiss'] },
      { item: makeItem({ id: 'ready-action', title: 'Ready action', tierType: 'readyToStart' }), labels: ['Start', 'Pause'] },
      { item: makeItem({ id: 'progress-action', title: 'Progress action', tierType: 'inProgress' }), labels: ['Complete', 'Pause'] },
      { item: makeItem({ id: 'paused-action', title: 'Paused action', tierType: 'paused' }), labels: ['Resume'] },
      { item: makeItem({ id: 'done-action', title: 'Done action', tierType: 'done' }), labels: ['Requeue'] },
    ];

    for (const { item, labels } of cases) {
      document.body.innerHTML = '';
      const onClick = vi.fn();
      const container = renderInto(h(ItemCard, { item, tabIndex: 0, onClick, ...callbacks }));
      const card = getByRole(container, 'option', new RegExp(item.title));

      keydown(card, 'Enter');
      expect(onClick).toHaveBeenCalledWith({ shift: false, toggle: false });
      keydown(card, ' ');
      for (const label of labels) {
        const button = getButton(container, new RegExp(`^${escapeRegExp(label)}$`));
        expect(button.getAttribute('aria-label')).toBe(label);
        click(button);
      }
    }

    expect(callbacks.onAccept).toHaveBeenCalledWith('github', '1');
    expect(callbacks.onAcceptToFocus).toHaveBeenCalledWith('github', '1');
    expect(callbacks.onDismiss).toHaveBeenCalledWith('github', '1');
    expect(callbacks.onTransition).toHaveBeenCalledWith('ready-action', 'InProgress');
    expect(callbacks.onTransition).toHaveBeenCalledWith('ready-action', 'Paused');
    expect(callbacks.onTransition).toHaveBeenCalledWith('progress-action', 'Done');
    expect(callbacks.onTransition).toHaveBeenCalledWith('progress-action', 'Paused');
    expect(callbacks.onTransition).toHaveBeenCalledWith('paused-action', 'InProgress');
    expect(callbacks.onTransition).toHaveBeenCalledWith('done-action', 'New');

    document.body.innerHTML = '';
    const container = renderInto(h(ItemCard, {
      item: makeItem({ id: 'escape-action', title: 'Escape action', tierType: 'readyToStart' }),
      tabIndex: 0,
      onClick: vi.fn(),
      onTransition: callbacks.onTransition,
    }));
    const card = getByRole(container, 'option', /Escape action/);
    keydown(card, ' ');
    const firstAction = getButton(container, /^Start$/);
    expect(document.activeElement).toBe(firstAction);
    const tabFromAction = keydown(firstAction, 'Tab');
    expect(tabFromAction.defaultPrevented).toBe(false);
    keydown(firstAction, 'Escape');
    expect(document.activeElement).toBe(card);
  });

  it('marks draggable tiers, posts Alt+Arrow reorder, and exposes bulk action announcements', async () => {
    const { container, postMessage } = await mountSidebar();
    await sendItems(makeTiers());

    const readyCard = getByRole(container, 'option', /Implement keyboard shortcuts/);
    const incomingCard = getByRole(container, 'option', /Review provider a11y report/);
    expect(readyCard.draggable).toBe(true);
    expect(incomingCard.draggable).toBe(false);

    keydown(readyCard, 'ArrowDown', { altKey: true });
    expect(postMessage).toHaveBeenCalledWith({ type: 'reorderItems', itemIds: ['ready-2', 'ready-1'] });

    const incomingOptions = getAllByRole(getByRole(container, 'listbox', /Incoming/), 'option');
    incomingOptions[0].focus();
    click(incomingOptions[0], { ctrlKey: true });
    click(incomingOptions[1], { ctrlKey: true });

    const toolbar = getByRole(container, 'toolbar', /Bulk actions/);
    const count = toolbar.querySelector('.bulk-action-count');
    expect(count?.getAttribute('aria-live')).toBe('polite');
    expect(count?.textContent).toBe('2 selected');
    // Move focus onto the bulk-action button before activating it so that
    // the act of clicking is genuinely a keyboard-user-style activation,
    // not a click on an unfocused control.
    const acceptButton = getButton(container, /Accept 2 selected items/);
    acceptButton.focus();
    expect(document.activeElement).toBe(acceptButton);
    click(acceptButton);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'bulkInboxAction',
      action: 'accept',
      items: [
        { providerId: 'github', externalId: 'inc-1' },
        { providerId: 'ado', externalId: 'inc-2' },
      ],
    });
    expect(container.querySelector('.bulk-action-bar')).toBeNull();
    // Focus restoration after action-invocation is owned by App's
    // pending-bulk-focus layout effect (BulkActionBar suppresses its own
    // restore to avoid a double-announcement). It runs once the next
    // `updateItems` lands; see the dedicated cross-tier / dismiss /
    // stale-update tests below for that coverage.
  });

  it('does not steal focus when the bulk action bar unmounts because the user navigated away', async () => {
    const { container } = await mountSidebar();
    await sendItems(makeTiers());

    const incomingOptions = getAllByRole(getByRole(container, 'listbox', /Incoming/), 'option');
    incomingOptions[0].focus();
    click(incomingOptions[0], { ctrlKey: true });
    click(incomingOptions[1], { ctrlKey: true });
    expect(getByRole(container, 'toolbar', /Bulk actions/)).toBeTruthy();

    // Simulate the user switching tabs: focus moves to the Sources tab button
    // and the bulk action bar unmounts as a side effect of activeTab changing.
    // The bar must NOT yank focus back to the previously-selected option in
    // the (now hidden) My Work panel.
    const sourcesTab = getByRole(container, 'tab', /Sources/);
    sourcesTab.focus();
    click(sourcesTab);

    expect(container.querySelector('.bulk-action-bar')).toBeNull();
    expect(document.activeElement).toBe(sourcesTab);
  });

  it('does not steal focus from a destination element even after focus had entered the bar', async () => {
    const { container } = await mountSidebar();
    await sendItems(makeTiers());

    const incomingOptions = getAllByRole(getByRole(container, 'listbox', /Incoming/), 'option');
    incomingOptions[0].focus();
    click(incomingOptions[0], { ctrlKey: true });
    click(incomingOptions[1], { ctrlKey: true });

    // Walk into the bar (this sets barReceivedFocus), then navigate away
    // without activating any bar action. The bar will unmount as a side
    // effect of the tab change; cleanup must respect that focus already
    // moved to the Sources tab.
    const acceptButton = getButton(container, /Accept 2 selected items/);
    acceptButton.focus();
    const sourcesTab = getByRole(container, 'tab', /Sources/);
    sourcesTab.focus();
    click(sourcesTab);

    expect(container.querySelector('.bulk-action-bar')).toBeNull();
    expect(document.activeElement).toBe(sourcesTab);
  });

  it('follows the actioned item to its new tier after a bulk action lands', async () => {
    const { container } = await mountSidebar();
    await sendItems(makeTiers());

    const incomingOptions = getAllByRole(getByRole(container, 'listbox', /Incoming/), 'option');
    incomingOptions[0].focus();
    click(incomingOptions[0], { ctrlKey: true });
    click(incomingOptions[1], { ctrlKey: true });

    const acceptButton = getButton(container, /Accept 2 selected items/);
    acceptButton.focus();
    click(acceptButton);

    // Simulate the host responding with an `updateItems` that moves the
    // two previously-incoming items into Ready to Start. The focus
    // restoration must follow the actioned item to its new tier rather
    // than landing on `document.body`.
    const updatedTiers = makeTiers().map(tier => {
      if (tier.id === 'incoming') {
        return { ...tier, items: [] };
      }
      if (tier.id === 'ready-to-start') {
        return {
          ...tier,
          items: [
            makeItem({ id: 'github::inc-1', title: 'Review provider a11y report', tierType: 'readyToStart', providerId: 'github', externalId: 'inc-1' }),
            makeItem({ id: 'ado::inc-2', title: 'Triage keyboard regression', tierType: 'readyToStart', providerId: 'ado', externalId: 'inc-2' }),
            ...tier.items,
          ],
        };
      }
      return tier;
    });
    await sendItems(updatedTiers);

    const movedCard = document.querySelector<HTMLElement>('[data-item-id="github::inc-1"]');
    expect(movedCard).toBeTruthy();
    expect(movedCard?.closest('[data-tier-id]')?.getAttribute('data-tier-id')).toBe('ready-to-start');
    expect(document.activeElement).toBe(movedCard);
  });

  it('does not restore focus when an unrelated updateItems lands before the bulk action result', async () => {
    const { container } = await mountSidebar();
    await sendItems(makeTiers());

    const incomingOptions = getAllByRole(getByRole(container, 'listbox', /Incoming/), 'option');
    incomingOptions[0].focus();
    click(incomingOptions[0], { ctrlKey: true });
    click(incomingOptions[1], { ctrlKey: true });

    const acceptButton = getButton(container, /Accept 2 selected items/);
    acceptButton.focus();
    click(acceptButton);

    // A "stale" updateItems arrives first (e.g. an unrelated provider
    // refresh) that still has the items in Incoming. This must NOT
    // consume the pending focus restoration — otherwise the real
    // bulk-action update that lands afterward would silently drop focus
    // to `document.body`.
    await sendItems(makeTiers());

    const updatedTiers = makeTiers().map(tier => {
      if (tier.id === 'incoming') {
        return { ...tier, items: [] };
      }
      if (tier.id === 'ready-to-start') {
        return {
          ...tier,
          items: [
            makeItem({ id: 'github::inc-1', title: 'Review provider a11y report', tierType: 'readyToStart', providerId: 'github', externalId: 'inc-1' }),
            makeItem({ id: 'ado::inc-2', title: 'Triage keyboard regression', tierType: 'readyToStart', providerId: 'ado', externalId: 'inc-2' }),
            ...tier.items,
          ],
        };
      }
      return tier;
    });
    await sendItems(updatedTiers);

    const movedCard = document.querySelector<HTMLElement>('[data-item-id="github::inc-1"]');
    expect(movedCard).toBeTruthy();
    expect(document.activeElement).toBe(movedCard);
  });

  it('falls back to the origin tier header when the actioned item is removed entirely', async () => {
    const { container } = await mountSidebar();
    await sendItems(makeTiers());

    const incomingOptions = getAllByRole(getByRole(container, 'listbox', /Incoming/), 'option');
    incomingOptions[0].focus();
    click(incomingOptions[0], { ctrlKey: true });
    click(incomingOptions[1], { ctrlKey: true });

    const dismissButton = getButton(container, /Dismiss 2 selected items/);
    dismissButton.focus();
    click(dismissButton);

    // Host responds by removing the dismissed items entirely (they no
    // longer appear in any tier). Focus should land on a focusable
    // sibling — the origin tier header — rather than `document.body`.
    const updatedTiers = makeTiers().map(tier =>
      tier.id === 'incoming' ? { ...tier, items: [] } : tier,
    );
    await sendItems(updatedTiers);

    const originHeader = container.querySelector<HTMLElement>(
      '[data-tier-id="incoming"] [data-tier-header="true"]',
    );
    expect(originHeader).toBeTruthy();
    expect(document.activeElement).toBe(originHeader);
  });

  it('does not yank focus back when the user navigates away between a bulk action and its updateItems', async () => {
    const { container } = await mountSidebar();
    await sendItems(makeTiers());

    const incomingOptions = getAllByRole(getByRole(container, 'listbox', /Incoming/), 'option');
    incomingOptions[0].focus();
    click(incomingOptions[0], { ctrlKey: true });
    click(incomingOptions[1], { ctrlKey: true });

    const acceptButton = getButton(container, /Accept 2 selected items/);
    acceptButton.focus();
    click(acceptButton);

    // User moves focus to the Sources tab between the bulk action and the
    // matching updateItems landing. App's pending-focus restore must
    // respect that and not steal focus back to the actioned card.
    const sourcesTab = getByRole(container, 'tab', /Sources/);
    sourcesTab.focus();
    click(sourcesTab);

    const updatedTiers = makeTiers().map(tier => {
      if (tier.id === 'incoming') {
        return { ...tier, items: [] };
      }
      if (tier.id === 'ready-to-start') {
        return {
          ...tier,
          items: [
            makeItem({ id: 'github::inc-1', title: 'Review provider a11y report', tierType: 'readyToStart', providerId: 'github', externalId: 'inc-1' }),
            makeItem({ id: 'ado::inc-2', title: 'Triage keyboard regression', tierType: 'readyToStart', providerId: 'ado', externalId: 'inc-2' }),
            ...tier.items,
          ],
        };
      }
      return tier;
    });
    await sendItems(updatedTiers);

    expect(document.activeElement).toBe(sourcesTab);
  });

  it('drops a pending focus restore after the TTL so a delayed unrelated update cannot consume it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { container } = await mountSidebar();
      await sendItems(makeTiers());

      const incomingOptions = getAllByRole(getByRole(container, 'listbox', /Incoming/), 'option');
      incomingOptions[0].focus();
      click(incomingOptions[0], { ctrlKey: true });
      click(incomingOptions[1], { ctrlKey: true });

      const acceptButton = getButton(container, /Accept 2 selected items/);
      acceptButton.focus();
      click(acceptButton);

      // No matching updateItems arrives. After the TTL elapses, the
      // pending state is dropped. Any later tier update that happens to
      // satisfy `bulkActionHasLanded` (e.g. user manually transitions
      // the same item minutes later) must NOT trigger a stale restore.
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });

      const unrelatedTiers = makeTiers().map(tier => {
        if (tier.id === 'incoming') {
          return { ...tier, items: [] };
        }
        if (tier.id === 'ready-to-start') {
          return {
            ...tier,
            items: [
              makeItem({ id: 'github::inc-1', title: 'Review provider a11y report', tierType: 'readyToStart', providerId: 'github', externalId: 'inc-1' }),
              ...tier.items,
            ],
          };
        }
        return tier;
      });

      // Move focus somewhere outside My Work so a wrongful restore
      // would be visible.
      const sourcesTab = getByRole(container, 'tab', /Sources/);
      sourcesTab.focus();
      await sendItems(unrelatedTiers);

      expect(document.activeElement).toBe(sourcesTab);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders onboarding empty states with heading semantics and named affordances', async () => {
    const { container } = await mountSidebar();
    await sendItems(makeTiers().map(tier => ({ ...tier, items: [] })));

    expect(getHeading(container, 2, /Nothing here yet\./)).toBeTruthy();
    expect(getButton(container, /Create Work Item/)).toBeTruthy();
    expect(getButton(container, /Browse Provider Extensions/)).toBeTruthy();
    expect(getButton(container, /Open Walkthrough/)).toBeTruthy();

    click(getByRole(container, 'tab', /Sources/));
    expect(getHeading(container, 2, /Nothing here yet\./)).toBeTruthy();
  });
});

async function mountSidebar(): Promise<MountedSidebar> {
  const postMessage = vi.fn();
  vi.stubGlobal('acquireVsCodeApi', () => ({
    postMessage,
    getState: vi.fn(),
    setState: vi.fn(),
  }));

  const { App } = await import('../webview/sidebar/App');
  // Mount directly into document.body so the afterEach() `render(null,
  // document.body)` actually unmounts the App and fires its useEffect
  // cleanups (window 'message' / 'keydown' listeners registered in
  // sidebar/App.tsx). Mounting into an inner <div> would leave those
  // listeners attached across tests and cause cross-test leakage.
  const container = document.body;
  await act(async () => {
    render(h(App, {}), container);
  });
  return { container, postMessage };
}

function renderInto(vnode: Parameters<typeof render>[0]): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  render(vnode, container);
  return container;
}

async function sendItems(tiers: TierData[]): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'updateItems', tiers } }));
  });
}

async function sendSources(providers: SourceProviderData[]): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'updateSources', providers } }));
  });
}

async function sendSelectedItem(itemId: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'selectItem', itemId } }));
  });
}

async function expectNoSeriousOrCriticalAxeViolations(container: Element): Promise<void> {
  const result = await axeCore.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    resultTypes: ['violations'],
    rules: {
      // The sidebar's card pattern (focusable listbox row + nested per-card
      // action buttons) is a well-known WCAG anti-pattern: NVDA/JAWS do not
      // expose interactive descendants of role="option" as activatable
      // controls. We disable axe's `nested-interactive` rule globally because
      // the alternative (a non-nested layout) would lose the load-bearing
      // per-card actions surface — see issue #743 for the rationale. The
      // keyboard tests in this file cover reachability and Escape/Tab focus
      // behavior that axe cannot model in jsdom, but they do NOT compensate
      // for the screen-reader semantics. A follow-up should track designing
      // an SR-friendly equivalent (e.g. a separate `aria-activedescendant`
      // tree) before relying on this harness as a full a11y proxy.
      'nested-interactive': { enabled: false },
      // axe's color-contrast rule requires canvas text measurement, which
      // jsdom does not implement. This harness gates structural WCAG issues;
      // contrast is verified visually during design review.
      'color-contrast': { enabled: false },
    },
  });
  expect(result.violations.filter(violation => violation.impact === 'critical' || violation.impact === 'serious')).toEqual([]);
}

function getByRole(root: ParentNode, role: string, name?: RegExp): HTMLElement {
  const found = queryByRole(root, role, name);
  expect(found, `role=${role} name=${name}`).toBeTruthy();
  return found!;
}

function queryByRole(root: ParentNode, role: string, name?: RegExp): HTMLElement | undefined {
  return getAllByRole(root, role).find(element => !name || name.test(getAccessibleName(element)));
}

function getAllByRole(root: ParentNode, role: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`[role="${role}"]`));
}

function getButtons(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('button,[role="button"]'));
}

function getButton(root: ParentNode, name: RegExp): HTMLElement {
  const button = getButtons(root).find(element => name.test(getAccessibleName(element)));
  expect(button, `button name=${name}`).toBeTruthy();
  return button!;
}

function getSearchbox(root: ParentNode, name: string): HTMLInputElement {
  const input = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="search"]'))
    .find(element => getAccessibleName(element) === name);
  expect(input, `searchbox name=${name}`).toBeTruthy();
  return input!;
}

function getHeading(root: ParentNode, level: number, name: RegExp): HTMLHeadingElement {
  const heading = Array.from(root.querySelectorAll<HTMLHeadingElement>(`h${level}`))
    .find(element => name.test(getAccessibleName(element)));
  expect(heading, `heading level=${level} name=${name}`).toBeTruthy();
  return heading!;
}

function getAccessibleName(element: HTMLElement): string {
  return element.getAttribute('aria-label')
    ?? getLabelledByText(element)
    ?? element.textContent?.trim()
    ?? '';
}

function getLabelledByText(element: HTMLElement): string | undefined {
  const labelledBy = element.getAttribute('aria-labelledby');
  if (!labelledBy) return undefined;
  const text = labelledBy
    .split(/\s+/)
    .map(id => document.getElementById(id)?.textContent?.trim())
    .filter((value): value is string => Boolean(value))
    .join(' ');
  return text || undefined;
}

function assertInteractiveElementsHaveNames(root: ParentNode): void {
  const interactiveElements = Array.from(root.querySelectorAll<HTMLElement>([
    'button',
    'input',
    'select',
    'textarea',
    'a[href]',
    '[role="button"]',
    '[role="tab"]',
    '[role="option"]',
  ].join(',')));

  expect(interactiveElements.length).toBeGreaterThan(0);
  for (const element of interactiveElements) {
    expect(getAccessibleName(element), describeElement(element)).toBeTruthy();
  }
}

function click(element: HTMLElement, init: MouseEventInit = {}): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  });
}

function input(element: HTMLInputElement, value: string): void {
  act(() => {
    element.value = value;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  });
}

function keydown(element: HTMLElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  let event!: KeyboardEvent;
  act(() => {
    event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    element.dispatchEvent(event);
  });
  return event;
}

function describeElement(element: HTMLElement): string {
  return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${element.className ? `.${String(element.className).replace(/\s+/g, '.')}` : ''}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeTiers(): TierData[] {
  return [
    { id: 'incoming', name: 'Incoming', icon: '↓', collapsed: false, items: [
      makeItem({ id: 'github::inc-1', title: 'Review provider a11y report', tierType: 'incoming', isUnseen: true, providerId: 'github', externalId: 'inc-1' }),
      makeItem({ id: 'ado::inc-2', title: 'Triage keyboard regression', tierType: 'incoming', providerId: 'ado', externalId: 'inc-2' }),
    ] },
    { id: 'in-progress', name: 'In Progress', icon: '▶', collapsed: false, items: [makeItem({ id: 'progress-1', title: 'Audit focus order', tierType: 'inProgress' })] },
    { id: 'ready-to-start', name: 'Ready to Start', icon: '○', collapsed: false, items: [
      makeItem({ id: 'ready-1', title: 'Implement keyboard shortcuts', tierType: 'readyToStart' }),
      makeItem({ id: 'ready-2', title: 'Document listbox semantics', tierType: 'readyToStart' }),
    ] },
    { id: 'paused', name: 'Paused', icon: '⏸', collapsed: false, items: [makeItem({ id: 'paused-1', title: 'Revisit color contrast notes', tierType: 'paused' })] },
    { id: 'done', name: 'Done', icon: '✓', collapsed: false, items: [makeItem({ id: 'done-1', title: 'Archive old a11y spike', tierType: 'done' })] },
  ];
}

function makeItem(overrides: Partial<ItemCardData> = {}): ItemCardData {
  return {
    id: 'item-1',
    title: 'Accessible sidebar work',
    tierType: 'readyToStart',
    badges: [
      { label: 'GitHub', type: 'provider', variant: 'github' },
      { label: 'Issue', type: 'type', variant: 'issue' },
    ],
    ...overrides,
  };
}

function makeSources(): SourceProviderData[] {
  return [{
    providerId: 'github',
    label: 'GitHub',
    isHealthy: false,
    groups: [{
      name: 'Assigned',
      items: [
        { providerId: 'github', externalId: 'src-1', title: 'Fix source import', badges: [
          { label: 'GitHub', type: 'provider', variant: 'github' },
          { label: 'Issue', type: 'type', variant: 'issue' },
        ], isAccepted: false, isDismissed: false },
        { providerId: 'github', externalId: 'src-2', title: 'Accepted PR review', badges: [
          { label: 'Pull Request', type: 'type', variant: 'pull-request' },
        ], isAccepted: true, isDismissed: false, hasRelatedItems: true },
        { providerId: 'github', externalId: 'src-3', title: 'Dismissed bug report', badges: [
          { label: 'Issue', type: 'type', variant: 'issue' },
        ], isAccepted: false, isDismissed: true },
      ],
    }],
  }];
}
