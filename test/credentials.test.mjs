import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import {
  AuthError,
  REFRESH_EARLY_MS,
  SCOPE,
  accountOf,
  cacheKeyOf,
  createTokenSource,
  parseCredentialJSON,
  readCredentialFile,
  resolveCredential,
  signJwt,
} from "../lib/credentials.mjs"
import { PRIVATE_PEM, serviceAccount, startMock, verifyJwt, writeKeyFile, removeKeyFiles } from "./helpers.mjs"

afterAll(removeKeyFiles)

let mock
beforeAll(() => {
  mock = startMock()
})
afterAll(() => mock.stop())

describe("service account JSON", () => {
  test("parses a key and defaults token_uri", () => {
    const { token_uri, ...rest } = serviceAccount("x")
    const c = parseCredentialJSON(JSON.stringify(rest))
    expect(c.type).toBe("service_account")
    expect(c.clientEmail).toBe("veo@demo-project.iam.gserviceaccount.com")
    expect(c.projectId).toBe("demo-project")
    expect(c.tokenUri).toBe("https://oauth2.googleapis.com/token")
  })

  test("accepts a private key pasted with literal \\n", () => {
    const sa = serviceAccount("x", { private_key: PRIVATE_PEM.replace(/\n/g, "\\n") })
    const c = parseCredentialJSON(JSON.stringify(sa))
    expect(c.privateKey).toBe(PRIVATE_PEM)
  })

  test("rejects bad JSON and missing fields as expired sign-ins", () => {
    expect(() => parseCredentialJSON("{nope")).toThrow(AuthError)
    try {
      parseCredentialJSON(JSON.stringify({ type: "service_account", client_email: "a@b" }))
      throw new Error("no throw")
    } catch (e) {
      expect(e).toBeInstanceOf(AuthError)
      expect(e.signIn).toBe("expired")
      expect(e.message).toContain("private_key")
    }
    expect(() => parseCredentialJSON(JSON.stringify({ type: "external_account" }))).toThrow(/不支持的凭据类型/)
  })

  test("reads a key file, and says when it can't", () => {
    const p = writeKeyFile(serviceAccount("x"))
    expect(readCredentialFile(p).clientEmail).toContain("@")
    expect(() => readCredentialFile("/definitely/not/here.json")).toThrow(/无法读取凭据文件/)
  })

  test("parses an authorized_user ADC file", () => {
    const c = parseCredentialJSON(JSON.stringify({ type: "authorized_user", client_id: "id", client_secret: "s", refresh_token: "r", quota_project_id: "qp" }))
    expect(c.type).toBe("authorized_user")
    expect(c.projectId).toBe("qp")
  })
})

describe("accounts", () => {
  test("reads a key-file account, a pasted one and an ADC one", () => {
    const f = accountOf({ type: "api", key: "file:/config/credentials/a.json", metadata: { mode: "file", credentialsPath: "/config/credentials/a.json", projectId: "p1", storageUri: "gs://b/x/" } })
    expect(f).toMatchObject({ mode: "file", credentialsPath: "/config/credentials/a.json", projectId: "p1", location: "us-central1", storageUri: "gs://b/x/" })
    const j = accountOf({ type: "api", key: '{"type":"service_account"}', metadata: { location: "europe-west4" } })
    expect(j).toMatchObject({ mode: "json", credentialsJson: '{"type":"service_account"}', location: "europe-west4" })
    const a = accountOf({ type: "api", key: "adc:default" })
    expect(a).toMatchObject({ mode: "adc", credentialsPath: "" })
  })

  test("re-reads a key file each time (rotation)", () => {
    const p = writeKeyFile(serviceAccount("x", { client_email: "one@p.iam.gserviceaccount.com" }))
    const account = accountOf({ type: "api", key: `file:${p}`, metadata: { mode: "file", credentialsPath: p } })
    expect(resolveCredential(account).clientEmail).toBe("one@p.iam.gserviceaccount.com")
    require("node:fs").writeFileSync(p, JSON.stringify(serviceAccount("x", { client_email: "two@p.iam.gserviceaccount.com" })))
    expect(resolveCredential(account).clientEmail).toBe("two@p.iam.gserviceaccount.com")
  })

  test("ADC uses GOOGLE_APPLICATION_CREDENTIALS", () => {
    const p = writeKeyFile(serviceAccount("x"))
    const c = resolveCredential(accountOf({ type: "api", key: "adc:default", metadata: { mode: "adc" } }), { GOOGLE_APPLICATION_CREDENTIALS: p })
    expect(c.type).toBe("service_account")
  })

  test("cache keys never hold the secret", () => {
    const c = parseCredentialJSON(JSON.stringify(serviceAccount("x")))
    const k = cacheKeyOf(c, "proj")
    expect(k).toContain("veo@demo-project")
    expect(k).toContain("proj")
    expect(k).not.toContain("PRIVATE")
  })
})

