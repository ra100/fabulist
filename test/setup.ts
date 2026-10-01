/**
 * Loaded into every test process with `--import` (see `pnpm test` and CI).
 *
 * Puts `test/bin` first on PATH, so the credential fallbacks the provider probe
 * shells out to find a stub instead of whatever the host has installed. Without
 * it, every `GET /api/providers` in a test ran `gcloud auth print-access-token`
 * — GitHub's Ubuntu runners ship the Google Cloud CLI — which is a Python
 * start-up of roughly half a second of CPU per call, some thirty times a run.
 * It also made results depend on whether the machine running the suite happened
 * to be signed in to gcloud. The stub fails the way an unauthenticated gcloud
 * does, so the probe reports the same "unavailable" it did in CI before.
 */
import { delimiter, join } from 'node:path';

process.env.PATH = `${join(import.meta.dirname, 'bin')}${delimiter}${process.env.PATH ?? ''}`;
