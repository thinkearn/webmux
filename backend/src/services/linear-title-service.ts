import type { AutoNameConfig } from "../domain/config";
import { log } from "../lib/log";
import { llmProviderLabel, runShortLlmTask, type RunLlmResult } from "./llm-spawn";
import { searchTeamIssuesByKeywords, type LinearIssue } from "./linear-service";

const TITLE_TIMEOUT_MS = 15_000;
const DEDUP_TIMEOUT_MS = 15_000;
const MAX_TITLE_LENGTH = 80;
const MAX_DEDUP_CANDIDATES = 10;

const POLISH_SYSTEM_PROMPT = [
  "You convert a developer task description into a concise Linear issue title.",
  "Return only the title, one line, no quotes, no surrounding punctuation, no trailing period.",
  "Use imperative mood (e.g., 'Fix login redirect', 'Add CSV export').",
  "Use Sentence case.",
  "Aim for 4-12 words.",
  `Maximum ${MAX_TITLE_LENGTH} characters.`,
].join(" ");

const DEDUP_SYSTEM_PROMPT = [
  "You decide whether an existing Linear issue describes the same task as a new one.",
  "You will be shown a new task title and a numbered list of existing issues.",
  "Respond with exactly one token: either the identifier of the matching issue (e.g., ENG-42), or NONE.",
  "Be conservative: only match if the existing issue clearly describes the same underlying work.",
  "Do not include any other text, punctuation, or explanation.",
].join(" ");

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be", "been",
  "being", "to", "of", "in", "on", "at", "for", "with", "by", "from", "as", "into",
  "this", "that", "these", "those", "it", "its", "we", "our", "you", "your",
  "can", "should", "would", "could", "will", "do", "does", "did", "have", "has",
  "had", "not", "no", "if", "then", "than", "when", "where", "why", "how",
  "i", "me", "my", "us", "them", "their",
]);

export type TitlePolishSource = "llm" | "heuristic_no_config" | "heuristic_fallback";

export interface PolishedTitleResult {
  title: string;
  source: TitlePolishSource;
}

function heuristicTitle(prompt: string): string | null {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return null;
  if (firstLine.length <= MAX_TITLE_LENGTH) return firstLine;
  return `${firstLine.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

function normalizePolishedTitle(raw: string): string | null {
  let title = raw.trim();
  title = title.replace(/^```[\w-]*\s*/, "").replace(/\s*```$/, "");
  title = title.split(/\r?\n/)[0]?.trim() ?? "";
  title = title.replace(/^title\s*:\s*/i, "");
  title = title.replace(/^["'`]+|["'`]+$/g, "");
  title = title.replace(/[.!?,;:]+$/, "");
  title = title.replace(/\s+/g, " ").trim();
  if (!title) return null;
  if (title.length > MAX_TITLE_LENGTH) {
    title = title.slice(0, MAX_TITLE_LENGTH).trimEnd();
  }
  return title;
}

export type RunLlmFn = typeof runShortLlmTask;

export interface PolishLinearIssueTitleInput {
  prompt: string;
  autoName: AutoNameConfig | null;
  runLlm?: RunLlmFn;
}

