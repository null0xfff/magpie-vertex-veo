// Google credentials for one Magpie account, and the OAuth2 access tokens
// they are exchanged for. Only node:crypto and the host's global fetch are
// used: the host routes fetch through the user's proxy settings.

import { createSign, createHash } from "node:crypto"
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token"
export const SCOPE = "https://www.googleapis.com/auth/cloud-platform"
export const DEFAULT_LOCATION = "us-central1"
export const METADATA_BASE = "http://metadata.google.internal/computeMetadata/v1"
// a token is renewed this long before Google says it ends
export const REFRESH_EARLY_MS = 60_000

// AuthError is a failure of the account's own credentials. signIn says
// what it means for the Magpie sign-in: "expired" when the credentials
// themselves are bad (unreadable, can't sign, refused by Google's token
// endpoint), "kept" when it is a passing problem (network, 5xx).
export class AuthError extends Error {
  constructor(message, { signIn = "expired", status = 401 } = {}) {
    super(message)
    this.name = "AuthError"
    this.signIn = signIn
    this.status = status
  }
}

const str = (v) => (typeof v === "string" ? v.trim() : "")

// normalizeKey fixes a PEM pasted with literal "\n" in it.
function normalizeKey(pem) {
  let k = String(pem ?? "")
  if (!k.includes("\n") && k.includes("\\n")) k = k.replace(/\\n/g, "\n")
  return k
}

// parseCredentialJSON reads a service-account key file or an ADC
// authorized_user file. where names it in errors (a path, "pasted JSON").
export function parseCredentialJSON(text, where = "credentials") {
  let j
  try {
    j = typeof text === "string" ? JSON.parse(text) : text
  } catch (e) {
    throw new AuthError(`${where} is not valid JSON: ${e?.message ?? e}`)
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new AuthError(`${where} is not a JSON object`)
  const type = str(j.type) || (j.private_key ? "service_account" : j.refresh_token ? "authorized_user" : "")
  if (type === "service_account") {
    const missing = ["client_email", "private_key"].filter((k) => !str(j[k]))
    if (missing.length) throw new AuthError(`${where} is missing ${missing.join(", ")}`)
    const privateKey = normalizeKey(j.private_key)
    if (!privateKey.includes("PRIVATE KEY")) throw new AuthError(`${where}: private_key is not a PEM private key`)
    return {
      type,
      clientEmail: str(j.client_email),
      privateKey,
      privateKeyId: str(j.private_key_id),
      projectId: str(j.project_id),
      tokenUri: str(j.token_uri) || DEFAULT_TOKEN_URI,
    }
  }
  if (type === "authorized_user") {
    const missing = ["client_id", "client_secret", "refresh_token"].filter((k) => !str(j[k]))
    if (missing.length) throw new AuthError(`${where} is missing ${missing.join(", ")}`)
    return {
      type,
      clientId: str(j.client_id),
      clientSecret: str(j.client_secret),
      refreshToken: str(j.refresh_token),
      projectId: str(j.quota_project_id) || str(j.project_id),
      tokenUri: str(j.token_uri) || DEFAULT_TOKEN_URI,
    }
  }
  throw new AuthError(`${where}: unsupported credential type "${type || "unknown"}" (want service_account or authorized_user)`)
}

// readCredentialFile reads and parses the key file at path.
export function readCredentialFile(path) {
  const p = str(path)
  if (!p) throw new AuthError("no credentials file path given")
  let text
  try {
    text = readFileSync(p, "utf8")
  } catch (e) {
    throw new AuthError(`can't read credentials file ${p}: ${e?.code ?? e?.message ?? e}`)
  }
  return parseCredentialJSON(text, p)
}

// adcPath is where Application Default Credentials live, "" for none: the
// GOOGLE_APPLICATION_CREDENTIALS file, else gcloud's well-known file.
export function adcPath(env = process.env) {
  const fromEnv = str(env.GOOGLE_APPLICATION_CREDENTIALS)
  if (fromEnv) return fromEnv
  const base =
    str(env.CLOUDSDK_CONFIG) ||
    (process.platform === "win32" && str(env.APPDATA) ? join(env.APPDATA, "gcloud") : join(homedir(), ".config", "gcloud"))
  const p = join(base, "application_default_credentials.json")
  return existsSync(p) ? p : ""
}

// ---- the account ------------------------------------------------------------

// accountOf is a Magpie auth record as this plugin's settings. The record
// is { type: "api", key, metadata }: key is the pasted JSON itself, or
// "file:<path>", or "adc:<path or default>"; metadata keeps the rest.
export function accountOf(auth) {
  const md = auth?.metadata && typeof auth.metadata === "object" ? auth.metadata : {}
  const key = typeof auth?.key === "string" ? auth.key : ""
  let mode = str(md.mode)
  if (!mode) mode = key.trimStart().startsWith("{") ? "json" : key.startsWith("adc:") ? "adc" : "file"
  let credentialsPath = str(md.credentialsPath)
  if (!credentialsPath && key.startsWith("file:")) credentialsPath = key.slice(5)
  if (!credentialsPath && key.startsWith("adc:") && key !== "adc:default") credentialsPath = key.slice(4)
  return {
    mode,
    credentialsPath,
    credentialsJson: mode === "json" ? key : "",
    projectId: str(md.projectId),
    location: str(md.location) || DEFAULT_LOCATION,
    storageUri: str(md.storageUri),
    label: str(md.accountLabel),
    legacyModels: md.legacyModels === true || md.legacyModels === "yes",
    extraModels: str(md.extraModels),
  }
}

// resolveCredential is the account's credential as read now: a key file is
// read again on each call, so a rotated file is picked up without signing
// in again. With ADC and no file, it is the metadata server's.
export function resolveCredential(account, env = process.env) {
  if (account.mode === "json") {
    if (!str(account.credentialsJson)) throw new AuthError("no service account JSON stored for this account")
    return parseCredentialJSON(account.credentialsJson, "pasted service account JSON")
  }
  if (account.mode === "adc") {
    const p = account.credentialsPath || adcPath(env)
    return p ? readCredentialFile(p) : { type: "metadata", projectId: "" }
  }
  return readCredentialFile(account.credentialsPath)
}

// cacheKeyOf is what one token is cached under: the identity it is for and
// the project it is asked in, never the secret itself.
export function cacheKeyOf(cred, projectId = "") {
  if (cred.type === "service_account") return `sa:${cred.clientEmail}:${projectId}:${cred.privateKeyId || hash(cred.privateKey)}`
  if (cred.type === "authorized_user") return `user:${cred.clientId}:${hash(cred.refreshToken)}:${projectId}`
  return `metadata:${projectId}`
}

const hash = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 16)

