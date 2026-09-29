#!/usr/bin/env bun
/**
 * Image and video generation for agents, through OpenAI (OPENAI_API_KEY) or Google Gemini (GEMINI_API_KEY).
 *
 *   bun scripts/media.ts image --prompt "..." --out assets/images/hero.png [--size 1536x1024]
 *   bun scripts/media.ts video --prompt "..." --out assets/video/teaser.mp4 [--size 1280x720] [--seconds 8]
 *
 * Common flags: --provider openai|gemini (default: LAKSHYA_MEDIA_PROVIDER, else whichever key is set,
 * OpenAI first), --model <id>. Prints a JSON line describing what was written.
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type Provider = "openai" | "gemini";
export type Kind = "image" | "video";

export const DEFAULT_MODELS: Record<Provider, Record<Kind, string>> = {
  openai: { image: "gpt-image-2", video: "sora-2" },
  gemini: { image: "imagen-4.0-generate-001", video: "veo-3.0-generate-001" },
};

const openaiBase = () => (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
const geminiBase = () => (process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
const geminiKey = () => process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
const pollMs = () => Number(process.env.LAKSHYA_MEDIA_POLL_MS ?? 10_000);

/** The providers with a key set, in order of preference. */
export function availableProviders(): Provider[] {
  return [process.env.OPENAI_API_KEY && "openai", geminiKey() && "gemini"].filter(Boolean) as Provider[];
}

export function pickProvider(requested?: string): Provider {
  const want = requested ?? process.env.LAKSHYA_MEDIA_PROVIDER;
  const have = availableProviders();
  if (want) {
    if (want !== "openai" && want !== "gemini") throw new Error(`Unknown provider "${want}": use openai or gemini`);
    if (!have.includes(want)) throw new Error(`No API key for ${want}: set ${want === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY"}`);
    return want;
  }
  if (!have[0]) throw new Error("No media API key: set OPENAI_API_KEY or GEMINI_API_KEY in the portal's environment");
  return have[0];
}

