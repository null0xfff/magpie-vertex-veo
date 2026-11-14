import { describe, test, expect, afterEach, afterAll } from "bun:test"
import { createVertexVeoPlugin } from "../lib/plugin.mjs"
import { serviceAccount, startMock, writeKeyFile, removeKeyFiles } from "./helpers.mjs"

afterAll(removeKeyFiles)

let mock
afterEach(() => mock?.stop())

async function hooksFor(env = {}) {
  mock = startMock()
  return createVertexVeoPlugin({ apiBase: `${mock.base}/v1`, gcsBase: mock.base, env })({ client: {} })
}

describe("auth.methods", () => {
  test("three headless API methods, none of them a browser OAuth", async () => {
    const hooks = await hooksFor()
    expect(hooks.auth.provider).toBe("vertex-veo")
    const ms = hooks.auth.methods
    expect(ms.map((m) => m.type)).toEqual(["api", "api", "api"])
    for (const m of ms) {
      expect(typeof m.authorize).toBe("function")
      expect(m.prompts.length).toBeGreaterThan(0)
      const keys = m.prompts.map((p) => p.key)
      for (const k of ["projectId", "location", "storageUri", "accountLabel"]) expect(keys).toContain(k)
    }
    expect(ms[0].prompts[0].key).toBe("credentialsPath")
    expect(ms[1].prompts[0].key).toBe("credentialsJson")
  })

  test("key file: verified with a token, kept as file:<path> with settings in metadata", async () => {
    const hooks = await hooksFor()
    const p = writeKeyFile(serviceAccount(mock.tokenUri))
    const r = await hooks.auth.methods[0].authorize({ credentialsPath: p, projectId: "", location: "", storageUri: "gs://b/veo/", accountLabel: "still-function", legacyModels: "yes" })
    expect(r.type).toBe("success")
    expect(r.key).toBe(`file:${p}`)
    expect(r.metadata).toMatchObject({ mode: "file", credentialsPath: p, location: "us-central1", storageUri: "gs://b/veo/", accountLabel: "still-function", legacyModels: true })
    expect(r.metadata.email).toContain("still-function")
    expect(JSON.stringify(r.metadata)).not.toContain("PRIVATE KEY")
    expect(mock.state.tokenCalls).toBe(1)
  })

  test("key file: wrong path, refused key, bad location fail with a reason", async () => {
    const hooks = await hooksFor()
    const m = hooks.auth.methods[0]
    expect(await m.authorize({ credentialsPath: "/nope/sa.json" })).toMatchObject({ type: "failed" })
    const p = writeKeyFile(serviceAccount(mock.tokenUri))
    expect((await m.authorize({ credentialsPath: p, location: "Not A Region" })).error).toContain("location")
    expect((await m.authorize({ credentialsPath: p, storageUri: "s3://x" })).error).toContain("gs://")
    mock.state.tokenStatus = 400
    const r = await m.authorize({ credentialsPath: p })
    expect(r.type).toBe("failed")
    expect(r.error).toContain("invalid_grant")
  })

  test("pasted JSON: validated, kept as the account's key", async () => {
    const hooks = await hooksFor()
    const m = hooks.auth.methods[1]
    const prompt = m.prompts[0]
    expect(prompt.validate("{oops")).toContain("not valid JSON")
    expect(prompt.validate(JSON.stringify({ type: "service_account", client_email: "x" }))).toContain("private_key")
    const sa = serviceAccount(mock.tokenUri)
    expect(prompt.validate(JSON.stringify(sa, null, 2))).toBeUndefined()
    const r = await m.authorize({ credentialsJson: JSON.stringify(sa, null, 2), location: "us-central1" })
    expect(r.type).toBe("success")
    expect(JSON.parse(r.key).client_email).toBe(sa.client_email)
    expect(r.metadata.mode).toBe("json")
    expect(JSON.stringify(r.metadata)).not.toContain("PRIVATE KEY")
  })

  test("pasted JSON without project_id needs a project id", async () => {
    const hooks = await hooksFor()
    const sa = serviceAccount(mock.tokenUri, { project_id: undefined })
    const m = hooks.auth.methods[1]
    expect((await m.authorize({ credentialsJson: JSON.stringify(sa) })).error).toContain("project")
    expect((await m.authorize({ credentialsJson: JSON.stringify(sa), projectId: "given-project" })).type).toBe("success")
  })

  test("ADC from GOOGLE_APPLICATION_CREDENTIALS", async () => {
    mock = startMock()
    const p = writeKeyFile(serviceAccount(mock.tokenUri))
    const hooks = await createVertexVeoPlugin({ apiBase: `${mock.base}/v1`, env: { GOOGLE_APPLICATION_CREDENTIALS: p } })({ client: {} })
    const r = await hooks.auth.methods[2].authorize({})
    expect(r).toMatchObject({ type: "success", key: "adc:default", metadata: { mode: "adc", projectId: "demo-project" } })
  })

  test("a pasted-JSON account makes videos", async () => {
    const hooks = await hooksFor()
    const sa = serviceAccount(mock.tokenUri)
    const r = await hooks.auth.methods[1].authorize({ credentialsJson: JSON.stringify(sa) })
    const loaded = await hooks.auth.loader(async () => ({ type: "api", key: r.key, metadata: r.metadata }))
    expect(loaded.apiKey).toBe("vertex-veo")
    expect(new URL(loaded.baseURL).protocol).toBe("https:")
    const res = await loaded.fetch("https://x/v1/videos", { method: "POST", body: JSON.stringify({ model: "veo-3.1-generate-001", prompt: "p" }) })
    expect(res.status).toBe(200)
    expect(mock.state.predicts[0].path).toContain("/projects/demo-project/")
  })

  test("two accounts never share a token or a project", async () => {
    const hooks = await hooksFor()
    const a = writeKeyFile(serviceAccount(mock.tokenUri, { project_id: "proj-a", client_email: "a@proj-a.iam.gserviceaccount.com" }))
    const b = writeKeyFile(serviceAccount(mock.tokenUri, { project_id: "proj-b", client_email: "b@proj-b.iam.gserviceaccount.com" }))
    const la = await hooks.auth.loader(async () => ({ type: "api", key: `file:${a}`, metadata: { mode: "file", credentialsPath: a } }))
    const lb = await hooks.auth.loader(async () => ({ type: "api", key: `file:${b}`, metadata: { mode: "file", credentialsPath: b } }))
    const body = JSON.stringify({ model: "veo-3.1-generate-001", prompt: "p" })
    await Promise.all([la.fetch("https://x/v1/videos", { method: "POST", body }), lb.fetch("https://x/v1/videos", { method: "POST", body })])
    const byProject = Object.fromEntries(mock.state.predicts.map((p) => [p.path.split("/")[3], p.token]))
    expect(Object.keys(byProject).sort()).toEqual(["proj-a", "proj-b"])
    expect(byProject["proj-a"]).not.toBe(byProject["proj-b"])
  })
})