// ---- tokens -----------------------------------------------------------------

const b64u = (v) => Buffer.from(v).toString("base64url")

// signJwt is the RS256 assertion a service account trades for a token.
export function signJwt(cred, nowSec = Math.floor(Date.now() / 1000)) {
  const header = { alg: "RS256", typ: "JWT", ...(cred.privateKeyId ? { kid: cred.privateKeyId } : {}) }
  const claims = {
    iss: cred.clientEmail,
    sub: cred.clientEmail,
    aud: cred.tokenUri || DEFAULT_TOKEN_URI,
    scope: SCOPE,
    iat: nowSec,
    exp: nowSec + 3600,
  }
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`
  let sig
  try {
    const s = createSign("RSA-SHA256")
    s.update(input)
    s.end()
    sig = s.sign(cred.privateKey)
  } catch (e) {
    throw new AuthError(`the service account's private key can't sign: ${e?.message ?? e}`)
  }
  return `${input}.${sig.toString("base64url")}`
}

// tokenRefused is whether a token endpoint's answer refuses the credential
// itself (sign in again), rather than failing for now.
function tokenRefused(status, body) {
  if (status === 401) return true
  const err = String(body?.error ?? "")
  return status === 400 && ["invalid_grant", "invalid_client", "unauthorized_client", "invalid_request"].includes(err)
}

async function postToken(uri, form, doFetch) {
  let res
  try {
    res = await doFetch(uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (e) {
    throw new AuthError(`can't reach Google's token endpoint: ${e?.message ?? e}`, { signIn: "kept", status: 502 })
  }
  const text = await res.text()
  let body = {}
  try {
    body = JSON.parse(text)
  } catch {}
  if (!res.ok || !body.access_token) {
    const why = [body.error, body.error_description].filter(Boolean).join(": ") || `HTTP ${res.status}`
    if (tokenRefused(res.status, body)) throw new AuthError(`Google refused the credentials: ${why}`)
    throw new AuthError(`Google's token endpoint failed: ${why}`, { signIn: "kept", status: 502 })
  }
  return body
}

async function metadataToken(doFetch) {
  let res
  try {
    res = await doFetch(`${METADATA_BASE}/instance/service-accounts/default/token`, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(5_000),
    })
  } catch (e) {
    throw new AuthError(
      `no Application Default Credentials: set GOOGLE_APPLICATION_CREDENTIALS or give a key file (metadata server: ${e?.message ?? e})`,
    )
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.access_token) throw new AuthError(`the metadata server gave no token: HTTP ${res.status}`)
  return body
}

// metadataProject is the project the metadata server's machine is in.
export async function metadataProject(doFetch = (...a) => fetch(...a)) {
  try {
    const res = await doFetch(`${METADATA_BASE}/project/project-id`, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(5_000),
    })
    return res.ok ? (await res.text()).trim() : ""
  } catch {
    return ""
  }
}

// createTokenSource caches one token per credential, renews it
// REFRESH_EARLY_MS before it ends, and lets concurrent callers share a
// single in-flight request. fetch defaults to the host's global fetch,
// looked up at call time.
export function createTokenSource({ fetch: doFetch, now = Date.now } = {}) {
  const f = doFetch ?? ((...a) => globalThis.fetch(...a))
  const cache = new Map() // key -> { token, expiresAt }
  const inflight = new Map() // key -> Promise<string>

  async function mint(cred) {
    let body
    if (cred.type === "service_account") {
      const assertion = signJwt(cred, Math.floor(now() / 1000))
      body = await postToken(cred.tokenUri, { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }, f)
    } else if (cred.type === "authorized_user") {
      body = await postToken(
        cred.tokenUri,
        { grant_type: "refresh_token", client_id: cred.clientId, client_secret: cred.clientSecret, refresh_token: cred.refreshToken },
        f,
      )
    } else {
      body = await metadataToken(f)
    }
    const ttl = Number(body.expires_in) > 0 ? Number(body.expires_in) * 1000 : 3600_000
    return { token: String(body.access_token), expiresAt: now() + ttl }
  }

  return {
    async token(cred, projectId = "") {
      const key = cacheKeyOf(cred, projectId)
      const hit = cache.get(key)
      if (hit && hit.expiresAt - REFRESH_EARLY_MS > now()) return hit.token
      let p = inflight.get(key)
      if (!p) {
        p = mint(cred)
          .then((t) => {
            cache.set(key, t)
            return t.token
          })
          .finally(() => inflight.delete(key))
        inflight.set(key, p)
      }
      return p
    },
    invalidate(cred, projectId = "") {
      cache.delete(cacheKeyOf(cred, projectId))
    },
    clear() {
      cache.clear()
    },
    get size() {
      return cache.size
    },
  }
}
