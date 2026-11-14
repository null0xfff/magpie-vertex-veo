import { describe, test, expect, afterEach, afterAll } from "bun:test"
import { createResultCache, decodeVideoId, encodeVideoId, gcsMediaURL, operationState, parseOperationName } from "../lib/veo.mjs"
import { harness, MP4, removeKeyFiles } from "./helpers.mjs"

afterAll(removeKeyFiles)

describe("video id", () => {
  test("round-trips and stays URL-safe", () => {
    const refs = [
      { project: "demo-project", location: "us-central1", model: "veo-3.1-generate-001", opId: "0123456789abcdef" },
      { project: "a".repeat(30) + "-very-long-project-id-0123456789", location: "europe-west4", model: "veo-3.1-fast-generate-001", opId: "a1b2-c3_d4.e5" },
      { project: "example.com:my-proj", location: "global", model: "veo-2.0-generate-001", opId: "9".repeat(200) },
    ]
    for (const ref of refs) {
      const id = encodeVideoId(ref)
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(encodeURIComponent(id)).toBe(id)
      expect(decodeVideoId(id)).toEqual(ref)
    }
  })

  test("names from Vertex's operation", () => {
    const name = "projects/p-1/locations/us-central1/publishers/google/models/veo-3.1-generate-001/operations/abc-123"
    const ref = parseOperationName(name)
    expect(ref).toEqual({ project: "p-1", location: "us-central1", model: "veo-3.1-generate-001", opId: "abc-123" })
    expect(decodeVideoId(encodeVideoId(ref))).toEqual(ref)
    expect(parseOperationName("projects/p/operations/x")).toBeNull()
  })

  test("rejects ids that aren't ours", () => {
    expect(decodeVideoId("")).toBeNull()
    expect(decodeVideoId("abc/def")).toBeNull()
    expect(decodeVideoId("%2F")).toBeNull()
    expect(decodeVideoId(Buffer.from("not json").toString("base64url"))).toBeNull()
    expect(decodeVideoId(Buffer.from(JSON.stringify({ p: "x/../y", l: "us-central1", m: "veo", o: "1" })).toString("base64url"))).toBeNull()
    expect(decodeVideoId(Buffer.from(JSON.stringify({ p: "p", l: "us-central1", m: "veo", o: "a/b" })).toString("base64url"))).toBeNull()
  })
})

describe("operationState", () => {
  const ctx = { id: "ID", model: "veo-3.1-generate-001" }
  test("running", () => {
    expect(operationState({ done: false }, ctx)).toEqual({ id: "ID", object: "video", model: "veo-3.1-generate-001", status: "in_progress", progress: 50 })
    expect(operationState({}, ctx).status).toBe("in_progress")
  })
  test("error", () => {
    expect(operationState({ done: true, error: { code: 3, message: "bad prompt" } }, ctx)).toMatchObject({ status: "failed", progress: 0, error: { code: "3", message: "bad prompt" } })
  })
  test("filtered", () => {
    const st = operationState({ done: true, response: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ["Unsafe content"] } }, ctx)
    expect(st).toMatchObject({ status: "failed", error: { code: "content_filtered", message: "Unsafe content" } })
    expect(operationState({ done: true, response: { raiMediaFilteredCount: 1 } }, ctx).error.message).toBe("视频未通过安全策略审核")
    expect(operationState({ done: true, response: {} }, ctx).error.code).toBe("content_filtered")
  })
  test("completed", () => {
    expect(operationState({ done: true, response: { videos: [{ bytesBase64Encoded: "AA==", mimeType: "video/mp4" }] } }, ctx)).toEqual({
      id: "ID",
      object: "video",
      model: "veo-3.1-generate-001",
      status: "completed",
      progress: 100,
    })
    expect(operationState({ done: true, response: { videos: [{ gcsUri: "gs://b/o.mp4" }] } }, ctx).status).toBe("completed")
  })
})

