# Agent Instructions

## Commits

Use the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) format for every commit:

```text
<type>(<optional-scope>): <description>
```

- Use a lowercase type such as `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `perf`, `style`, or `revert`.
- Write the description in the imperative mood, keep it concise, and do not end it with a period.
- Add `!` before the colon and a `BREAKING CHANGE:` footer when the commit introduces a breaking change.
- Keep each commit focused on one logical change.

Examples:

```text
feat(auth): add OAuth discovery
fix(store): deduplicate batch upserts
docs: explain provider configuration
```
