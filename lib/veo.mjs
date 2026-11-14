// OpenAI Videos API <-> Vertex AI Veo REST: request bodies, the video id
// that carries a Vertex operation, and what an operation says as an
// OpenAI video object.

import { allowedDurations, isVeo2, MODEL_ID } from "./models.mjs"

// RequestError is a request this plugin can't turn into a Vertex one: the
// caller's to fix (400), never the sign-in's.
export class RequestError extends Error {
  constructor(message, status = 400, code = "invalid_request") {
    super(message)
    this.name = "RequestError"
    this.status = status
    this.code = code
  }
}

// ---- endpoints ---------------------------------------------------------------

const LOCATION = /^[a-z0-9-]{1,64}$/
const PROJECT = /^[a-z0-9][a-z0-9.:-]{0,127}$/i

// apiRoot is the Vertex endpoint for a location; override (tests, a
// private endpoint) replaces it.
export function apiRoot(location, override = "") {
  if (override) return String(override).replace(/\/+$/, "")
  return location === "global" ? "https://aiplatform.googleapis.com/v1" : `https://${location}-aiplatform.googleapis.com/v1`
}

export function modelPath(project, location, model) {
  return `projects/${project}/locations/${location}/publishers/google/models/${model}`
}

export function predictURL(ref, override) {
  return `${apiRoot(ref.location, override)}/${modelPath(ref.project, ref.location, ref.model)}:predictLongRunning`
}

export function fetchOperationURL(ref, override) {
  return `${apiRoot(ref.location, override)}/${modelPath(ref.project, ref.location, ref.model)}:fetchPredictOperation`
}

export function operationName(ref) {
  return `${modelPath(ref.project, ref.location, ref.model)}/operations/${ref.opId}`
}

const OPERATION = /^projects\/([^/]+)\/locations\/([^/]+)\/publishers\/google\/models\/([^/]+)\/operations\/([^/]+)$/

// parseOperationName is the parts of a Veo long-running operation's name.
export function parseOperationName(name) {
  const m = OPERATION.exec(String(name ?? ""))
  return m ? { project: m[1], location: m[2], model: m[3], opId: m[4] } : null
}

export function validRef(ref) {
  return (
    !!ref &&
    PROJECT.test(ref.project ?? "") &&
    LOCATION.test(ref.location ?? "") &&
    MODEL_ID.test(ref.model ?? "") &&
    /^[A-Za-z0-9._-]{1,256}$/.test(ref.opId ?? "")
  )
}

// ---- the video id ------------------------------------------------------------

// encodeVideoId is an operation as an id of [A-Za-z0-9_-] alone: Magpie
// puts it in a URL path, where a slash or %2F would not survive.
export function encodeVideoId(ref) {
  return Buffer.from(JSON.stringify({ p: ref.project, l: ref.location, m: ref.model, o: ref.opId }), "utf8").toString("base64url")
}

// decodeVideoId is the operation an id names, or null for one that isn't
// this plugin's.
export function decodeVideoId(id) {
  const s = String(id ?? "")
  if (!s || s.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(s)) return null
  try {
    const j = JSON.parse(Buffer.from(s, "base64url").toString("utf8"))
    const ref = { project: j?.p, location: j?.l, model: j?.m, opId: j?.o }
    return validRef(ref) ? ref : null
  } catch {
    return null
  }
}

// ---- images ------------------------------------------------------------------

const EXT_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp", heic: "image/heic" }

