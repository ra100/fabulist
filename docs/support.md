# Support

Fabulist is a single-maintainer, open-source project — there is no support
team, no SLA, and no ticketing system, but there is a real way to reach a
real person.

## How to get help

**Preferred: open a GitHub issue.**
[github.com/ra100/fabulist/issues](https://github.com/ra100/fabulist/issues)

Use this for:

- Bug reports (include what you were doing, what you expected, and — if
  it's an MCP connector issue — which client you connected from and, if
  you can get it, the tool call that misbehaved).
- Feature requests or design questions.
- Privacy or data-deletion requests (see the
  [privacy policy](./privacy-policy.md) §7) — if you'd rather not file a
  public issue for this, say so and a maintenance path for a private
  contact will be given in response, or mark the issue accordingly.
- Anything about self-hosting: the `README.md` and `deploy/README.md`
  cover most of this already; open an issue if something there doesn't
  work as documented.

**For a security vulnerability specifically:** please do not open a public
issue. Use GitHub's private vulnerability reporting on the same
repository (`Security` tab → `Report a vulnerability`), which reaches the
maintainer without disclosing the issue publicly first.

## What to expect

This project takes no profit and runs no paid support tier
(`.design/SAAS-MULTIUSER.md` §7), so response time is "when the maintainer
has time," not a contracted turnaround. That said, issues do get read and
answered — this is an actively maintained project (check the commit
history for how recently), not an abandoned one.

## Reporting an OpenAI plugin/connector-specific problem

If you're reaching out because something is wrong with the ChatGPT plugin
listing specifically (rather than the software itself) — a stale
description, a broken demo credential, a tool that OpenAI's review
flagged — please say so explicitly in the issue title, since that's a
different kind of fix (a metadata/listing update, not a code change) from
an ordinary bug report.
