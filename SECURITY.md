# Security policy

## Supported versions

The latest `0.1.x` release receives security fixes. Older pre-release builds are unsupported.

## Reporting a vulnerability

Do not open a public issue containing an exploit, credential, private repository path, tracker content, or Orca runtime details. Contact the maintainer privately through the repository owner's Gitea profile and include:

- affected package and host versions;
- operating system;
- minimal reproduction;
- impact and trust boundary crossed;
- sanitized logs;
- any suggested mitigation.

Expect acknowledgment within seven days. A coordinated disclosure date will be agreed after triage. Public advisories and fixes will omit secrets and private project data.

## Security model

The extension launches configured workers through the local Orca CLI. It does not grant new host, repository, tracker, or network permissions. Callers remain responsible for agent configuration, Orca access, reviewing child commits, and integrating changes.

`sourceRef` is opaque and untrusted. Scope validation prevents absolute paths, traversal, globs, `.git` ownership, repository-root ownership, Windows-incompatible paths, and overlapping sibling ownership. Subprocesses receive argv arrays without a shell. Error output redacts URL credentials, but callers must still avoid placing secrets in task text, scope names, or tracker references.
