CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_story_position
  ON turns (story_id, scene, turn);
