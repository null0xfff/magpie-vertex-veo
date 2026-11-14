import { describe, test, expect } from "bun:test"
import { createVertexVeoPlugin } from "../lib/plugin.mjs"
import plugin, { VertexVeoPlugin } from "../index.mjs"
import * as entry from "../index.mjs"
import { DEFAULT_MODELS, LEGACY_MODELS, extraModelIds } from "../lib/models.mjs"

const provider = { id: "vertex-veo", api: "https://us-central1-aiplatform.googleapis.com/v1" }

describe("entry", () => {
  test("exports the plugin function alone (the host calls every exported function)", () => {
    const fns = [...new Set(Object.values(entry).filter((v) => typeof v === "function"))]
    expect(fns).toEqual([plugin])
    expect(VertexVeoPlugin).toBe(plugin)
  })
})

describe("config hook", () => {
  test("registers the provider with a real API URL and video-only models", async () => {
    const hooks = await createVertexVeoPlugin({ env: {} })({ client: {} })
    const cfg = {}
    await hooks.config(cfg)
    const p = cfg.provider["vertex-veo"]
    expect(p.name).toBe("Vertex AI Veo")
    expect(p.npm).toBe("@ai-sdk/openai-compatible")
    expect(new URL(p.api).protocol).toBe("https:")
    expect(Object.keys(p.models)).toEqual(DEFAULT_MODELS.map(([id]) => id))
    for (const m of Object.values(p.models)) {
      expect(m).toMatchObject({
        limit: { context: 0, output: 0 },
        tool_call: false,
        reasoning: false,
        attachment: false,
        modalities: { input: ["text", "image"], output: ["video"] },
      })
    }
  })

  test("keeps what the user configured and adds legacy models when asked", async () => {
    const hooks = await createVertexVeoPlugin({ env: { VERTEX_VEO_LEGACY_MODELS: "1" } })({ client: {} })
    const cfg = { provider: { "vertex-veo": { options: { x: 1 }, models: { "my-veo": { name: "mine" } } } } }
    await hooks.config(cfg)
    const p = cfg.provider["vertex-veo"]
    expect(p.options).toEqual({ x: 1 })
    expect(p.models["my-veo"]).toEqual({ name: "mine" })
    for (const [id] of LEGACY_MODELS) expect(p.models[id]).toBeDefined()
  })
})

describe("provider.models", () => {
  test("every model outputs video and never text", async () => {
    const hooks = await createVertexVeoPlugin({ env: {} })({ client: {} })
    expect(hooks.provider.id).toBe("vertex-veo")
    const models = await hooks.provider.models(provider, { auth: undefined })
    expect(Object.keys(models)).toEqual(["veo-3.1-generate-001", "veo-3.1-fast-generate-001", "veo-3.1-lite-generate-001"])
    for (const [id, m] of Object.entries(models)) {
      expect(m.id).toBe(id)
      expect(m.providerID).toBe("vertex-veo")
      expect(m.capabilities.output.video).toBe(true)
      expect(m.capabilities.output.text).toBe(false)
      expect(m.capabilities).toEqual({
        temperature: false,
        reasoning: false,
        attachment: false,
        toolcall: false,
        input: { text: true, image: true, audio: false, video: false, pdf: false },
        output: { text: false, image: false, audio: false, video: true, pdf: false },
        interleaved: false,
      })
    }
  })

  test("an account that asked for them gets the older generations and extra ids", async () => {
    const hooks = await createVertexVeoPlugin({ env: {} })({ client: {} })
    const models = await hooks.provider.models(provider, {
      auth: { type: "api", key: "file:/x.json", metadata: { legacyModels: true, extraModels: "veo-3.1-generate-preview, BAD ID" } },
    })
    expect(Object.keys(models)).toContain("veo-2.0-generate-001")
    expect(Object.keys(models)).toContain("veo-3.0-fast-generate-001")
    expect(Object.keys(models)).toContain("veo-3.1-generate-preview")
    expect(Object.keys(models)).not.toContain("BAD ID")
    expect(models["veo-3.1-generate-preview"].capabilities.output).toMatchObject({ text: false, video: true })
  })

  test("extra ids are filtered to valid model ids", () => {
    expect(extraModelIds("a-1 b_2,,c.3 Ünï", { VERTEX_VEO_EXTRA_MODELS: "d-4" })).toEqual(["a-1", "b_2", "c.3", "d-4"])
  })
})