describe("JWT", () => {
  test("is RS256 with the service account's claims", () => {
    const c = parseCredentialJSON(JSON.stringify(serviceAccount("https://oauth2.googleapis.com/token")))
    const jwt = signJwt(c, 1_700_000_000)
    const { ok, header, claims } = verifyJwt(jwt)
    expect(ok).toBe(true)
    expect(header).toEqual({ alg: "RS256", typ: "JWT", kid: "kid-1" })
    expect(claims).toEqual({
      iss: "veo@demo-project.iam.gserviceaccount.com",
      sub: "veo@demo-project.iam.gserviceaccount.com",
      aud: "https://oauth2.googleapis.com/token",
      scope: SCOPE,
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    })
    expect(jwt).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  })

  test("a key that can't sign is an expired sign-in", () => {
    const c = parseCredentialJSON(JSON.stringify(serviceAccount("x", { private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n" })))
    expect(() => signJwt(c)).toThrow(AuthError)
  })
})

describe("token source", () => {
  const cred = () => parseCredentialJSON(JSON.stringify(serviceAccount(mock.tokenUri)))

  test("exchanges a JWT for a token and caches it", async () => {
    mock.state.tokenCalls = 0
    const ts = createTokenSource()
    expect(await ts.token(cred(), "p")).toBe("tok-1")
    expect(await ts.token(cred(), "p")).toBe("tok-1")
    expect(mock.state.tokenCalls).toBe(1)
    const { claims } = verifyJwt(mock.state.jwts.at(-1))
    expect(claims.aud).toBe(mock.tokenUri)
  })

  test("renews 60 s before expiry", async () => {
    mock.state.tokenCalls = 0
    let t = 1_000_000
    const ts = createTokenSource({ now: () => t })
    expect(await ts.token(cred(), "p")).toBe("tok-1")
    t += 3600_000 - REFRESH_EARLY_MS - 1000
    expect(await ts.token(cred(), "p")).toBe("tok-1")
    t += 2000
    expect(await ts.token(cred(), "p")).toBe("tok-2")
    expect(mock.state.tokenCalls).toBe(2)
  })

  test("shares one in-flight request between concurrent callers", async () => {
    mock.state.tokenCalls = 0
    mock.state.tokenDelayMs = 50
    const ts = createTokenSource()
    const got = await Promise.all(Array.from({ length: 8 }, () => ts.token(cred(), "p")))
    mock.state.tokenDelayMs = 0
    expect(new Set(got)).toEqual(new Set(["tok-1"]))
    expect(mock.state.tokenCalls).toBe(1)
  })

  test("keeps tokens per account (project and identity)", async () => {
    mock.state.tokenCalls = 0
    const ts = createTokenSource()
    const a = await ts.token(cred(), "p1")
    const b = await ts.token(cred(), "p2")
    const other = parseCredentialJSON(JSON.stringify(serviceAccount(mock.tokenUri, { client_email: "x@y.iam.gserviceaccount.com" })))
    const c = await ts.token(other, "p1")
    expect(new Set([a, b, c]).size).toBe(3)
    expect(ts.size).toBe(3)
  })

  test("invalidate forces a new token", async () => {
    mock.state.tokenCalls = 0
    const ts = createTokenSource()
    await ts.token(cred(), "p")
    ts.invalidate(cred(), "p")
    expect(await ts.token(cred(), "p")).toBe("tok-2")
  })

  test("invalid_grant is an expired sign-in; a 503 is kept", async () => {
    const ts = createTokenSource()
    mock.state.tokenStatus = 400
    mock.state.tokenBody = { error: "invalid_grant", error_description: "Invalid JWT Signature." }
    await expect(ts.token(cred(), "p")).rejects.toMatchObject({ signIn: "expired" })
    mock.state.tokenStatus = 401
    mock.state.tokenBody = { error: "unauthorized_client" }
    await expect(ts.token(cred(), "p")).rejects.toMatchObject({ signIn: "expired" })
    mock.state.tokenStatus = 503
    mock.state.tokenBody = { error: "backend_error" }
    await expect(ts.token(cred(), "p")).rejects.toMatchObject({ signIn: "kept", status: 502 })
    mock.state.tokenStatus = 200
    mock.state.tokenBody = null
    // a failure is not cached: the next call tries again
    expect(await ts.token(cred(), "p")).toMatch(/^tok-/)
  })

  test("an unreachable token endpoint is kept, not expired", async () => {
    const ts = createTokenSource()
    const c = parseCredentialJSON(JSON.stringify(serviceAccount("http://127.0.0.1:1/token")))
    await expect(ts.token(c, "p")).rejects.toMatchObject({ signIn: "kept" })
  })
})
