// Magpie & OpenCode provider plugin for Google Vertex AI Veo. Magpie asks a
// plugin's video models at an OpenAI-shaped videos API (POST /videos,
// GET /videos/{id}, GET /videos/{id}/content) through the plugin's fetch;
// this one answers it from Vertex AI's long-running Veo operations
// (:predictLongRunning, :fetchPredictOperation), signed in with a service
// account key file, pasted key JSON, or Application Default Credentials.

import {
  AuthError,
  DEFAULT_LOCATION,
  accountOf,
  createTokenSource,
  metadataProject,
  parseCredentialJSON,
  readCredentialFile,
  resolveCredential,
} from "./credentials.mjs"
import {
  API_BASE,
  NPM,
  PROVIDER_ID,
  PROVIDER_NAME,
  configModels,
  extraModelIds,
  legacyFromEnv,
  runtimeModels,
  MODEL_ID,
} from "./models.mjs"
import {
  RequestError,
  createResultCache,
  decodeVideoId,
  encodeVideoId,
  fetchOperationURL,
  gcsMediaURL,
  operationName,
  operationState,
  parseOperationName,
  predictBody,
  predictURL,
  videoOf,
  videoRequest,
} from "./veo.mjs"

const PROJECT_RE = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$|^[a-z0-9.:-]{1,128}$/i
const LOCATION_RE = /^[a-z0-9-]{1,64}$/
const MULTI_REGION_LOCATIONS = new Set(["us", "eu"])

// ---- responses ----------------------------------------------------------------

function json(status, body, signIn) {
  const headers = { "Content-Type": "application/json" }
  if (signIn) headers["X-Magpie-Sign-In"] = signIn
  return new Response(JSON.stringify(body), { status, headers })
}

function errorResponse(status, message, { signIn = "kept", code, type } = {}) {
  return json(
    status,
    {
      error: {
        message,
        type: type ?? (status === 401 ? "authentication_error" : status === 400 ? "invalid_request_error" : "api_error"),
        ...(code ? { code } : {}),
      },
    },
    signIn,
  )
}

// vertexMessage is what Vertex said of a refusal, in its own words.
function vertexMessage(text, status) {
  try {
    const j = JSON.parse(text)
    const e = Array.isArray(j) ? j[0]?.error : j?.error
    if (e?.message) return `${e.status ? e.status + ": " : ""}${e.message}`
  } catch {}
  const t = String(text ?? "").trim()
  return t ? t.slice(0, 500) : `HTTP ${status}`
}

async function bodyText(req, init) {
  const b = init?.body
  if (b !== undefined && b !== null) {
    if (typeof b === "string") return b
    if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return Buffer.from(b.buffer ? b.buffer : b).toString("utf8")
    if (typeof b.text === "function") return await b.text()
    return await new Response(b).text()
  }
  return req ? await req.clone().text() : ""
}

// ---- a request's account --------------------------------------------------------

// session is everything a request needs of the account it runs on: the
// credential, the project and location, a token getter.
async function session(getAuth, tokens, env) {
  let auth
  try {
    auth = await getAuth()
  } catch (e) {
    throw new AuthError(`无法读取该账号配置：${e?.message ?? e}`)
  }
  if (!auth || auth.type !== "api") throw new AuthError("未登录：请在 Magpie 中添加 Vertex AI 服务账号")
  const account = accountOf(auth)
  const cred = resolveCredential(account, env)
  let projectId = account.projectId || cred.projectId
  if (!projectId && cred.type === "metadata") projectId = await metadataProject()
  if (!projectId) throw new AuthError("未指定 Google Cloud 项目：请在登录时填写 projectId，或使用包含 project_id 的密钥文件")
  if (!PROJECT_RE.test(projectId)) throw new AuthError(`"${projectId}" 不是有效的 Google Cloud 项目 ID`)
  if (!LOCATION_RE.test(account.location)) throw new AuthError(`"${account.location}" 不是有效的 Vertex AI 区域`)
  if (MULTI_REGION_LOCATIONS.has(account.location.toLowerCase())) {
    throw new AuthError(`Vertex AI Veo 不支持多区域 "${account.location}"，请在账号设置中使用具体区域（例如 us-central1）`, { signIn: "kept", status: 400 })
  }
  return {
    account,
    cred,
    projectId,
    location: account.location,
    token: () => tokens.token(cred, projectId),
    invalidate: () => tokens.invalidate(cred, projectId),
  }
}