describe("result cache", () => {
  test("keeps few, for a short while", () => {
    let t = 0
    const c = createResultCache({ max: 2, ttlMs: 1000, now: () => t })
    c.set("a", 1)
    c.set("b", 2)
    c.set("c", 3)
    expect(c.get("a")).toBeUndefined()
    expect(c.get("c")).toBe(3)
    t = 2000
    expect(c.get("c")).toBeUndefined()
    expect(c.size).toBe(0)
  })
})

describe("gcsMediaURL", () => {
  test("encodes the object name", () => {
    expect(gcsMediaURL("gs://my-bucket/veo out/a b/sample_0.mp4")).toBe("https://storage.googleapis.com/storage/v1/b/my-bucket/o/veo%20out%2Fa%20b%2Fsample_0.mp4?alt=media")
  })
})

describe("status and content through the plugin", () => {
  let h
  afterEach(() => h?.stop())

  async function start() {
    const res = await h.create({ model: "veo-3.1-generate-001", prompt: "a cat" })
    const body = await res.json()
    const opId = String(h.mock.state.nextOp - 1)
    return { id: body.id, opId: `op-${opId}` }
  }

  test("in_progress then completed, then the inline MP4", async () => {
    h = await harness()
    const { id, opId } = await start()
    const b64 = MP4.toString("base64")
    h.mock.state.ops.set(opId, (n) => (n < 3 ? { done: false } : { done: true, response: { "@type": "x", videos: [{ bytesBase64Encoded: b64, mimeType: "video/mp4" }] } }))

    let res = await h.call(`/videos/${id}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id, object: "video", model: "veo-3.1-generate-001", status: "in_progress", progress: 50 })
    expect(h.mock.state.fetches[0].path).toBe("/v1/projects/demo-project/locations/us-central1/publishers/google/models/veo-3.1-generate-001:fetchPredictOperation")
    expect(h.mock.state.fetches[0].body).toEqual({ operationName: `projects/demo-project/locations/us-central1/publishers/google/models/veo-3.1-generate-001/operations/${opId}` })

    res = await h.call(`/videos/${id}/content`)
    expect(res.status).toBe(409)
    expect((await res.json()).error.message).toContain("尚未就绪")

    res = await h.call(`/videos/${id}`)
    expect(await res.json()).toMatchObject({ status: "completed", progress: 100, model: "veo-3.1-generate-001" })

    const fetchesBefore = h.mock.state.fetches.length
    res = await h.call(`/videos/${id}/content`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("video/mp4")
    expect(res.headers.get("content-length")).toBe(String(MP4.length))
    expect(Buffer.from(await res.arrayBuffer()).equals(MP4)).toBe(true)
    // served from the short-lived cache the completed poll filled
    expect(h.mock.state.fetches.length).toBe(fetchesBefore)

    // and asked again once it was handed out
    res = await h.call(`/videos/${id}/content`)
    expect(res.status).toBe(200)
    expect(h.mock.state.fetches.length).toBe(fetchesBefore + 1)
  })

  test("a Vertex error is a failed video", async () => {
    h = await harness()
    const { id, opId } = await start()
    h.mock.state.ops.set(opId, { done: true, error: { code: 3, message: "The prompt could not be processed" } })
    const res = await h.call(`/videos/${id}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id, object: "video", model: "veo-3.1-generate-001", status: "failed", progress: 0, error: { code: "3", message: "The prompt could not be processed" } })
    const c = await h.call(`/videos/${id}/content`)
    expect(c.status).toBe(409)
    expect((await c.json()).error.message).toContain("could not be processed")
  })

  test("a safety-filtered result is a failed video", async () => {
    h = await harness()
    const { id, opId } = await start()
    h.mock.state.ops.set(opId, { done: true, response: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ["Filtered: person"] } })
    const res = await h.call(`/videos/${id}`)
    expect(await res.json()).toMatchObject({ status: "failed", error: { code: "content_filtered", message: "Filtered: person" } })
  })

  test("a gs:// result is streamed from Cloud Storage with the same token", async () => {
    h = await harness({ metadata: { storageUri: "gs://veo-bucket/out/" } })
    const { id, opId } = await start()
    expect(h.mock.state.predicts[0].body.parameters.storageUri).toBe("gs://veo-bucket/out/")
    h.mock.state.gcs.set("veo-bucket/out/123/sample_0.mp4", MP4)
    h.mock.state.ops.set(opId, { done: true, response: { videos: [{ gcsUri: "gs://veo-bucket/out/123/sample_0.mp4", mimeType: "video/mp4" }] } })
    const res = await h.call(`/videos/${id}/content`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("video/mp4")
    expect(Buffer.from(await res.arrayBuffer()).equals(MP4)).toBe(true)
    expect(h.mock.state.gcsCalls[0]).toMatchObject({ bucket: "veo-bucket", object: "out/123/sample_0.mp4", alt: "media" })
    expect(h.mock.state.gcsCalls[0].token).toMatch(/^tok-/)
  })

  test("a missing GCS object is a 404 that keeps the sign-in", async () => {
    h = await harness()
    const { id, opId } = await start()
    h.mock.state.ops.set(opId, { done: true, response: { videos: [{ gcsUri: "gs://veo-bucket/missing.mp4" }] } })
    const res = await h.call(`/videos/${id}/content`)
    expect(res.status).toBe(404)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  })

  test("an id that isn't ours is a 404", async () => {
    h = await harness()
    const res = await h.call(`/videos/not-ours`)
    expect(res.status).toBe(404)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  })
})

