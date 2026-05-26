import { describe, expect, it } from "bun:test";
import {
  extractKeywords,
  findDuplicateLinearIssue,
  polishLinearIssueTitle,
} from "../services/linear-title-service";
import type { RunLlmResult } from "../services/llm-spawn";
import type { LinearIssue, SearchTeamIssuesResult } from "../services/linear-service";

function makeIssue(overrides: Partial<LinearIssue> & Pick<LinearIssue, "identifier" | "title">): LinearIssue {
  return {
    id: `id-${overrides.identifier}`,
    description: null,
    priority: 0,
    priorityLabel: "No priority",
    url: `https://linear.app/team/issue/${overrides.identifier}`,
    branchName: overrides.identifier.toLowerCase(),
    dueDate: null,
    updatedAt: "2024-01-01T00:00:00Z",
    state: { name: "Backlog", color: "#000", type: "backlog" },
    team: { name: "Eng", key: "ENG" },
    labels: [],
    project: null,
    ...overrides,
  };
}

function okLlm(stdout: string): RunLlmResult {
  return { ok: true, stdout, stderr: "", args: [] };
}

function failLlm(kind: "timeout" | "spawn_error" | "exit_nonzero"): RunLlmResult {
  if (kind === "timeout") return { ok: false, kind: "timeout", timeoutMs: 1000, args: [] };
  if (kind === "spawn_error") return { ok: false, kind: "spawn_error", error: new Error("ENOENT"), args: [] };
  return { ok: false, kind: "exit_nonzero", exitCode: 1, stdout: "", stderr: "boom", args: [] };
}

describe("polishLinearIssueTitle", () => {
  it("returns heuristic title when autoName is null", async () => {
    const result = await polishLinearIssueTitle({
      prompt: "Fix login bug\nMore detail here",
      autoName: null,
    });
    expect(result).toEqual({ title: "Fix login bug", source: "heuristic_no_config" });
  });

  it("returns null when prompt is empty", async () => {
    const result = await polishLinearIssueTitle({ prompt: "   \n  ", autoName: null });
    expect(result).toBeNull();
  });

  it("polishes via LLM and normalizes the output", async () => {
    const result = await polishLinearIssueTitle({
      prompt: "we get logged out on token refresh",
      autoName: { provider: "claude" },
      runLlm: async () => okLlm('```\n"Fix logout on token refresh."\n```'),
    });
    expect(result).toEqual({ title: "Fix logout on token refresh", source: "llm" });
  });

  it("truncates output longer than 80 chars", async () => {
    const long = "Add a really really really really really really really really really really really long title";
    const result = await polishLinearIssueTitle({
      prompt: "task",
      autoName: { provider: "claude" },
      runLlm: async () => okLlm(long),
    });
    expect(result?.title.length).toBeLessThanOrEqual(80);
    expect(result?.source).toBe("llm");
  });

  it("falls back to heuristic on LLM timeout", async () => {
    const result = await polishLinearIssueTitle({
      prompt: "Fix the search bar",
      autoName: { provider: "claude" },
      runLlm: async () => failLlm("timeout"),
    });
    expect(result).toEqual({ title: "Fix the search bar", source: "heuristic_fallback" });
  });

  it("falls back to heuristic when the CLI isn't on PATH", async () => {
    const result = await polishLinearIssueTitle({
      prompt: "Fix the search bar",
      autoName: { provider: "claude" },
      runLlm: async () => failLlm("spawn_error"),
    });
    expect(result).toEqual({ title: "Fix the search bar", source: "heuristic_fallback" });
  });

  it("falls back to heuristic on non-zero exit", async () => {
    const result = await polishLinearIssueTitle({
      prompt: "Fix the search bar",
      autoName: { provider: "claude" },
      runLlm: async () => failLlm("exit_nonzero"),
    });
    expect(result).toEqual({ title: "Fix the search bar", source: "heuristic_fallback" });
  });

  it("falls back to heuristic when LLM returns empty output", async () => {
    const result = await polishLinearIssueTitle({
      prompt: "Fix the search bar",
      autoName: { provider: "claude" },
      runLlm: async () => okLlm("   \n   "),
    });
    expect(result).toEqual({ title: "Fix the search bar", source: "heuristic_fallback" });
  });
});