// vertexFetch sends one request with the session's token: a 401 drops the
// cached token and tries once more with a new one.
async function vertexFetch(s, url, init = {}) {
  for (let attempt = 0; ; attempt++) {
    const token = await s.token()
    const headers = new Headers(init.headers)
    headers.set("Authorization", `Bearer ${token}`)
    if (s.cred.type === "authorized_user") headers.set("x-goog-user-project", s.projectId)
    const res = await fetch(url, { ...init, headers })
    if (res.status === 401 && attempt === 0) {
      await res.body?.cancel?.().catch(() => {})
      s.invalidate()
      continue
    }
    return res
  }
}

// vertexFailure is a non-2xx Vertex answer as the caller's answer. A 401
// after a fresh token means the credential itself is no longer good; a 403
// (no Veo access, no quota), a 404 (a model the region lacks), a 429 and
// the rest leave the sign-in as it is.
async function vertexFailure(res, what) {
  const text = await res.text().catch(() => "")
  const msg = `Vertex AI ${what} 请求失败（${res.status}）：${vertexMessage(text, res.status)}`
  if (res.status === 401) return errorResponse(401, msg, { signIn: "expired", code: "unauthenticated" })
  const code = { 400: "invalid_request", 403: "permission_denied", 404: "not_found", 429: "rate_limited" }[res.status] ?? "vertex_error"
  return errorResponse(res.status >= 400 && res.status < 600 ? res.status : 502, msg, { signIn: "kept", code })
}

// ---- the three video routes --------------------------------------------------------

const bareModel = (m) => String(m ?? "").trim().replace(new RegExp(`^${PROVIDER_ID}/`), "")

async function createVideo(s, body, opts) {
  const model = bareModel(body?.model) || opts.defaultModel
  if (!MODEL_ID.test(model)) throw new RequestError(`"${model}" 不是有效的 Veo 模型 ID`)
  const payload = predictBody(body, { model, storageUri: s.account.storageUri })
  const ref = { project: s.projectId, location: s.location, model }
  const res = await vertexFetch(s, predictURL(ref, opts.apiBase), {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) return vertexFailure(res, "predictLongRunning")
  const op = await res.json().catch(() => ({}))
  const parsed = parseOperationName(op?.name)
  if (!parsed) return errorResponse(502, `Vertex AI 未返回视频操作任务（响应：${JSON.stringify(op).slice(0, 300)}）`)
  const id = encodeVideoId(parsed)
  return json(200, {
    id,
    object: "video",
    model,
    status: "queued",
    progress: 0,
    created_at: Math.floor(Date.now() / 1000),
    seconds: String(payload.parameters.durationSeconds),
    ...(body?.size ? { size: String(body.size) } : {}),
    ...(typeof body?.prompt === "string" && body.prompt ? { prompt: body.prompt } : {}),
  })
}

// readOperation asks Vertex how the operation an id names is going; a
// finished one is kept a short while for the content request after it.
async function readOperation(s, id, opts) {
  const ref = decodeVideoId(id)
  if (!ref) throw new RequestError(`"${String(id).slice(0, 80)}" 不是有效的 Vertex Veo 视频 ID`, 404, "not_found")
  const cached = opts.results.get(id)
  if (cached) return { ref, op: cached }
  const res = await vertexFetch(s, fetchOperationURL(ref, opts.apiBase), {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ operationName: operationName(ref) }),
    signal: AbortSignal.timeout(300_000),
  })
  if (!res.ok) return { ref, failure: await vertexFailure(res, "fetchPredictOperation") }
  const op = await res.json().catch(() => null)
  if (!op || typeof op !== "object") return { ref, failure: errorResponse(502, "Vertex AI 返回的任务状态不是有效 JSON") }
  if (op.done === true && videoOf(op)) opts.results.set(id, op)
  return { ref, op }
}

async function videoStatus(s, id, opts) {
  const { ref, op, failure } = await readOperation(s, id, opts)
  if (failure) return failure
  return json(200, operationState(op, { id, model: ref.model }))
}

