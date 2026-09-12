export class PrivateStoryLockedError extends Error {
  readonly storyId: string;

  constructor(storyId: string) {
    super(`private story ${storyId} is locked`);
    this.name = 'PrivateStoryLockedError';
    this.storyId = storyId;
  }
}