export async function polishLinearIssueTitle(input: PolishLinearIssueTitleInput): Promise<PolishedTitleResult | null> {
  const heuristic = heuristicTitle(input.prompt);
  if (!input.autoName) {
    return heuristic ? { title: heuristic, source: "heuristic_no_config" } : null;
  }
  if (!heuristic) return null;

  const runLlm = input.runLlm ?? runShortLlmTask;
  let result: RunLlmResult;
  try {
    result = await runLlm(
      input.autoName,
      POLISH_SYSTEM_PROMPT,
      input.prompt.trim(),
      { timeoutMs: TITLE_TIMEOUT_MS },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[linear-title] polish call threw: ${msg}; falling back to heuristic`);
    return { title: heuristic, source: "heuristic_fallback" };
  }

  const cli = llmProviderLabel(input.autoName);
  if (!result.ok) {
    if (result.kind === "timeout") {
      log.warn(`[linear-title] ${cli} polish timed out after ${result.timeoutMs}ms; using heuristic`);
    } else if (result.kind === "spawn_error") {
      log.warn(`[linear-title] ${cli} not on PATH; using heuristic title`);
    } else {
      const stderr = result.stderr.trim() || `exit ${result.exitCode}`;
      log.warn(`[linear-title] ${cli} polish failed: ${stderr}; using heuristic`);
    }
    return { title: heuristic, source: "heuristic_fallback" };
  }

  const normalized = normalizePolishedTitle(result.stdout);
  if (!normalized) {
    log.warn(`[linear-title] ${cli} returned empty/unusable title; using heuristic`);
    return { title: heuristic, source: "heuristic_fallback" };
  }
  return { title: normalized, source: "llm" };
}

export function extractKeywords(title: string, max = 4): string[] {
  const tokens = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= max) break;
  }
  return out;
}

export interface FindDuplicateLinearIssueInput {
  polishedTitle: string;
  prompt: string;
  teamId: string;
  autoName: AutoNameConfig;
  search?: typeof searchTeamIssuesByKeywords;
  runLlm?: RunLlmFn;
}

export async function findDuplicateLinearIssue(
  input: FindDuplicateLinearIssueInput,
): Promise<LinearIssue | null> {
  const keywords = extractKeywords(input.polishedTitle);
  if (keywords.length === 0) return null;

  const search = input.search ?? searchTeamIssuesByKeywords;
  const searchResult = await search({
    teamId: input.teamId,
    keywords,
    limit: MAX_DEDUP_CANDIDATES,
  });
  if (!searchResult.ok) {
    log.warn(`[linear-title] dedup search failed: ${searchResult.error}`);
    return null;
  }
  const candidates = searchResult.data;
  if (candidates.length === 0) return null;

  const userPrompt = buildDedupUserPrompt({
    polishedTitle: input.polishedTitle,
    prompt: input.prompt,
    candidates,
  });
  const runLlm = input.runLlm ?? runShortLlmTask;

  let result: RunLlmResult;
  try {
    result = await runLlm(
      input.autoName,
      DEDUP_SYSTEM_PROMPT,
      userPrompt,
      { timeoutMs: DEDUP_TIMEOUT_MS },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[linear-title] dedup call threw: ${msg}`);
    return null;
  }

  if (!result.ok) {
    const cli = llmProviderLabel(input.autoName);
    if (result.kind === "timeout") {
      log.warn(`[linear-title] ${cli} dedup timed out after ${result.timeoutMs}ms`);
    } else if (result.kind === "spawn_error") {
      log.warn(`[linear-title] ${cli} not on PATH; skipping dedup`);
    } else {
      const stderr = result.stderr.trim() || `exit ${result.exitCode}`;
      log.warn(`[linear-title] ${cli} dedup failed: ${stderr}`);
    }
    return null;
  }

  return parseDedupResponse(result.stdout, candidates);
}

const MAX_DEDUP_PROMPT_EXCERPT = 1000;

function buildDedupUserPrompt(input: {
  polishedTitle: string;
  prompt: string;
  candidates: LinearIssue[];
}): string {
  const list = input.candidates
    .map((c) => `${c.identifier}: ${c.title}`)
    .join("\n");
  const fullPrompt = input.prompt.trim();
  const excerpt = fullPrompt.length > MAX_DEDUP_PROMPT_EXCERPT
    ? `${fullPrompt.slice(0, MAX_DEDUP_PROMPT_EXCERPT)}…`
    : fullPrompt;
  const lines = [`New task title: ${input.polishedTitle}`];
  if (excerpt && excerpt !== input.polishedTitle) {
    lines.push("", "Full task description:", excerpt);
  }
  lines.push(
    "",
    "Existing issues:",
    list,
    "",
    "Return the identifier of the matching issue, or NONE.",
  );
  return lines.join("\n");
}

function parseDedupResponse(stdout: string, candidates: LinearIssue[]): LinearIssue | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/\b([A-Z]+-\d+)\b/i);
  if (!match) return null;
  const identifier = match[1].toUpperCase();
  return candidates.find((c) => c.identifier.toUpperCase() === identifier) ?? null;
}
