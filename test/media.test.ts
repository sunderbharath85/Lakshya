import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildSystemPrompt } from "../src/server/prompt";
import { MARKETING_PERSONAS } from "../src/server/default-personas";

const dir = realpathSync(mkdtempSync(`${tmpdir()}/aos-media-`));
const seen: { method: string; path: string; auth: string | null; body: string }[] = [];
let polls = 0;

// Stands in for both the OpenAI and the Gemini APIs.
const api: Bun.Server<undefined> = Bun.serve({
  port: 0,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.text() : "";
    seen.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization") ?? req.headers.get("x-goog-api-key"), body });
    const png = Buffer.from("fake-png").toString("base64");
    switch (url.pathname) {
      case "/v1/images/generations":
        return Response.json({ data: [{ b64_json: png }] });
      case "/v1/videos":
        return Response.json({ id: "vid_1", status: "queued" });
      case "/v1/videos/vid_1":
        return Response.json({ id: "vid_1", status: ++polls < 2 ? "in_progress" : "completed" });
      case "/v1/videos/vid_1/content":
        return new Response("fake-mp4");
      case "/v1beta/models/imagen-4.0-generate-001:predict":
        return Response.json({ predictions: [{ bytesBase64Encoded: png }] });
      case "/v1beta/models/veo-3.0-generate-001:predictLongRunning":
        return Response.json({ name: "operations/op1" });
      case "/v1beta/operations/op1":
        return Response.json({ name: "operations/op1", done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${api.url}files/v1.mp4` } }] } } });
      case "/files/v1.mp4":
        return new Response("fake-veo");
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => {
  api.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

async function media(args: string[], keys: Record<string, string>) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPENAI_API_KEY: undefined,
    GEMINI_API_KEY: undefined,
    GOOGLE_API_KEY: undefined,
    LAKSHYA_MEDIA_PROVIDER: undefined,
    OPENAI_BASE_URL: `${api.url}v1`,
    GEMINI_BASE_URL: `${api.url}v1beta`,
    LAKSHYA_MEDIA_POLL_MS: "10",
    ...keys,
  };
  const p = Bun.spawn(["bun", `${import.meta.dir}/../scripts/media.ts`, ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out ? JSON.parse(out) : undefined, err };
}

test("images and videos through OpenAI", async () => {
  const img = await media(["image", "--prompt", "a red kite", "--out", "assets/images/kite.png", "--size", "1536x1024"], { OPENAI_API_KEY: "sk-test" });
  expect(img.out).toMatchObject({ path: `${dir}/assets/images/kite.png`, provider: "openai", model: "gpt-image-2" });
  expect(await Bun.file(`${dir}/assets/images/kite.png`).text()).toBe("fake-png");
  expect(JSON.parse(seen.find((s) => s.path === "/v1/images/generations")!.body)).toMatchObject({ model: "gpt-image-2", prompt: "a red kite", size: "1536x1024" });
  expect(seen.at(-1)!.auth).toBe("Bearer sk-test");

  const vid = await media(["video", "--prompt", "a kite flies", "--out", "assets/video/kite.mp4", "--seconds", "4"], { OPENAI_API_KEY: "sk-test" });
  expect(vid.out).toMatchObject({ provider: "openai", model: "sora-2" });
  expect(await Bun.file(`${dir}/assets/video/kite.mp4`).text()).toBe("fake-mp4");
  expect(seen.filter((s) => s.path === "/v1/videos/vid_1").length).toBe(2);
  expect(seen.find((s) => s.path === "/v1/videos")!.body).toContain("a kite flies");
});

test("images and videos through Gemini, with sizes snapped to its aspect ratios", async () => {
  const img = await media(["image", "--prompt", "a kite", "--out", "g.png", "--size", "1080x1920"], { GEMINI_API_KEY: "g-test" });
  expect(img.out).toMatchObject({ provider: "gemini", model: "imagen-4.0-generate-001" });
  expect(img.out.note).toContain("1080x1920");
  const req = seen.find((s) => s.path.endsWith(":predict"))!;
  expect(req.auth).toBe("g-test");
  expect(JSON.parse(req.body).parameters.aspectRatio).toBe("9:16");

  const vid = await media(["video", "--prompt", "a kite", "--out", "g.mp4"], { GEMINI_API_KEY: "g-test" });
  expect(vid.out).toMatchObject({ provider: "gemini", model: "veo-3.0-generate-001" });
  expect(await Bun.file(`${dir}/g.mp4`).text()).toBe("fake-veo");
  expect(JSON.parse(seen.find((s) => s.path.endsWith(":predictLongRunning"))!.body).parameters.aspectRatio).toBe("16:9");
});

test("provider choice: OpenAI first when both keys are set, --provider overrides, a clear error with none", async () => {
  expect((await media(["image", "--prompt", "x", "--out", "a.png"], { OPENAI_API_KEY: "o", GEMINI_API_KEY: "g" })).out.provider).toBe("openai");
  expect((await media(["image", "--prompt", "x", "--out", "b.png", "--provider", "gemini"], { OPENAI_API_KEY: "o", GEMINI_API_KEY: "g" })).out.provider).toBe("gemini");
  const none = await media(["image", "--prompt", "x", "--out", "c.png"], {});
  expect(none.code).toBe(1);
  expect(none.err).toContain("OPENAI_API_KEY or GEMINI_API_KEY");
  expect((await media(["image", "--prompt", "x", "--out", "d.png", "--provider", "gemini"], { OPENAI_API_KEY: "o" })).err).toContain("GEMINI_API_KEY");
});

test("media personas are told how to generate; others are not", () => {
  const team = { id: "t", name: "T", workspaceDir: "/w", createdAt: 0 };
  const as = (id: string) => ({ ...MARKETING_PERSONAS.find((p) => p.id === id)!, teamId: "t" });
  expect(buildSystemPrompt(team, as("image-designer"), "t.image-designer-1")).toContain("scripts/media.ts image");
  const video = buildSystemPrompt(team, as("video-producer"), "t.video-producer-1");
  expect(video).toContain("scripts/media.ts video");
  expect(video).toContain("scripts/media.ts image");
  expect(buildSystemPrompt(team, as("copywriter"), "t.copywriter-1")).not.toContain("scripts/media.ts");
});
