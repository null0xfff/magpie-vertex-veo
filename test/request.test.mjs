import { describe, test, expect, afterEach, afterAll } from "bun:test"
import { RequestError, durationFor, predictBody, sizeParams, vertexImage, videoRequest } from "../lib/veo.mjs"
import { harness, JPG, PNG, removeKeyFiles } from "./helpers.mjs"

afterAll(removeKeyFiles)

describe("predictBody", () => {
  test("text to video: prompt, defaults, audio on for Veo 3", () => {
    const b = predictBody({ model: "veo-3.1-generate-001", prompt: "A fluffy orange cat on a sunlit windowsill" })
    expect(b).toEqual({
      instances: [{ prompt: "A fluffy orange cat on a sunlit windowsill" }],
      parameters: { sampleCount: 1, durationSeconds: 8, generateAudio: true },
    })
    expect(b.parameters.storageUri).toBeUndefined()
  })

  test("first frame (input_reference)", () => {
    const b = predictBody({ model: "veo-3.1-generate-001", prompt: "move", input_reference: PNG, seconds: "4", size: "16:9" })
    expect(b.instances[0].image).toEqual({ bytesBase64Encoded: "iVBORw0KGgo=", mimeType: "image/png" })
    expect(b.parameters).toMatchObject({ durationSeconds: 4, aspectRatio: "16:9" })
  })

  test("image only, no prompt, is allowed", () => {
    const b = predictBody({ model: "veo-3.1-generate-001", input_reference: PNG })
    expect(b.instances[0].prompt).toBeUndefined()
    expect(b.instances[0].image.mimeType).toBe("image/png")
  })

  test("first and last frame", () => {
    const b = predictBody({ model: "veo-3.1-fast-generate-001", prompt: "p", input_reference: PNG, last_frame: JPG })
    expect(b.instances[0].lastFrame).toEqual({ bytesBase64Encoded: "/9j/4AAQSkZJRg==", mimeType: "image/jpeg" })
  })

  test("reference images become asset references", () => {
    const b = predictBody({ model: "veo-3.1-generate-001", prompt: "p", reference_images: [PNG, JPG] })
    expect(b.instances[0].referenceImages).toEqual([
      { image: { bytesBase64Encoded: "iVBORw0KGgo=", mimeType: "image/png" }, referenceType: "asset" },
      { image: { bytesBase64Encoded: "/9j/4AAQSkZJRg==", mimeType: "image/jpeg" }, referenceType: "asset" },
    ])
    expect(() => predictBody({ model: "veo-3.1-generate-001", prompt: "p", reference_images: [PNG, PNG, PNG, PNG] })).toThrow(/最多支持 3 张/)
  })

  test("gs:// images", () => {
    expect(vertexImage("gs://bucket/dir/cat.JPG")).toEqual({ gcsUri: "gs://bucket/dir/cat.JPG", mimeType: "image/jpeg" })
    expect(() => vertexImage("https://example.com/a.png")).toThrow(RequestError)
  })

  test("size: ratios, WIDTHxHEIGHT, tiers", () => {
    expect(sizeParams("16:9")).toEqual({ aspectRatio: "16:9" })
    expect(sizeParams("9:16")).toEqual({ aspectRatio: "9:16" })
    expect(sizeParams("1280x720")).toEqual({ aspectRatio: "16:9", resolution: "720p" })
    expect(sizeParams("720x1280")).toEqual({ aspectRatio: "9:16", resolution: "720p" })
    expect(sizeParams("1920x1080")).toEqual({ aspectRatio: "16:9", resolution: "1080p" })
    expect(sizeParams("1080x1920")).toEqual({ aspectRatio: "9:16", resolution: "1080p" })
    expect(sizeParams("3840x2160")).toEqual({ aspectRatio: "16:9", resolution: "4k" })
    expect(sizeParams("720p")).toEqual({ resolution: "720p" })
    expect(sizeParams("1080P")).toEqual({ resolution: "1080p" })
    expect(sizeParams("4k")).toEqual({ resolution: "4k" })
    expect(sizeParams("")).toEqual({})
    expect(() => sizeParams("huge")).toThrow(RequestError)
  })

  test("resolution goes to Veo 3 only", () => {
    expect(predictBody({ model: "veo-3.1-generate-001", prompt: "p", size: "1920x1080" }).parameters).toMatchObject({ aspectRatio: "16:9", resolution: "1080p" })
    const v2 = predictBody({ model: "veo-2.0-generate-001", prompt: "p", size: "1920x1080" }).parameters
    expect(v2.aspectRatio).toBe("16:9")
    expect(v2.resolution).toBeUndefined()
    expect(v2.generateAudio).toBeUndefined()
  })

  test("explicit aspect_ratio / resolution override size", () => {
    const p = predictBody({ model: "veo-3.1-generate-001", prompt: "p", size: "1280x720", aspect_ratio: "9:16", resolution: "1080p" }).parameters
    expect(p).toMatchObject({ aspectRatio: "9:16", resolution: "1080p" })
    expect(() => predictBody({ model: "veo-3.1-generate-001", prompt: "p", aspect_ratio: "1:1" })).toThrow(/16:9 或 9:16/)
  })

  test("seconds: parsed and snapped to what the model makes", () => {
    expect(durationFor("veo-3.1-generate-001", "4")).toBe(4)
    expect(durationFor("veo-3.1-generate-001", 6)).toBe(6)
    expect(durationFor("veo-3.1-generate-001", "8")).toBe(8)
    expect(durationFor("veo-3.1-generate-001", "5")).toBe(6)
    expect(durationFor("veo-3.1-generate-001", "12")).toBe(8)
    expect(durationFor("veo-3.1-generate-001", "1")).toBe(4)
    expect(durationFor("veo-2.0-generate-001", "4")).toBe(5)
    expect(durationFor("veo-2.0-generate-001", "7")).toBe(7)
    expect(durationFor("veo-3.1-generate-001", undefined)).toBe(8)
    expect(() => durationFor("veo-3.1-generate-001", "abc")).toThrow(RequestError)
  })

  test("pass-through fields, snake or camel case", () => {
    const p = predictBody({
      model: "veo-3.1-generate-001",
      prompt: "p",
      negative_prompt: "blur",
      person_generation: "allow_adult",
      generate_audio: false,
      seed: 42,
      n: 2,
      storage_uri: "gs://b/out/",
    }).parameters
    expect(p).toMatchObject({ negativePrompt: "blur", personGeneration: "allow_adult", generateAudio: false, seed: 42, sampleCount: 2, storageUri: "gs://b/out/" })
    expect(predictBody({ model: "veo-3.1-generate-001", prompt: "p", negativePrompt: "x", personGeneration: "dont_allow", generateAudio: "true", sampleCount: 4 }).parameters).toMatchObject({
      negativePrompt: "x",
      personGeneration: "dont_allow",
      generateAudio: true,
      sampleCount: 4,
    })
    expect(() => predictBody({ model: "veo-3.1-generate-001", prompt: "p", n: 5 })).toThrow(/1 到 4/)
    expect(() => predictBody({ model: "veo-3.1-generate-001", prompt: "p", seed: -1 })).toThrow(/seed/)
  })

  test("the account's storageUri is used only when set", () => {
    expect(predictBody({ model: "veo-3.1-generate-001", prompt: "p" }, { storageUri: "gs://acct/veo/" }).parameters.storageUri).toBe("gs://acct/veo/")
    expect(predictBody({ model: "veo-3.1-generate-001", prompt: "p" }, { storageUri: "" }).parameters).not.toHaveProperty("storageUri")
    expect(() => predictBody({ model: "veo-3.1-generate-001", prompt: "p", storage_uri: "s3://x" })).toThrow(/gs:\/\//)
  })

  test("nothing to film", () => {
    expect(() => predictBody({ model: "veo-3.1-generate-001", prompt: "  " })).toThrow(/prompt/)
  })
})

describe("routes", () => {
  test("recognises the three OpenAI video routes", () => {
    expect(videoRequest("POST", "/v1/videos")).toEqual({ kind: "create" })
    expect(videoRequest("GET", "/v1/videos/abc_-1")).toEqual({ kind: "status", id: "abc_-1" })
    expect(videoRequest("GET", "/v1/videos/abc/content")).toEqual({ kind: "content", id: "abc" })
    expect(videoRequest("GET", "/v1/videos")).toBeNull()
    expect(videoRequest("POST", "/v1/chat/completions")).toBeNull()
    expect(videoRequest("DELETE", "/v1/videos/abc")).toBeNull()
  })
})

describe("POST /videos through the plugin", () => {
  let h
  afterEach(() => h?.stop())

  test("sends predictLongRunning for the account's project and location", async () => {
    h = await harness()
    const res = await h.create({ model: "veo-3.1-generate-001", prompt: "A cat", seconds: "4", size: "1280x720", input_reference: PNG })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ object: "video", model: "veo-3.1-generate-001", status: "queued", progress: 0, seconds: "4" })
    expect(body.id).toMatch(/^[A-Za-z0-9_-]+$/)
    const sent = h.mock.state.predicts[0]
    expect(sent.path).toBe("/v1/projects/demo-project/locations/us-central1/publishers/google/models/veo-3.1-generate-001:predictLongRunning")
    expect(sent.contentType).toContain("application/json")
    expect(sent.body).toEqual({
      instances: [{ prompt: "A cat", image: { bytesBase64Encoded: "iVBORw0KGgo=", mimeType: "image/png" } }],
      parameters: { sampleCount: 1, durationSeconds: 4, aspectRatio: "16:9", resolution: "720p", generateAudio: true },
    })
  })

  test("uses the account's projectId, location and storageUri", async () => {
    h = await harness({ metadata: { projectId: "other-proj", location: "europe-west4", storageUri: "gs://bkt/veo/" } })
    const res = await h.create({ model: "veo-3.1-fast-generate-001", prompt: "p" })
    expect(res.status).toBe(200)
    const sent = h.mock.state.predicts[0]
    expect(sent.path).toContain("/projects/other-proj/locations/europe-west4/publishers/google/models/veo-3.1-fast-generate-001:")
    expect(sent.body.parameters.storageUri).toBe("gs://bkt/veo/")
  })

  test("accepts a model with the provider prefix, and a Request object", async () => {
    h = await harness()
    const req = new Request("https://us-central1-aiplatform.googleapis.com/v1/videos", {
      method: "POST",
      body: JSON.stringify({ model: "vertex-veo/veo-3.1-lite-generate-001", prompt: "p" }),
    })
    const res = await h.loaded.fetch(req)
    expect(res.status).toBe(200)
    expect((await res.json()).model).toBe("veo-3.1-lite-generate-001")
    expect(h.mock.state.predicts[0].path).toContain("/models/veo-3.1-lite-generate-001:predictLongRunning")
  })

  test("a bad request is a 400 that keeps the sign-in", async () => {
    h = await harness()
    const res = await h.create({ model: "veo-3.1-generate-001", prompt: "p", size: "weird" })
    expect(res.status).toBe(400)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
    expect((await res.json()).error.message).toContain("size")
    expect(h.mock.state.predicts.length).toBe(0)
  })

  test("other routes are refused", async () => {
    h = await harness()
    const res = await h.call("/chat/completions", { method: "POST", body: "{}" })
    expect(res.status).toBe(404)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  })
})
