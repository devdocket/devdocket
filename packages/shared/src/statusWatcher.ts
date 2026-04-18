/**
 * Represents a detected status change for a tracked item.
 */
export interface StatusChange<TStatus> {
  /** The unique identifier of the item. */
  id: string;
  /** The previous status value. */
  previousStatus: TStatus;
  /** The current status value. */
  currentStatus: TStatus;
}

/**
 * Generic utility for detecting status changes across polling cycles.
 *
 * Tracks items by string ID and detects when their status value changes
 * between successive calls to {@link update}. Newly observed items are
 * silently added without generating a change event — only transitions
 * from one known status to another are reported.
 *
 * Designed for CI/CD watchers (and PR trackers) that poll an external
 * API and need to fire notifications when item state changes.
 */
export class StatusWatcher<TStatus> {
  private readonly tracked = new Map<string, TStatus>();

  /**
   * Update tracked statuses and return any changes detected.
   *
   * Items present in {@link current} but not previously tracked are added
   * silently (no change emitted). Items whose status differs from the
   * previously tracked value produce a {@link StatusChange}. Items no
   * longer present in {@link current} are removed from tracking.
   *
   * @param current - Map of item IDs to their current status.
   * @returns Array of status changes detected since the last update.
   */
  update(current: Map<string, TStatus>): StatusChange<TStatus>[] {
    const changes: StatusChange<TStatus>[] = [];

    for (const [id, status] of current) {
      const previous = this.tracked.get(id);
      if (previous !== undefined && previous !== status) {
        changes.push({ id, previousStatus: previous, currentStatus: status });
      }
    }

    // Remove items no longer present
    for (const id of this.tracked.keys()) {
      if (!current.has(id)) {
        this.tracked.delete(id);
      }
    }

    // Update tracked state with all current items
    for (const [id, status] of current) {
      this.tracked.set(id, status);
    }

    return changes;
  }

  /** Clear all tracked items. */
  clear(): void {
    this.tracked.clear();
  }

  /** Get the number of currently tracked items. */
  get size(): number {
    return this.tracked.size;
  }
}