function parseSize(size?: string) {
  const m = size?.match(/^(\d+)x(\d+)$/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : undefined;
}

/** The closest of a provider's fixed aspect ratios to a WIDTHxHEIGHT size. */
export function nearestAspect(size: string | undefined, choices: string[]) {
  const s = parseSize(size);
  if (!s) return choices[0]!;
  const target = s.w / s.h;
  const ratio = (a: string) => {
    const [w, h] = a.split(":").map(Number);
    return w! / h!;
  };
  return choices.reduce((best, a) => (Math.abs(Math.log(ratio(a) / target)) < Math.abs(Math.log(ratio(best) / target)) ? a : best));
}

async function check(res: Response, what: string) {
  if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status} ${(await res.text()).slice(0, 500)}`);
  return res;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Options {
  prompt: string;
  out: string;
  provider?: string;
  model?: string;
  size?: string;
  seconds?: number;
}

export async function generateImage(o: Options) {
  const provider = pickProvider(o.provider);
  const model = o.model ?? DEFAULT_MODELS[provider].image;
  let bytes: Buffer;
  if (provider === "openai") {
    const res = await check(
      await fetch(`${openaiBase()}/images/generations`, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model, prompt: o.prompt, n: 1, size: o.size ?? "auto" }),
      }),
      "OpenAI image generation",
    );
    const b64 = ((await res.json()) as { data?: { b64_json?: string }[] }).data?.[0]?.b64_json;
    if (!b64) throw new Error("OpenAI returned no image");
    bytes = Buffer.from(b64, "base64");
  } else {
    const aspectRatio = nearestAspect(o.size, ["1:1", "16:9", "9:16", "4:3", "3:4"]);
    const res = await check(
      await fetch(`${geminiBase()}/models/${model}:predict`, {
        method: "POST",
        headers: { "x-goog-api-key": geminiKey()!, "content-type": "application/json" },
        body: JSON.stringify({ instances: [{ prompt: o.prompt }], parameters: { sampleCount: 1, aspectRatio } }),
      }),
      "Gemini image generation",
    );
    const b64 = ((await res.json()) as { predictions?: { bytesBase64Encoded?: string }[] }).predictions?.[0]?.bytesBase64Encoded;
    if (!b64) throw new Error("Gemini returned no image (the prompt may have been filtered)");
    bytes = Buffer.from(b64, "base64");
  }
  return { ...(await save(o.out, bytes)), provider, model, note: sizeNote(provider, o.size) };
}

export async function generateVideo(o: Options) {
  const provider = pickProvider(o.provider);
  const model = o.model ?? DEFAULT_MODELS[provider].video;
  let bytes: Buffer;
  if (provider === "openai") {
    const auth = { authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
    const form = new FormData();
    form.set("model", model);
    form.set("prompt", o.prompt);
    form.set("size", o.size ?? "1280x720");
    form.set("seconds", String(o.seconds ?? 8));
    let job = (await (await check(await fetch(`${openaiBase()}/videos`, { method: "POST", headers: auth, body: form }), "OpenAI video generation")).json()) as {
      id: string;
      status: string;
      error?: { message?: string };
    };
    while (job.status === "queued" || job.status === "in_progress") {
      await sleep(pollMs());
      job = (await (await check(await fetch(`${openaiBase()}/videos/${job.id}`, { headers: auth }), "OpenAI video status")).json()) as typeof job;
    }
    if (job.status !== "completed") throw new Error(`OpenAI video ${job.status}: ${job.error?.message ?? "no reason given"}`);
    bytes = Buffer.from(await (await check(await fetch(`${openaiBase()}/videos/${job.id}/content`, { headers: auth }), "OpenAI video download")).arrayBuffer());
  } else {
    const headers = { "x-goog-api-key": geminiKey()!, "content-type": "application/json" };
    const parameters: Record<string, unknown> = { aspectRatio: nearestAspect(o.size ?? "1280x720", ["16:9", "9:16"]) };
    if (o.seconds) parameters.durationSeconds = o.seconds;
    let op = (await (
      await check(
        await fetch(`${geminiBase()}/models/${model}:predictLongRunning`, { method: "POST", headers, body: JSON.stringify({ instances: [{ prompt: o.prompt }], parameters }) }),
        "Gemini video generation",
      )
    ).json()) as { name: string; done?: boolean; error?: { message?: string }; response?: any };
    while (!op.done) {
      await sleep(pollMs());
      op = (await (await check(await fetch(`${geminiBase()}/${op.name}`, { headers }), "Gemini video status")).json()) as typeof op;
    }
    if (op.error) throw new Error(`Gemini video failed: ${op.error.message}`);
    const uri: string | undefined = op.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
    if (!uri) throw new Error("Gemini returned no video (the prompt may have been filtered)");
    bytes = Buffer.from(await (await check(await fetch(uri, { headers: { "x-goog-api-key": geminiKey()! } }), "Gemini video download")).arrayBuffer());
  }
  return { ...(await save(o.out, bytes)), provider, model, note: sizeNote(provider, o.size) };
}

function sizeNote(provider: Provider, size?: string) {
  return provider === "gemini" && size ? `Gemini picks from fixed aspect ratios; resize or crop to ${size} if you need it exact.` : undefined;
}

async function save(out: string, bytes: Buffer) {
  const path = resolve(out);
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, bytes);
  return { path, bytes: bytes.length };
}

function parseArgs(argv: string[]) {
  const [kind, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i]!;
    if (!k.startsWith("--") || rest[i + 1] === undefined) throw new Error(`Bad argument: ${k}`);
    flags[k.slice(2)] = rest[++i]!;
  }
  return { kind, flags };
}

if (import.meta.main) {
  try {
    const { kind, flags } = parseArgs(process.argv.slice(2));
    if ((kind !== "image" && kind !== "video") || !flags.prompt || !flags.out) {
      throw new Error("Usage: bun scripts/media.ts image|video --prompt <text> --out <file> [--size WxH] [--seconds N] [--provider openai|gemini] [--model id]");
    }
    const o: Options = { prompt: flags.prompt, out: flags.out, provider: flags.provider, model: flags.model, size: flags.size, seconds: flags.seconds ? Number(flags.seconds) : undefined };
    console.log(JSON.stringify(kind === "image" ? await generateImage(o) : await generateVideo(o)));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
