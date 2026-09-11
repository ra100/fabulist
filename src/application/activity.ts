export interface ActivityLease {
  scope(storyId: string): void;
  end(): void;
}

/**
 * Process-local activity indexed by story.
 *
 * A lease starts unscoped so `Engine.busy` still flips synchronously even when
 * resolving the request's world is asynchronous. Once resolved, the lease is
 * attached to exactly one story for accurate per-user status.
 */
export class StoryActivity {
  private total = 0;
  private readonly stories = new Map<string, number>();

  get busy(): boolean {
    return this.total > 0;
  }

  isBusy(storyId: string): boolean {
    return (this.stories.get(storyId) ?? 0) > 0;
  }

  activeCount(storyId: string): number {
    return this.stories.get(storyId) ?? 0;
  }

  begin(): ActivityLease {
    this.total += 1;
    let currentStory: string | null = null;
    let ended = false;

    return {
      scope: (storyId) => {
        if (ended) throw new Error('cannot scope an ended activity lease');
        if (currentStory === storyId) return;
        if (currentStory) this.decrementStory(currentStory);
        currentStory = storyId;
        this.stories.set(storyId, (this.stories.get(storyId) ?? 0) + 1);
      },
      end: () => {
        if (ended) return;
        ended = true;
        this.total -= 1;
        if (currentStory) this.decrementStory(currentStory);
      },
    };
  }

  private decrementStory(storyId: string): void {
    const next = (this.stories.get(storyId) ?? 0) - 1;
    if (next > 0) this.stories.set(storyId, next);
    else this.stories.delete(storyId);
  }
}
