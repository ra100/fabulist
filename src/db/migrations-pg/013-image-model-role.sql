-- Allow a user's saved credential to be assigned to image generation (#152).
-- Deleting the credential still clears the assignment through the existing FK.
ALTER TABLE user_provider_model_assignments
  DROP CONSTRAINT IF EXISTS user_provider_model_assignments_role_check;

ALTER TABLE user_provider_model_assignments
  ADD CONSTRAINT user_provider_model_assignments_role_check CHECK (role IN (
    'narrate', 'classify', 'integrity', 'referee', 'jev-fastpath', 'director',
    'humanize', 'summarize', 'setup', 'extract', 'passb', 'image'
  ));