async function videoContent(s, id, opts) {
  const { ref, op, failure } = await readOperation(s, id, opts)
  if (failure) return failure
  const state = operationState(op, { id, model: ref.model })
  if (state.status !== "completed") {
    const msg =
      state.status === "failed"
        ? `视频生成失败：${state.error?.message ?? "未知错误"}`
        : `视频尚未就绪（当前状态：${state.status}）`
    return errorResponse(409, msg, { code: state.status === "failed" ? state.error?.code ?? "failed" : "not_ready" })
  }
  const video = videoOf(op)
  const type = video.mimeType || "video/mp4"
  if (typeof video.bytesBase64Encoded === "string") {
    const bytes = Buffer.from(video.bytesBase64Encoded, "base64")
    // the bytes are the caller's now: keep no copy of them
    opts.results.delete(id)
    return new Response(bytes, { status: 200, headers: { "Content-Type": type, "Content-Length": String(bytes.length) } })
  }
  const res = await vertexFetch(s, gcsMediaURL(video.gcsUri, opts.gcsBase), { signal: AbortSignal.timeout(10 * 60_000) })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    const code = res.status === 401 ? 401 : res.status === 404 ? 404 : res.status === 403 ? 403 : 502
    return errorResponse(code, `无法从 Cloud Storage 读取 ${video.gcsUri}（${res.status}）：${vertexMessage(text, res.status)}`, {
      signIn: res.status === 401 ? "expired" : "kept",
      code: "gcs_error",
    })
  }
  const headers = { "Content-Type": res.headers.get("content-type")?.startsWith("video/") ? res.headers.get("content-type") : type }
  const len = res.headers.get("content-length")
  if (len) headers["Content-Length"] = len
  return new Response(res.body, { status: 200, headers })
}

// ---- signing in ---------------------------------------------------------------------

const text = (v) => (typeof v === "string" ? v.trim() : "")

function checkCommon(inputs) {
  const location = text(inputs.location) || DEFAULT_LOCATION
  if (!LOCATION_RE.test(location)) throw new Error(`"${location}" 不是有效的 Vertex AI 区域名称（例如 us-central1）`)
  if (MULTI_REGION_LOCATIONS.has(location.toLowerCase())) {
    throw new Error(`Vertex AI Veo 不支持多区域 "${location}"，请填写具体区域（例如 us-central1）`)
  }
  const storageUri = text(inputs.storageUri)
  if (storageUri && !/^gs:\/\/[^/]+/.test(storageUri)) throw new Error("storageUri 必须以 gs:// 开头")
  const projectId = text(inputs.projectId)
  if (projectId && !PROJECT_RE.test(projectId)) throw new Error(`"${projectId}" 不是有效的 Google Cloud 项目 ID`)
  return { location, storageUri, projectId }
}

// verifySignIn trades the credential for a token once, so a wrong key is
// told at sign-in rather than at the first video.
async function verifySignIn(cred, projectId, tokens) {
  await tokens.token(cred, projectId)
}

function signedIn({ key, mode, cred, common, inputs, credentialsPath }) {
  const projectId = common.projectId || cred.projectId
  const label = text(inputs.accountLabel)
  const who = cred.clientEmail || (cred.type === "authorized_user" ? "gcloud 用户" : "元数据服务器")
  const metadata = {
    mode,
    ...(credentialsPath ? { credentialsPath } : {}),
    ...(common.projectId ? { projectId: common.projectId } : {}),
    location: common.location,
    ...(common.storageUri ? { storageUri: common.storageUri } : {}),
    ...(label ? { accountLabel: label } : {}),
    ...(inputs.legacyModels === "yes" ? { legacyModels: true } : {}),
    ...(text(inputs.extraModels) ? { extraModels: text(inputs.extraModels) } : {}),
    // what Magpie shows the account as
    email: label ? `${label} (${projectId || who})` : `${projectId || "?"} · ${who}`,
  }
  return { type: "success", key, metadata }
}

