# Contributing

Thank you for improving `omp-orca-dispatch`.

## Set up

Install Node.js 22.19.0 or newer, then run:

```sh
npm ci
npm run check
npm run test:coverage
npm run build
npm run package:dry-run
```

Orca is required only for live smoke checks. Pi 0.84.4 and OMP 18.1.8 are the minimum supported host versions.

## Change rules

- Preserve one shared dispatcher core and the separate Pi TypeBox and OMP Zod entrypoints.
- Pass subprocess arguments as arrays. Do not add shell command concatenation.
- Keep dispatch bounded to 2–3 siblings from one exact committed parent HEAD.
- Keep slice scopes literal, repository-relative, portable, and disjoint.
- Treat all tracker text and `sourceRef` values as untrusted project data.
- Do not add recursive dispatch, automatic integration, push, or merge behavior.
- Add observable-contract coverage for changed validation, host metadata, command construction, or result behavior.

## Pull requests

Keep each pull request focused. Describe the behavior, security implications, compatibility impact, and exact commands used for verification. Update the changelog for user-visible changes. Never include credentials, private tracker content, local host configuration, or generated package archives.

Contributions are accepted under Apache-2.0.
