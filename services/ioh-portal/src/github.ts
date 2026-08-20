import type { Config } from "./config.js";

const API = "https://api.github.com";

function headers(config: Config) {
  return {
    Authorization: `token ${config.githubToken}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "ioh-portal",
  };
}

async function gh(config: Config, path: string, init?: RequestInit) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers(config), ...(init?.headers ?? {}) } });
  const body = res.status === 204 ? null : await res.json();
  if (!res.ok) {
    throw new Error(`GitHub API ${init?.method ?? "GET"} ${path} failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

export async function getBranchHeadSha(config: Config, branch: string): Promise<string> {
  const ref = (await gh(config, `/repos/${config.githubOwner}/${config.githubRepo}/git/ref/heads/${branch}`)) as { object: { sha: string } };
  return ref.object.sha;
}

export async function createBranch(config: Config, branchName: string, fromSha: string): Promise<void> {
  await gh(config, `/repos/${config.githubOwner}/${config.githubRepo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: fromSha }),
  });
}

// Returns the file's blob sha (needed to update it) if it already exists on
// `ref`, or null if it doesn't — lets the caller distinguish "new API" from
// "new version of an existing API."
export async function getFileSha(config: Config, path: string, ref: string): Promise<string | null> {
  try {
    const file = (await gh(config, `/repos/${config.githubOwner}/${config.githubRepo}/contents/${path}?ref=${encodeURIComponent(ref)}`)) as { sha: string };
    return file.sha;
  } catch (err) {
    if (err instanceof Error && err.message.includes("(404)")) return null;
    throw err;
  }
}

export async function putFile(config: Config, opts: { path: string; branch: string; content: string; message: string; sha?: string }): Promise<void> {
  await gh(config, `/repos/${config.githubOwner}/${config.githubRepo}/contents/${opts.path}`, {
    method: "PUT",
    body: JSON.stringify({
      message: opts.message,
      branch: opts.branch,
      content: Buffer.from(opts.content, "utf8").toString("base64"),
      ...(opts.sha ? { sha: opts.sha } : {}),
    }),
  });
}

export async function openPullRequest(config: Config, opts: { branch: string; base: string; title: string; body: string }): Promise<{ number: number; html_url: string }> {
  const pr = (await gh(config, `/repos/${config.githubOwner}/${config.githubRepo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title: opts.title, head: opts.branch, base: opts.base, body: opts.body }),
  })) as { number: number; html_url: string };
  return pr;
}