const commonPrompts = [
  {
    type: "text",
    key: "projectId",
    message: "Google Cloud 项目 ID（可选：留空则使用密钥里的 project_id）",
    placeholder: "my-gcp-project",
  },
  {
    type: "text",
    key: "location",
    message: "Vertex AI Veo 区域（留空默认 us-central1，不支持 us 等多区域）",
    placeholder: "us-central1",
  },
  {
    type: "text",
    key: "storageUri",
    message: "Cloud Storage 输出前缀（可选：留空则内联返回视频字节，无需存储桶）",
    placeholder: "gs://my-bucket/veo-output/",
  },
  {
    type: "text",
    key: "accountLabel",
    message: "账号显示名称（可选）",
    placeholder: "still-function",
  },
  {
    type: "select",
    key: "legacyModels",
    message: "是否同时列出 Veo 3.0 / Veo 2 模型？",
    options: [
      { label: "否 — 仅列出 Veo 3.1 系列模型", value: "no" },
      { label: "是 — 额外列出 veo-3.0-generate-001、veo-3.0-fast-generate-001、veo-2.0-generate-001", value: "yes" },
    ],
  },
]

function methods(tokens, env) {
  const failed = (e) => ({ type: "failed", error: e?.message ?? String(e) })
  return [
    {
      type: "api",
      label: "服务账号密钥文件（容器内路径）",
      placeholder: "/config/credentials/vertex-sa.json",
      prompts: [
        {
          type: "text",
          key: "credentialsPath",
          message: "服务账号 JSON 密钥文件路径（Magpie 视角路径，例如 Docker 容器内路径）",
          placeholder: "/config/credentials/vertex-still-function-sa.json",
          validate: (v) => (text(v) ? undefined : "请填写密钥文件路径"),
        },
        ...commonPrompts,
      ],
      async authorize(inputs = {}) {
        try {
          const credentialsPath = text(inputs.credentialsPath)
          if (!credentialsPath) throw new Error("请填写密钥文件路径")
          const cred = readCredentialFile(credentialsPath)
          if (cred.type !== "service_account") throw new Error(`${credentialsPath} 不是服务账号密钥文件（类型为 ${cred.type}）`)
          const common = checkCommon(inputs)
          if (!common.projectId && !cred.projectId) throw new Error("密钥文件中缺少 project_id，请填写 Google Cloud 项目 ID")
          await verifySignIn(cred, common.projectId || cred.projectId, tokens)
          return signedIn({ key: `file:${credentialsPath}`, mode: "file", cred, common, inputs, credentialsPath })
        } catch (e) {
          return failed(e)
        }
      },
    },
    {
      type: "api",
      label: "粘贴服务账号密钥 JSON",
      placeholder: '{"type":"service_account",…}',
      prompts: [
        {
          type: "text",
          key: "credentialsJson",
          message: "粘贴完整的服务账号 JSON 密钥（包含 client_email、private_key、project_id 等）",
          placeholder: '{"type":"service_account","project_id":"…","private_key":"-----BEGIN PRIVATE KEY-----…","client_email":"…"}',
          validate: (v) => {
            try {
              parseCredentialJSON(String(v ?? ""), "粘贴的 JSON")
              return undefined
            } catch (e) {
              return e.message
            }
          },
        },
        ...commonPrompts,
      ],
      async authorize(inputs = {}) {
        try {
          const raw = text(inputs.credentialsJson)
          const cred = parseCredentialJSON(raw, "粘贴的 JSON")
          if (cred.type !== "service_account") throw new Error("粘贴的 JSON 不是服务账号密钥")
          const common = checkCommon(inputs)
          if (!common.projectId && !cred.projectId) throw new Error("密钥中缺少 project_id，请填写 Google Cloud 项目 ID")
          await verifySignIn(cred, common.projectId || cred.projectId, tokens)
          // stored compact, as the account's key (Magpie keeps keys apart
          // from metadata, never in it)
          return signedIn({ key: JSON.stringify(JSON.parse(raw)), mode: "json", cred, common, inputs })
        } catch (e) {
          return failed(e)
        }
      },
    },
    {
      type: "api",
      label: "应用默认凭据 ADC（GOOGLE_APPLICATION_CREDENTIALS / gcloud / 元数据服务器）",
      prompts: [
        {
          type: "text",
          key: "credentialsPath",
          message: "ADC 凭据文件路径（可选：留空则自动读取 GOOGLE_APPLICATION_CREDENTIALS、gcloud 凭据或 GCE 元数据服务器）",
          placeholder: "~/.config/gcloud/application_default_credentials.json",
        },
        ...commonPrompts,
      ],
      async authorize(inputs = {}) {
        try {
          const credentialsPath = text(inputs.credentialsPath)
          const account = { mode: "adc", credentialsPath, credentialsJson: "", projectId: text(inputs.projectId), location: DEFAULT_LOCATION }
          const cred = resolveCredential(account, env)
          const common = checkCommon(inputs)
          let projectId = common.projectId || cred.projectId
          if (!projectId && cred.type === "metadata") projectId = await metadataProject()
          if (!projectId) throw new Error("凭据中未找到项目 ID，请填写 Google Cloud 项目 ID")
          await verifySignIn(cred, projectId, tokens)
          return signedIn({ key: `adc:${credentialsPath || "default"}`, mode: "adc", cred, common: { ...common, projectId: common.projectId || projectId }, inputs, credentialsPath: credentialsPath || undefined })
        } catch (e) {
          return failed(e)
        }
      },
    },
  ]
}

