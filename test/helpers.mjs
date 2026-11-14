// A mock of Google's token endpoint, Vertex AI's Veo operations and the
// GCS JSON API, on a local Bun server, and the pieces tests build on.

import { generateKeyPairSync, createVerify } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createVertexVeoPlugin } from "../lib/plugin.mjs"

export const { privateKey: PRIVATE_PEM, publicKey: PUBLIC_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
})

export function serviceAccount(tokenUri, over = {}) {
  return {
    type: "service_account",
    project_id: "demo-project",
    private_key_id: "kid-1",
    private_key: PRIVATE_PEM,
    client_email: "veo@demo-project.iam.gserviceaccount.com",
    client_id: "1234",
    token_uri: tokenUri,
    ...over,
  }
}

// every key file the tests write goes in one temp dir; each test file
// removes it when done (afterAll(removeKeyFiles))
let keyDir = ""
let keyN = 0
export function writeKeyFile(obj) {
  if (!keyDir) keyDir = mkdtempSync(join(tmpdir(), "vertex-veo-test-"))
  const p = join(keyDir, `sa-${++keyN}.json`)
  writeFileSync(p, JSON.stringify(obj))
  return p
}

export function removeKeyFiles() {
  if (keyDir) rmSync(keyDir, { recursive: true, force: true })
  keyDir = ""
}

export function verifyJwt(jwt) {
  const [h, c, s] = jwt.split(".")
  const v = createVerify("RSA-SHA256")
  v.update(`${h}.${c}`)
  v.end()
  return {
    ok: v.verify(PUBLIC_PEM, Buffer.from(s, "base64url")),
    header: JSON.parse(Buffer.from(h, "base64url").toString()),
    claims: JSON.parse(Buffer.from(c, "base64url").toString()),
  }
}

// a few bytes that start like an MP4
export const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(64, 7)])

// startMock serves the three Google APIs. ops maps an operation id to what
// :fetchPredictOperation answers for it (an object, or a function of the
// call count). tokenStatus / vertexStatus force failures.
export function startMock() {
  const state = {
    tokenCalls: 0,
    jwts: [],
    predicts: [],
    fetches: [],
    gcsCalls: [],
    ops: new Map(),
    nextOp: 1,
    tokenStatus: 200,
    tokenBody: null,
    tokenDelayMs: 0,
    predictStatus: 200,
    predictBody: null,
    rejectToken: new Set(),
    gcs: new Map(),
  }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      const auth = req.headers.get("authorization") ?? ""
      if (url.pathname === "/token" && req.method === "POST") {
        state.tokenCalls++
        const form = new URLSearchParams(await req.text())
        state.jwts.push(form.get("assertion"))
        if (state.tokenDelayMs) await Bun.sleep(state.tokenDelayMs)
        if (state.tokenStatus !== 200) return Response.json(state.tokenBody ?? { error: "invalid_grant", error_description: "Invalid JWT Signature." }, { status: state.tokenStatus })
        if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") return Response.json({ error: "unsupported_grant_type" }, { status: 400 })
        if (!verifyJwt(form.get("assertion")).ok) return Response.json({ error: "invalid_grant" }, { status: 400 })
        return Response.json({ access_token: `tok-${state.tokenCalls}`, expires_in: 3600, token_type: "Bearer" })
      }
      const token = auth.replace(/^Bearer /, "")
      if (!auth.startsWith("Bearer tok-") || state.rejectToken.has(token)) {
        return Response.json({ error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } }, { status: 401 })
      }
      const predict = /^\/v1\/projects\/([^/]+)\/locations\/([^/]+)\/publishers\/google\/models\/([^/:]+):predictLongRunning$/.exec(url.pathname)
      if (predict && req.method === "POST") {
        const body = await req.json()
        state.predicts.push({ path: url.pathname, body, token, contentType: req.headers.get("content-type") })
        if (state.predictStatus !== 200) {
          return Response.json(state.predictBody ?? { error: { code: state.predictStatus, message: "Permission denied on Veo", status: "PERMISSION_DENIED" } }, { status: state.predictStatus })
        }
        const opId = `op-${state.nextOp++}`
        return Response.json({ name: `projects/${predict[1]}/locations/${predict[2]}/publishers/google/models/${predict[3]}/operations/${opId}` })
      }
      const fetchOp = /^\/v1\/projects\/([^/]+)\/locations\/([^/]+)\/publishers\/google\/models\/([^/:]+):fetchPredictOperation$/.exec(url.pathname)
      if (fetchOp && req.method === "POST") {
        const body = await req.json()
        state.fetches.push({ path: url.pathname, body })
        const opId = String(body.operationName).split("/").pop()
        const v = state.ops.get(opId)
        if (v === undefined) return Response.json({ error: { code: 404, message: "Operation not found", status: "NOT_FOUND" } }, { status: 404 })
        const n = state.fetches.filter((f) => f.body.operationName === body.operationName).length
        return Response.json({ name: body.operationName, ...(typeof v === "function" ? v(n) : v) })
      }
      const gcs = /^\/storage\/v1\/b\/([^/]+)\/o\/([^/]+)$/.exec(url.pathname)
      if (gcs && req.method === "GET") {
        const bucket = decodeURIComponent(gcs[1])
        const object = decodeURIComponent(gcs[2])
        state.gcsCalls.push({ bucket, object, alt: url.searchParams.get("alt"), token })
        const bytes = state.gcs.get(`${bucket}/${object}`)
        if (!bytes) return Response.json({ error: { code: 404, message: "No such object" } }, { status: 404 })
        return new Response(bytes, { headers: { "Content-Type": "video/mp4", "Content-Length": String(bytes.length) } })
      }
      return new Response("not found", { status: 404 })
    },
  })
  const base = `http://127.0.0.1:${server.port}`
  return { server, state, base, tokenUri: `${base}/token`, stop: () => server.stop(true) }
}

// harness is the plugin wired to a mock, signed in with a key file.
export async function harness({ metadata = {}, keyOver = {}, now } = {}) {
  const mock = startMock()
  const keyPath = writeKeyFile(serviceAccount(mock.tokenUri, keyOver))
  const plugin = createVertexVeoPlugin({ apiBase: `${mock.base}/v1`, gcsBase: mock.base, env: {}, now })
  const hooks = await plugin({ client: {} })
  let auth = { type: "api", key: `file:${keyPath}`, metadata: { mode: "file", credentialsPath: keyPath, location: "us-central1", ...metadata } }
  const loaded = await hooks.auth.loader(async () => auth)
  const call = (path, init) => loaded.fetch(`https://us-central1-aiplatform.googleapis.com/v1${path}`, init)
  const create = (body) => call("/videos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  return {
    mock,
    hooks,
    keyPath,
    loaded,
    call,
    create,
    setAuth: (a) => {
      auth = a
    },
    stop: () => mock.stop(),
  }
}

export const PNG = "data:image/png;base64,iVBORw0KGgo="
export const JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
