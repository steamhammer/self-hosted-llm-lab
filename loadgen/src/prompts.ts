import { readFile } from "node:fs/promises";
import { request } from "undici";
import type { Scenario } from "./plan.ts";

/**
 * Prompt construction. Synthetic prompts are random sequences of common English words, so they
 * tokenize like ordinary text. Their length is set from a tokens-per-word ratio measured once
 * against the server's own tokenizer (POST /tokenize, offered by both vLLM and llama.cpp); the
 * exact prompt size of every request is then taken from the server's `usage`, not assumed.
 * Every request gets its own random words from the first token on, so prefix caching cannot
 * reuse anything across requests unless a scenario asks for a shared prefix.
 */
const WORDS = (
  "the of and to in is was that for on with as by at from his her they this have had are not but " +
  "one all were when there can more time some would what about out into than them only other new " +
  "people could these two may first water been called who its now find long down day did get come " +
  "made part over sound take little work know place year live back give most very after thing our " +
  "just name good sentence man think say great where help through much before line right too mean " +
  "old any same tell boy follow came want show also around form three small set put end does another " +
  "well large must big even such because turn here why ask went men read need land different home " +
  "move try kind hand picture again change off play spell air away animal house point page letter " +
  "mother answer found study still learn should world high every near add food between own below " +
  "country plant last school father keep tree never start city earth eye light thought head under " +
  "story saw left few while along might close something seem next hard open example begin life always " +
  "those both paper together got group often run important until children side feet car mile night " +
  "walk white sea began grow took river four carry state once book hear stop without second later miss " +
  "idea enough eat face watch far really almost let above girl sometimes mountain cut young talk soon " +
  "list song being leave family river engine market signal network memory value system model"
).split(" ");

/** Small fast seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit seed from any parts (FNV-1a), so each point and request gets its own stream. */
export function seedOf(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const ch of parts.join("\u0000")) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function randomWords(next: () => number, count: number): string {
  const out = new Array<string>(count);
  for (let i = 0; i < count; i++) out[i] = WORDS[Math.floor(next() * WORDS.length)] as string;
  return out.join(" ");
}

export interface Calibration {
  tokensPerWord: number;
  source: "tokenize" | "default";
  sampleWords: number;
  sampleTokens?: number;
  error?: string;
}

const DEFAULT_TOKENS_PER_WORD = 1.3;

/** Measures how many tokens one of our words costs with the server's tokenizer. */
export async function calibrate(tokenizeBaseUrl: string, model: string): Promise<Calibration> {
  const sampleWords = 2000;
  const text = randomWords(rng(seedOf("calibration")), sampleWords);
  try {
    const res = await request(new URL("/tokenize", tokenizeBaseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      // vLLM reads `prompt`, llama.cpp reads `content`
      body: JSON.stringify({ model, prompt: text, content: text, add_special_tokens: false }),
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
    const body = (await res.body.json()) as { count?: number; tokens?: unknown[] };
    const tokens = typeof body.count === "number" ? body.count : body.tokens?.length;
    if (res.statusCode !== 200 || !tokens) throw new Error(`HTTP ${res.statusCode}`);
    return {
      tokensPerWord: tokens / sampleWords,
      source: "tokenize",
      sampleWords,
      sampleTokens: tokens,
    };
  } catch (err) {
    return {
      tokensPerWord: DEFAULT_TOKENS_PER_WORD,
      source: "default",
      sampleWords,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface PromptSpec {
  prompt: string;
  maxTokens: number;
  ignoreEos: boolean;
}

/** Produces the i-th prompt of a point; deterministic for a given seed. */
export type PromptSource = (i: number) => PromptSpec;

export async function promptSource(
  scenario: Scenario,
  calibration: Calibration,
  pointSeed: number,
): Promise<PromptSource> {
  const wordsFor = (tokens: number) => Math.max(1, Math.round(tokens / calibration.tokensPerWord));

  if (scenario.kind === "dataset") {
    const rows = await loadDataset(scenario.dataset as string);
    const order = shuffle(rows.length, rng(pointSeed));
    return (i) => {
      const row = rows[order[i % rows.length] as number] as DatasetRow;
      return {
        prompt: row.prompt,
        maxTokens: Math.min(row.max_tokens ?? scenario.outputTokens, scenario.outputTokens),
        ignoreEos: false,
      };
    };
  }

  const input = scenario.inputTokens as number;
  const shared =
    scenario.sharedPrefixTokens > 0
      ? `${randomWords(rng(seedOf("shared-prefix", scenario.name)), wordsFor(scenario.sharedPrefixTokens))} `
      : "";
  const uniqueWords = wordsFor(Math.max(1, input - scenario.sharedPrefixTokens));
  return (i) => ({
    prompt: shared + randomWords(rng(seedOf(pointSeed, i)), uniqueWords),
    maxTokens: scenario.outputTokens,
    ignoreEos: scenario.ignoreEos,
  });
}

interface DatasetRow {
  prompt: string;
  max_tokens?: number;
}

async function loadDataset(file: string): Promise<DatasetRow[]> {
  const rows: DatasetRow[] = [];
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as DatasetRow;
    if (typeof row.prompt === "string" && row.prompt) rows.push(row);
  }
  if (!rows.length) throw new Error(`${file}: no prompts`);
  return rows;
}

function shuffle(n: number, next: () => number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [a[i], a[j]] = [a[j] as number, a[i] as number];
  }
  return a;
}