// ---- the plugin -------------------------------------------------------------------

// createVertexVeoPlugin builds the plugin; options are for tests (a mock
// Vertex / GCS endpoint, a clock).
export function createVertexVeoPlugin(options = {}) {
  const env = options.env ?? process.env
  const tokens = options.tokens ?? createTokenSource({ now: options.now })
  const results = options.results ?? createResultCache({ now: options.now })
  const opts = {
    apiBase: options.apiBase ?? env.VERTEX_VEO_API_BASE ?? "",
    gcsBase: options.gcsBase ?? env.VERTEX_VEO_GCS_BASE ?? "https://storage.googleapis.com",
    defaultModel: "veo-3.1-generate-001",
    results,
  }

  const plugin = async (_ctx = {}) => ({
    config: async (config) => {
      config.provider ??= {}
      const was = config.provider[PROVIDER_ID] ?? {}
      config.provider[PROVIDER_ID] = {
        name: PROVIDER_NAME,
        npm: NPM,
        api: API_BASE,
        ...was,
        models: { ...configModels({ legacy: legacyFromEnv(env), extra: extraModelIds("", env) }), ...(was.models ?? {}) },
      }
    },
    provider: {
      id: PROVIDER_ID,
      async models(provider, { auth } = {}) {
        const account = auth?.type === "api" ? accountOf(auth) : null
        const legacy = legacyFromEnv(env) || !!account?.legacyModels
        const extra = extraModelIds(account?.extraModels ?? "", env)
        return runtimeModels(provider, { legacy, extra })
      },
    },
    auth: {
      provider: PROVIDER_ID,
      methods: methods(tokens, env),
      async loader(getAuth) {
        return {
          baseURL: API_BASE,
          apiKey: PROVIDER_ID,
          async fetch(input, init = {}) {
            const req = input instanceof Request ? input : null
            const method = String(init?.method ?? req?.method ?? "GET").toUpperCase()
            let route
            try {
              route = videoRequest(method, new URL(req ? req.url : String(input)).pathname)
            } catch {
              route = null
            }
            if (!route) {
              return errorResponse(404, `${PROVIDER_NAME} 仅支持视频生成接口（POST /videos、GET /videos/{id}、GET /videos/{id}/content），不支持 ${method} ${req ? req.url : String(input)}`, { code: "unsupported_route" })
            }
            try {
              const s = await session(getAuth, tokens, env)
              if (route.kind === "create") {
                let body
                try {
                  body = JSON.parse((await bodyText(req, init)) || "{}")
                } catch (e) {
                  throw new RequestError(`请求体不是有效的 JSON：${e?.message ?? e}`)
                }
                return await createVideo(s, body, opts)
              }
              if (route.kind === "status") return await videoStatus(s, route.id, opts)
              return await videoContent(s, route.id, opts)
            } catch (e) {
              if (e instanceof AuthError) return errorResponse(e.status, e.message, { signIn: e.signIn, code: e.signIn === "expired" ? "unauthenticated" : "upstream_error" })
              if (e instanceof RequestError) return errorResponse(e.status, e.message, { code: e.code })
              const timeout = e?.name === "TimeoutError" || e?.name === "AbortError"
              return errorResponse(timeout ? 504 : 502, `Vertex AI 请求异常：${e?.message ?? e}`, { code: timeout ? "timeout" : "network_error" })
            }
          },
        }
      },
    },
  })
  return plugin
}

