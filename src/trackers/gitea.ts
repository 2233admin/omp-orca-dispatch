import process from "node:process";

import { normalizeIssueRef } from "./support.js";
import type { PlannedTrackerCommand, TrackerAdapter } from "./types.js";

/**
 * Gitea's own CLI is not usable here: `tea comment <index> <body>` takes the comment body as a
 * positional argument or on stdin and documents no file option, and stdin is exactly the path
 * that mangles non-ASCII bytes on Windows. So this adapter posts to the Gitea API with curl and
 * lets curl read the body straight out of the UTF-8 file via `--variable name@file`.
 */

/**
 * Only the *name* of the token variable ever reaches the argv. curl's `--variable %NAME` imports
 * the value from the executing host's environment, so this package still holds no credential and
 * no secret value appears in a plan, a log line, or a tool result.
 */
const TOKEN_VARIABLE = "GITEA_TOKEN";
/** Server base URL for a short `owner/repo#index` reference. A base URL is not a credential, so its value may be embedded. */
const BASE_URL_ENV = "GITEA_SERVER_URL";

type IssueLocation = { baseUrl: string; owner: string; repo: string; index: string };

function baseUrlOf(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${label} must be an http(s) URL`);
  // A trailing slash would produce `//api/v1`, which is a different path on the server.
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/**
 * A canonical Gitea issue URL — `https://host/{owner}/{repo}/issues/{index}` — carries the server
 * too, so it needs no environment lookup. A Gitea served under a URL subpath is not accepted
 * here: the extra segments cannot be told apart from an owner, and guessing would file the
 * comment on the wrong repository.
 */
function fromIssueUrl(ref: string): IssueLocation | undefined {
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const parts = url.pathname.split("/").filter(part => part !== "");
  if (parts.length !== 4) return undefined;
  const [owner = "", repo = "", section = "", index = ""] = parts;
  if (section !== "issues" || !owner || !repo || !/^\d+$/.test(index)) return undefined;
  return { baseUrl: url.origin, owner, repo, index };
}

/** `owner/repo#42` and `owner/repo/issues/42` name a repository but no server; that comes from the environment. */
function fromShortRef(ref: string): IssueLocation | undefined {
  const match = /^([^/#\s]+)\/([^/#\s]+)(?:#|\/issues\/)(\d+)$/.exec(ref);
  if (!match) return undefined;
  const [, owner = "", repo = "", index = ""] = match;
  const configured = (process.env[BASE_URL_ENV] ?? "").trim();
  if (!configured) {
    throw new Error(`gitea issueRef "${ref}" needs ${BASE_URL_ENV} to be set, or use a full issue URL`);
  }
  return { baseUrl: baseUrlOf(configured, BASE_URL_ENV), owner, repo, index };
}

function planComment(issueRef: string, bodyFile: string): PlannedTrackerCommand {
  const ref = normalizeIssueRef("gitea", issueRef);
  const location = fromIssueUrl(ref) ?? fromShortRef(ref);
  if (!location) {
    throw new Error(`gitea issueRef must be a full issue URL or "owner/repo#index"; received "${ref}"`);
  }
  const { baseUrl, owner, repo, index } = location;
  const endpoint = `${baseUrl}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${index}/comments`;
  return {
    command: "curl",
    args: [
      // Report an API rejection as a nonzero exit while still showing the server's message, so
      // the caller never acks a comment the server refused.
      "--fail-with-body",
      "--silent",
      "--show-error",
      "--request",
      "POST",
      "--variable",
      `%${TOKEN_VARIABLE}`,
      "--expand-header",
      `Authorization: token {{${TOKEN_VARIABLE}}}`,
      // The body is read from the UTF-8 file and JSON-escaped by curl itself, so a non-ASCII
      // comment never passes through stdin or through a shell.
      "--variable",
      `body@${bodyFile}`,
      "--expand-json",
      '{"body":"{{body:json}}"}',
      "--url",
      endpoint,
    ],
  };
}

export const giteaTracker: TrackerAdapter = { id: "gitea", planComment };