describe("X-Magpie-Sign-In", () => {
  let h
  afterEach(() => h?.stop())

  for (const [status, code] of [[403, "permission_denied"], [404, "not_found"], [429, "rate_limited"]]) {
    test(`Vertex ${status} keeps the sign-in and passes the message on`, async () => {
      h = await harness()
      h.mock.state.predictStatus = status
      h.mock.state.predictBody = { error: { code: status, message: `vertex said ${status}`, status: "X" } }
      const res = await h.create({ model: "veo-3.1-generate-001", prompt: "p" })
      expect(res.status).toBe(status)
      expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
      const body = await res.json()
      expect(body.error.message).toContain(`vertex said ${status}`)
      expect(body.error.code).toBe(code)
    })
  }

  test("a Vertex 401 gets one retry with a fresh token", async () => {
    h = await harness()
    h.mock.state.rejectToken.add("tok-1")
    const res = await h.create({ model: "veo-3.1-generate-001", prompt: "p" })
    expect(res.status).toBe(200)
    expect(h.mock.state.tokenCalls).toBe(2)
    expect(h.mock.state.predicts[0].token).toBe("tok-2")
  })

  test("a Vertex 401 after a fresh token is expired", async () => {
    h = await harness()
    h.mock.state.rejectToken.add("tok-1").add("tok-2")
    const res = await h.create({ model: "veo-3.1-generate-001", prompt: "p" })
    expect(res.status).toBe(401)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
  })

  test("invalid_grant from Google's token endpoint is expired", async () => {
    h = await harness()
    h.mock.state.tokenStatus = 400
    const res = await h.create({ model: "veo-3.1-generate-001", prompt: "p" })
    expect(res.status).toBe(401)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
    expect((await res.json()).error.message).toContain("invalid_grant")
  })

  test("an unreadable key file is expired", async () => {
    h = await harness()
    h.setAuth({ type: "api", key: "file:/nope.json", metadata: { mode: "file", credentialsPath: "/nope.json" } })
    const res = await h.create({ model: "veo-3.1-generate-001", prompt: "p" })
    expect(res.status).toBe(401)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
  })

  test("a token endpoint outage is kept", async () => {
    h = await harness()
    h.mock.state.tokenStatus = 503
    h.mock.state.tokenBody = { error: "backend_error" }
    const res = await h.create({ model: "veo-3.1-generate-001", prompt: "p" })
    expect(res.status).toBe(502)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  })
})