describe("extractKeywords", () => {
  it("drops stopwords and short tokens", () => {
    expect(extractKeywords("Fix the login redirect on token refresh")).toEqual([
      "fix",
      "login",
      "redirect",
      "token",
    ]);
  });

  it("caps at the requested max", () => {
    expect(extractKeywords("alpha beta gamma delta epsilon zeta", 3)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("deduplicates repeated tokens", () => {
    expect(extractKeywords("login login session login", 4)).toEqual(["login", "session"]);
  });

  it("returns an empty array when nothing usable remains", () => {
    expect(extractKeywords("the a an and or")).toEqual([]);
  });
});

describe("findDuplicateLinearIssue", () => {
  const baseInput = {
    polishedTitle: "Fix logout on token refresh",
    prompt: "Fix logout on token refresh",
    teamId: "team-1",
    autoName: { provider: "claude" as const },
  };

  it("returns null when no keywords can be extracted", async () => {
    const result = await findDuplicateLinearIssue({
      ...baseInput,
      polishedTitle: "the a an or",
      search: async () => ({ ok: true, data: [] }) satisfies SearchTeamIssuesResult,
      runLlm: async () => okLlm("NONE"),
    });
    expect(result).toBeNull();
  });

  it("returns null when search returns no candidates", async () => {
    const result = await findDuplicateLinearIssue({
      ...baseInput,
      search: async () => ({ ok: true, data: [] }) satisfies SearchTeamIssuesResult,
      runLlm: async () => okLlm("ENG-1"),
    });
    expect(result).toBeNull();
  });

  it("returns the matching candidate when the LLM picks an identifier", async () => {
    const candidates = [
      makeIssue({ identifier: "ENG-1", title: "Login redirect broken" }),
      makeIssue({ identifier: "ENG-2", title: "Logout drops session on refresh" }),
    ];
    const result = await findDuplicateLinearIssue({
      ...baseInput,
      search: async () => ({ ok: true, data: candidates }) satisfies SearchTeamIssuesResult,
      runLlm: async () => okLlm("ENG-2"),
    });
    expect(result?.identifier).toBe("ENG-2");
  });

  it("returns null when LLM says NONE", async () => {
    const candidates = [makeIssue({ identifier: "ENG-1", title: "Unrelated" })];
    const result = await findDuplicateLinearIssue({
      ...baseInput,
      search: async () => ({ ok: true, data: candidates }) satisfies SearchTeamIssuesResult,
      runLlm: async () => okLlm("NONE"),
    });
    expect(result).toBeNull();
  });

  it("ignores LLM-emitted identifiers that don't match any candidate", async () => {
    const candidates = [makeIssue({ identifier: "ENG-1", title: "Something" })];
    const result = await findDuplicateLinearIssue({
      ...baseInput,
      search: async () => ({ ok: true, data: candidates }) satisfies SearchTeamIssuesResult,
      runLlm: async () => okLlm("ENG-999"),
    });
    expect(result).toBeNull();
  });

  it("returns null when the LLM times out", async () => {
    const candidates = [makeIssue({ identifier: "ENG-1", title: "Logout on refresh" })];
    const result = await findDuplicateLinearIssue({
      ...baseInput,
      search: async () => ({ ok: true, data: candidates }) satisfies SearchTeamIssuesResult,
      runLlm: async () => failLlm("timeout"),
    });
    expect(result).toBeNull();
  });

  it("returns null when keyword search fails", async () => {
    const result = await findDuplicateLinearIssue({
      ...baseInput,
      search: async () => ({ ok: false, error: "boom" }) satisfies SearchTeamIssuesResult,
      runLlm: async () => okLlm("ENG-1"),
    });
    expect(result).toBeNull();
  });
});