const mimeOfPath = (p) => EXT_MIME[String(p).split(/[?#]/)[0].split(".").pop()?.toLowerCase()] ?? "image/png"

// vertexImage is an image as Veo takes it: from a data URL (what Magpie
// sends), a gs:// object, or an object already in Vertex's shape.
export function vertexImage(src, field = "image") {
  if (src && typeof src === "object") {
    if (typeof src.bytesBase64Encoded === "string" || typeof src.gcsUri === "string") {
      return { ...src, mimeType: src.mimeType || (src.gcsUri ? mimeOfPath(src.gcsUri) : "image/png") }
    }
    const url = src.url ?? src.image_url?.url ?? src.image_url
    if (typeof url === "string") return vertexImage(url, field)
    throw new RequestError(`${field}: unsupported image object`)
  }
  const s = String(src ?? "").trim()
  const data = /^data:([^;,]+)?((?:;[^;,=]+=[^;,]*)*);base64,(.*)$/s.exec(s)
  if (data) {
    const b64 = data[3].replace(/\s+/g, "")
    if (!b64) throw new RequestError(`${field}: empty data URL`)
    return { bytesBase64Encoded: b64, mimeType: data[1] || "image/png" }
  }
  if (/^gs:\/\/[^/]+\/.+/.test(s)) return { gcsUri: s, mimeType: mimeOfPath(s) }
  throw new RequestError(`${field}: give the image as a data:<mime>;base64,… URL or a gs:// URI`)
}

const asList = (v) => (v === undefined || v === null || v === "" ? [] : Array.isArray(v) ? v : [v])

// ---- size and length ---------------------------------------------------------

// sizeParams is what a size says as Veo's aspectRatio and resolution.
export function sizeParams(size) {
  const s = String(size ?? "").trim().toLowerCase()
  if (!s) return {}
  if (s === "16:9" || s === "9:16") return { aspectRatio: s }
  if (s === "720p" || s === "1080p" || s === "4k") return { resolution: s }
  if (s === "2160p") return { resolution: "4k" }
  const ratio = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(s)
  if (ratio) {
    const w = Number(ratio[1])
    const h = Number(ratio[2])
    if (w > 0 && h > 0) return { aspectRatio: w >= h ? "16:9" : "9:16" }
  }
  const px = /^(\d+)\s*[x*×]\s*(\d+)$/.exec(s)
  if (px) {
    const w = Number(px[1])
    const h = Number(px[2])
    if (w > 0 && h > 0) {
      const short = Math.min(w, h)
      return { aspectRatio: w >= h ? "16:9" : "9:16", resolution: short >= 2160 ? "4k" : short >= 1080 ? "1080p" : "720p" }
    }
  }
  throw new RequestError(`size "${size}" isn't one Veo makes: use 16:9, 9:16, 720p, 1080p, 4k or WIDTHxHEIGHT such as 1280x720`)
}

// durationFor is the clip length to ask a model for: the nearest it makes
// to what was asked (the longer on a tie), 8 when nothing was asked.
export function durationFor(model, seconds) {
  const allowed = allowedDurations(model)
  if (seconds === undefined || seconds === null || String(seconds).trim() === "") return 8
  const n = Number(String(seconds).trim())
  if (!Number.isFinite(n) || n <= 0) throw new RequestError(`seconds must be a positive number, not "${seconds}"`)
  let best = allowed[0]
  for (const a of allowed) if (Math.abs(a - n) < Math.abs(best - n) || (Math.abs(a - n) === Math.abs(best - n) && a > best)) best = a
  return best
}

// ---- the create request -------------------------------------------------------

const pick = (body, ...keys) => {
  for (const k of keys) if (body[k] !== undefined && body[k] !== null && body[k] !== "") return body[k]
  return undefined
}

const bool = (v) => (typeof v === "boolean" ? v : /^(1|true|yes|on)$/i.test(String(v)) ? true : /^(0|false|no|off)$/i.test(String(v)) ? false : undefined)

// predictBody is an OpenAI-shaped create request as Veo's
// predictLongRunning body. storageUri is the account's GCS prefix ("" for
// the video bytes in the answer itself).
export function predictBody(body, { model, storageUri = "" } = {}) {
  if (!body || typeof body !== "object") throw new RequestError("the request body must be a JSON object")
  model = model || String(body.model ?? "")
  const prompt = typeof body.prompt === "string" ? body.prompt : ""
  const instance = {}
  if (prompt.trim()) instance.prompt = prompt
  const first = pick(body, "input_reference", "image")
  if (first !== undefined) instance.image = vertexImage(Array.isArray(first) ? first[0] : first, "input_reference")
  const last = pick(body, "last_frame", "lastFrame")
  if (last !== undefined) instance.lastFrame = vertexImage(Array.isArray(last) ? last[0] : last, "last_frame")
  const refs = asList(pick(body, "reference_images", "reference_images[]", "referenceImages"))
  if (refs.length) {
    if (refs.length > 3) throw new RequestError("reference_images: Veo takes at most 3 reference images")
    instance.referenceImages = refs.map((r, i) => {
      const type = r && typeof r === "object" && typeof r.referenceType === "string" ? r.referenceType : "asset"
      const img = r && typeof r === "object" && r.image ? r.image : r
      return { image: vertexImage(img, `reference_images[${i}]`), referenceType: type }
    })
  }
  if (!instance.prompt && !instance.image) throw new RequestError("say what to film in prompt")

  const parameters = {}
  const n = Number(pick(body, "sampleCount", "sample_count", "n") ?? 1)
  if (!Number.isInteger(n) || n < 1 || n > 4) throw new RequestError("n / sampleCount must be a whole number from 1 to 4")
  parameters.sampleCount = n
  parameters.durationSeconds = durationFor(model, pick(body, "seconds", "durationSeconds", "duration_seconds", "duration"))

  const fromSize = sizeParams(body.size)
  const aspect = pick(body, "aspect_ratio", "aspectRatio") ?? fromSize.aspectRatio
  if (aspect !== undefined) {
    const a = String(aspect).trim()
    if (a !== "16:9" && a !== "9:16") throw new RequestError(`aspect_ratio "${aspect}" isn't one Veo makes: 16:9 or 9:16`)
    parameters.aspectRatio = a
  }
  const resolution = pick(body, "resolution") ?? fromSize.resolution
  if (resolution !== undefined && !isVeo2(model)) parameters.resolution = String(resolution).trim().toLowerCase()

  const storage = String(pick(body, "storage_uri", "storageUri") ?? storageUri ?? "").trim()
  if (storage) {
    if (!/^gs:\/\/[^/]+/.test(storage)) throw new RequestError(`storage_uri must be a gs:// URI, not "${storage}"`)
    parameters.storageUri = storage
  }

  const negative = pick(body, "negativePrompt", "negative_prompt")
  if (negative !== undefined) parameters.negativePrompt = String(negative)
  const person = pick(body, "personGeneration", "person_generation")
  if (person !== undefined) parameters.personGeneration = String(person)
  const audio = bool(pick(body, "generateAudio", "generate_audio"))
  if (audio !== undefined && !isVeo2(model)) parameters.generateAudio = audio
  else if (audio === undefined && /^veo-3\./.test(model)) parameters.generateAudio = true
  const seed = pick(body, "seed")
  if (seed !== undefined) {
    const s = Number(seed)
    if (!Number.isInteger(s) || s < 0 || s > 4294967295) throw new RequestError("seed must be a whole number from 0 to 4294967295")
    parameters.seed = s
  }
  const enhance = bool(pick(body, "enhancePrompt", "enhance_prompt"))
  if (enhance !== undefined) parameters.enhancePrompt = enhance
  const quality = pick(body, "compressionQuality", "compression_quality")
  if (quality !== undefined) parameters.compressionQuality = String(quality)
  const resize = pick(body, "resizeMode", "resize_mode")
  if (resize !== undefined) parameters.resizeMode = String(resize)

  return { instances: [instance], parameters }
}

// ---- an operation as a video ---------------------------------------------------

// videoOf is the first video an operation made, or null.
export function videoOf(op) {
  const r = op?.response ?? {}
  const list = Array.isArray(r.videos) ? r.videos : Array.isArray(r.generatedSamples) ? r.generatedSamples.map((s) => s?.video) : []
  return list.find((v) => v && (typeof v.bytesBase64Encoded === "string" || typeof v.gcsUri === "string")) ?? null
}

// operationState is an operation as OpenAI's video object has it.
export function operationState(op, { id, model, seconds } = {}) {
  const base = { id, object: "video", model }
  if (seconds) base.seconds = String(seconds)
  if (op?.error && (op.error.code || op.error.message)) {
    return {
      ...base,
      status: "failed",
      progress: 0,
      error: { code: String(op.error.code ?? "vertex_error"), message: op.error.message || "Vertex operation failed" },
    }
  }
  if (op?.done !== true) {
    const p = Number(op?.metadata?.progressPercent ?? op?.metadata?.progress)
    return { ...base, status: "in_progress", progress: Number.isFinite(p) && p > 0 && p < 100 ? Math.round(p) : 50 }
  }
  const video = videoOf(op)
  if (!video) {
    const r = op?.response ?? {}
    const filtered = Number(r.raiMediaFilteredCount ?? 0) > 0
    return {
      ...base,
      status: "failed",
      progress: 0,
      error: {
        code: "content_filtered",
        message: (Array.isArray(r.raiMediaFilteredReasons) && r.raiMediaFilteredReasons[0]) || (filtered ? "Video filtered by safety policy" : "Vertex returned no video (it may have been filtered by safety policy)"),
      },
    }
  }
  return { ...base, status: "completed", progress: 100 }
}

// ---- a short-lived cache of finished operations ---------------------------------

// createResultCache keeps the last few finished operations (a finished
// one's answer holds the whole video in base64), so the content request
// that follows the poll that saw it finish doesn't fetch it again. Small
// and short-lived: the host watches its memory.
export function createResultCache({ max = 2, ttlMs = 120_000, now = Date.now } = {}) {
  const m = new Map()
  const sweep = () => {
    for (const [k, v] of m) if (now() - v.at > ttlMs) m.delete(k)
  }
  return {
    get(key) {
      sweep()
      return m.get(key)?.op
    },
    set(key, op) {
      sweep()
      m.delete(key)
      m.set(key, { op, at: now() })
      while (m.size > max) m.delete(m.keys().next().value)
    },
    delete(key) {
      m.delete(key)
    },
    get size() {
      sweep()
      return m.size
    },
  }
}

// gcsMediaURL is where the GCS JSON API serves a gs:// object's bytes.
export function gcsMediaURL(gcsUri, base = "https://storage.googleapis.com") {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(String(gcsUri ?? ""))
  if (!m) throw new RequestError(`not a gs:// URI: ${gcsUri}`, 502, "vertex_error")
  return `${String(base).replace(/\/+$/, "")}/storage/v1/b/${encodeURIComponent(m[1])}/o/${encodeURIComponent(m[2])}?alt=media`
}

// videoRequest is the OpenAI videos request at path, and its parts.
export function videoRequest(method, path) {
  const m = String(method ?? "GET").toUpperCase()
  if (/\/videos\/?$/.test(path)) return m === "POST" ? { kind: "create" } : null
  const v = /\/videos\/([^/]+)(\/content)?\/?$/.exec(path)
  if (!v || m !== "GET") return null
  let id
  try {
    id = decodeURIComponent(v[1])
  } catch {
    id = v[1]
  }
  return { kind: v[2] ? "content" : "status", id }
}
