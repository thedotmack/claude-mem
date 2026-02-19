import { describe, expect, it } from "bun:test";

import { createTriageConfig } from "../../../scripts/issue-pr-bot/config.ts";
import {
  AUTH_FALLBACK_WARNING,
  ingestOpenItems,
} from "../../../scripts/issue-pr-bot/ingestion.ts";

describe("issue-pr-bot ingestion", () => {
  it("normalizes open issues and PRs, including PR file stats", async () => {
    const config = createTriageConfig({
      repository: { owner: "thedotmack", repo: "claude-mem" },
      generatedAt: "2026-02-19T00:00:00.000Z",
    });
    const requests: Array<{ url: string; authorization: string | null }> = [];

    const result = await ingestOpenItems(config, {
      githubToken: "token-123",
      apiFetch: async (input, init) => {
        const url = String(input);
        const pathname = new URL(url).pathname;
        const page = new URL(url).searchParams.get("page");
        const authorization = new Headers(init?.headers).get("authorization");

        requests.push({ url, authorization });

        if (pathname.endsWith("/issues") && page === "1") {
          return new Response(
            JSON.stringify([
              {
                id: 101,
                number: 11,
                title: "Fix race condition in session startup",
                body: "Details",
                html_url: "https://github.com/thedotmack/claude-mem/issues/11",
                url: "https://api.github.com/repos/thedotmack/claude-mem/issues/11",
                user: { login: "contributor-a" },
                labels: [{ name: "bug" }],
                assignees: [{ login: "maintainer-a" }],
                created_at: "2026-02-01T00:00:00.000Z",
                updated_at: "2026-02-18T00:00:00.000Z",
              },
              {
                id: 102,
                number: 12,
                title: "Improve hook worker startup handling",
                body: null,
                html_url: "https://github.com/thedotmack/claude-mem/pull/12",
                url: "https://api.github.com/repos/thedotmack/claude-mem/issues/12",
                user: { login: "contributor-b" },
                labels: [{ name: "enhancement" }],
                assignees: [],
                created_at: "2026-02-02T00:00:00.000Z",
                updated_at: "2026-02-19T00:00:00.000Z",
                pull_request: {
                  url: "https://api.github.com/repos/thedotmack/claude-mem/pulls/12",
                },
              },
            ]),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            }
          );
        }

        if (pathname.endsWith("/issues") && page === "2") {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (pathname.endsWith("/pulls/12")) {
          return new Response(
            JSON.stringify({
              changed_files: 7,
              additions: 180,
              deletions: 45,
              commits: 3,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            }
          );
        }

        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      },
    });

    expect(result.warnings).toEqual([]);
    expect(result.items).toHaveLength(2);

    const issue = result.items.find((item) => item.type === "issue");
    const pr = result.items.find((item) => item.type === "pr");

    expect(issue).toBeDefined();
    expect(issue?.author?.login).toBe("contributor-a");
    expect(issue?.labels.map((label) => label.name)).toEqual(["bug"]);
    expect(issue?.assignees.map((user) => user.login)).toEqual(["maintainer-a"]);
    expect(issue?.pullRequest).toBeNull();
    expect(issue?.links.api).toBe(
      "https://api.github.com/repos/thedotmack/claude-mem/issues/11"
    );

    expect(pr).toBeDefined();
    expect(pr?.body).toBe("");
    expect(pr?.pullRequest).toEqual({
      changedFiles: 7,
      additions: 180,
      deletions: 45,
      commits: 3,
    });
    expect(pr?.links.html).toBe("https://github.com/thedotmack/claude-mem/pull/12");

    const issueRequestCount = requests.filter((request) =>
      request.url.includes("/issues?")
    ).length;
    expect(issueRequestCount).toBe(1);
    expect(requests.every((request) => request.authorization === "Bearer token-123")).toBe(
      true
    );
  });

  it("retries in public mode when authenticated requests are rate-limited", async () => {
    const config = createTriageConfig({
      repository: { owner: "thedotmack", repo: "claude-mem" },
      generatedAt: "2026-02-19T00:00:00.000Z",
    });

    const requestAuthHeaders: Array<string | null> = [];
    let issueRequestAttempt = 0;

    const result = await ingestOpenItems(config, {
      githubToken: "token-123",
      apiFetch: async (input, init) => {
        const url = String(input);
        const pathname = new URL(url).pathname;
        const page = new URL(url).searchParams.get("page");
        const authorization = new Headers(init?.headers).get("authorization");
        requestAuthHeaders.push(authorization);

        if (pathname.endsWith("/issues") && page === "1") {
          issueRequestAttempt += 1;

          if (issueRequestAttempt === 1) {
            return new Response(
              JSON.stringify({ message: "API rate limit exceeded" }),
              {
                status: 403,
                headers: {
                  "content-type": "application/json",
                  "x-ratelimit-remaining": "0",
                },
              }
            );
          }

          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (pathname.endsWith("/issues") && page === "2") {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      },
    });

    expect(result.items).toEqual([]);
    expect(result.warnings).toContain(AUTH_FALLBACK_WARNING);
    expect(requestAuthHeaders[0]).toBe("Bearer token-123");
    expect(requestAuthHeaders[1]).toBeNull();
  });
});
