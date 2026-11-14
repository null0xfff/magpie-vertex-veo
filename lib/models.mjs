// The Veo models the plugin offers. Each is video-only: Magpie files a
// plugin model under its video makers (customVideomakers) only when its
// output says video and not text.

export const PROVIDER_ID = "vertex-veo"
export const PROVIDER_NAME = "Vertex AI Veo"
export const NPM = "@ai-sdk/openai-compatible"
// a real URL Magpie roots the /videos routes at; the plugin's fetch
// rewrites every request to the account's own regional endpoint
export const API_BASE = "https://us-central1-aiplatform.googleapis.com/v1"

// [id, display name]: the current Veo 3.1 family, offered by default
export const DEFAULT_MODELS = [
  ["veo-3.1-generate-001", "Veo 3.1"],
  ["veo-3.1-fast-generate-001", "Veo 3.1 Fast"],
  ["veo-3.1-lite-generate-001", "Veo 3.1 Lite"],
]

// older generations, offered when an account (or the environment) asks
export const LEGACY_MODELS = [
  ["veo-3.0-generate-001", "Veo 3"],
  ["veo-3.0-fast-generate-001", "Veo 3 Fast"],
  ["veo-2.0-generate-001", "Veo 2"],
]

export const DEFAULT_MODEL = DEFAULT_MODELS[0][0]

// MODEL_ID is what a Vertex publisher model id may be made of
export const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? "").trim())

export const legacyFromEnv = (env = process.env) => truthy(env.VERTEX_VEO_LEGACY_MODELS)

// extraModelIds are ids typed by the user (comma or space separated), and
// those the VERTEX_VEO_EXTRA_MODELS environment variable lists: a preview
// model Google ships before this plugin names it.
export function extraModelIds(text = "", env = process.env) {
  return [String(text ?? ""), String(env.VERTEX_VEO_EXTRA_MODELS ?? "")]
    .join(",")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => MODEL_ID.test(s))
}

// modelList is the [id, name] pairs to offer.
export function modelList({ legacy = false, extra = [] } = {}) {
  const out = [...DEFAULT_MODELS, ...(legacy ? LEGACY_MODELS : [])]
  for (const id of extra) if (!out.some(([m]) => m === id)) out.push([id, id])
  return out
}

// isVeo2 is whether a model is of the Veo 2 generation (no resolution, no
// audio, 5–8 second clips).
export const isVeo2 = (model) => /^veo-2\./.test(String(model))

// allowedDurations are the clip lengths in seconds a model makes.
export function allowedDurations(model) {
  return isVeo2(model) ? [5, 6, 7, 8] : [4, 6, 8]
}

// configModels is the list in OpenCode's config shape.
export function configModels(opts) {
  return Object.fromEntries(
    modelList(opts).map(([id, name]) => [
      id,
      {
        name,
        limit: { context: 0, output: 0 },
        tool_call: false,
        reasoning: false,
        attachment: false,
        modalities: { input: ["text", "image"], output: ["video"] },
      },
    ]),
  )
}

// runtimeModel is one model in the shape the provider.models hook returns.
export function runtimeModel(provider, id, name = id) {
  const url = provider?.api || API_BASE
  return {
    id,
    providerID: provider?.id ?? PROVIDER_ID,
    name,
    api: { id, url, npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 0, output: 0 },
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: false,
      toolcall: false,
      input: { text: true, image: true, audio: false, video: false, pdf: false },
      output: { text: false, image: false, audio: false, video: true, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

export function runtimeModels(provider, opts) {
  return Object.fromEntries(modelList(opts).map(([id, name]) => [id, runtimeModel(provider, id, name)]))
}
