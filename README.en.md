<div align="center">

<img src="https://raw.githubusercontent.com/null0xfff/magpie-vertex-veo/main/docs/logo.svg" width="88" height="88" alt="Vertex AI Veo" />

# magpie-vertex-veo

**Google Vertex AI Veo video generation · a Magpie / OpenCode provider plugin**

[![Magpie Plugin](https://img.shields.io/badge/Magpie-Plugin-3b82f6?style=flat-square)](https://usemagpie.ai/)
[![magpie >= 0.1.4029](https://img.shields.io/badge/magpie-%3E%3D0.1.4029-6366f1?style=flat-square)](https://github.com/yetone/magpie)
[![Vertex AI Veo](https://img.shields.io/badge/Vertex%20AI-Veo%203.1-4285F4?style=flat-square&logo=googlecloud&logoColor=white)](https://cloud.google.com/vertex-ai/generative-ai/docs/video/overview)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?style=flat-square&logo=bun&logoColor=black)](https://bun.sh/)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-10b981?style=flat-square)](https://github.com/null0xfff/magpie-vertex-veo/blob/main/package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-10b981?style=flat-square)](https://github.com/null0xfff/magpie-vertex-veo/blob/main/LICENSE)

[中文](https://github.com/null0xfff/magpie-vertex-veo/blob/main/README.md) | English

</div>

Brings **Google Vertex AI Veo** (`veo-3.1` / `fast` / `lite`) into [Magpie](https://usemagpie.ai/). Install it, sign in with a service account, and Magpie's `/v1/videos` gateway and `magpie-image` MCP (`generate_video` / `generation_result`) make videos with Veo: text-to-video, first-frame image-to-video, first + last frame, and reference images.

Built for **headless Docker / server** deployments: no browser sign-in, no `gcloud`, no GCS bucket required — a service account JSON is enough.

> Unofficial; not affiliated with Google. Veo is billed at Google Cloud's prices to your own GCP project.

---

## ✨ Features

| | |
| --- | --- |
| 🎬 **Models** | Veo 3.1 / 3.1 Fast / 3.1 Lite; optionally Veo 3.0 / 3.0 Fast / 2.0, plus any new preview id you add |
| 🖼 **Inputs** | Text prompt, first frame (`input_reference`), last frame (`last_frame`), up to 3 reference images (`reference_images`), as `data:` URLs or `gs://` |
| 🔐 **Headless sign-in** | Service account key file path / pasted key JSON / ADC (`GOOGLE_APPLICATION_CREDENTIALS`, gcloud, GCE metadata server) |
| 📦 **No bucket needed** | By default Vertex returns the video bytes inline; or give a `gs://` prefix and the plugin streams the file back with the same token |
| 👥 **Multi-account / multi-project** | Each account has its own credentials, project, region and token cache |
| 🔄 **Key rotation friendly** | The key file is re-read on every request; tokens renew 60 s early and concurrent requests share one refresh |
| 🧭 **Accurate sign-in state** | Only broken credentials ask you to sign in again; no Veo access, an unsupported region or quota errors keep the sign-in and show Google's message |
| 🪶 **Zero dependencies** | Bun built-ins, `node:crypto` and Magpie's global `fetch` only, so Magpie's proxy settings apply |

## 🤔 Which one?

| | This plugin `vertex-veo` | Magpie's built-in `google-vertex` | [`magpie-vertex-ai`](https://github.com/HzTTT/magpie-vertex-ai) |
| :--- | :--- | :--- | :--- |
| **Scope** | Veo video only, in depth | Chat / images | All of Vertex (Gemini, Claude, MaaS, Imagen, Veo…) |
| **Video** | ✅ | ❌ | ✅ |
| **Pick it when** | You want Veo as Magpie's video model, especially in Docker | You only chat with Gemini | You want one provider for every Vertex model |

The provider ids don't clash, so they can be installed side by side.

## 🚀 Quick start

**1. Install** (any one)

- **Plugin market**: Magpie → Plugins → Discover, search **Vertex AI Veo** (repositories tagged `magpie-plugin` show up there, marked as not reviewed).
- **CLI**:

  ```bash
  magpie plugin add github:null0xfff/magpie-vertex-veo
  ```

- **Docker** (use your container's name):

  ```bash
  docker exec -it magpie-magpie-1 /magpie plugin add github:null0xfff/magpie-vertex-veo
  ```

**2. Sign in**

```bash
magpie plugin login vertex-veo 1
# key file path → project id (optional) → region (optional) → GCS prefix (optional) → display name → list older models?
```

Or add a **Vertex AI Veo** account in Magpie's web UI.

**3. Make it the default video model**

In Magpie's settings, on the models page, set the video generation model to `vertex-veo/veo-3.1-generate-001`. Left unset, Magpie picks whichever video model it finds first, which may not be Veo.

**4. Generate**

Ask any agent connected to Magpie's MCP for a video (it calls `generate_video`), or call the gateway — see [Usage](#-usage).

## ☁️ Google Cloud setup

1. Enable the **Vertex AI API** (`aiplatform.googleapis.com`) and make sure the project has Veo access and quota.
2. Create a service account with **`roles/aiplatform.user`** and download a JSON key.
3. For GCS output (optional), the service account also needs to read and write objects in the bucket, e.g. `roles/storage.objectUser` on the bucket.
4. In Docker, put the key in a mounted folder such as `/config/credentials/vertex-sa.json`, readable by the user Magpie runs as (UID `65532` in the official image).

## 🔐 Sign-in methods

| Method | For | What is stored |
| :--- | :--- | :--- |
| **1. Service account key file (path in the container)** | Docker / servers, **recommended** | Just the path `file:<path>`; the file is re-read on each request |
| **2. Paste service account key JSON** | Web UI only, no file access | The whole JSON, as the account's key in Magpie's credential store |
| **3. Application Default Credentials** | `gcloud auth application-default login`, or GCE / GKE / Cloud Run | Just `adc:<path>` or `adc:default` |

Optional fields for every method:

| Field | Default | Meaning |
| :--- | :--- | :--- |
| `projectId` | the key's `project_id` | Call Veo in another project |
| `location` | `us-central1` | A concrete region; multi-regions such as `us` / `eu` aren't supported |
| `storageUri` | empty | Empty = video bytes inline; `gs://bucket/prefix/` = written to GCS, streamed back by the plugin |
| `accountLabel` | empty | How the account is named in Magpie |
| List Veo 3.0 / Veo 2 | no | "yes" adds the older models |

Sign-in fetches a real OAuth token once, so a wrong key or project id fails right away. For more GCP projects, run `magpie plugin login vertex-veo` again with another key.

## 🎬 Models

| Model id | Name | Seconds | Resolution | Audio |
| :--- | :--- | :--- | :--- | :--- |
| `veo-3.1-generate-001` | Veo 3.1 (recommended) | 4 / 6 / 8 | 720p / 1080p / 4k* | ✅ on by default |
| `veo-3.1-fast-generate-001` | Veo 3.1 Fast | 4 / 6 / 8 | 720p / 1080p / 4k* | ✅ on by default |
| `veo-3.1-lite-generate-001` | Veo 3.1 Lite | 4 / 6 / 8 | 720p / 1080p / 4k* | ✅ on by default |
| `veo-3.0-generate-001` | Veo 3 (optional) | 4 / 6 / 8 | 720p / 1080p* | ✅ on by default |
| `veo-3.0-fast-generate-001` | Veo 3 Fast (optional) | 4 / 6 / 8 | 720p / 1080p* | ✅ on by default |
| `veo-2.0-generate-001` | Veo 2 (optional) | 5 – 8 | model's own | ❌ |

\* The plugin passes the requested resolution to Vertex as asked; which ones a model accepts is up to Google's current docs. Aspect ratios are `16:9` and `9:16` only.

Older models: answer "yes" at sign-in, or set `VERTEX_VEO_LEGACY_MODELS=1` for Magpie. New ids (previews) can be added with `VERTEX_VEO_EXTRA_MODELS="id1,id2"` without waiting for a release.

## 🛠 Usage

### MCP

With Veo as the default video model, an agent's `generate_video` call goes to Veo. A video takes from tens of seconds to a few minutes; until it's done the agent gets an id to wait on with `generation_result`.

### OpenAI Videos API (gateway)

```bash
# 1. start
curl -s http://127.0.0.1:3425/v1/videos \
  -H "Authorization: Bearer $MAGPIE_KEY" -H "Content-Type: application/json" \
  -d '{"model":"vertex-veo/veo-3.1-generate-001","prompt":"A fluffy orange cat on a sunlit windowsill","seconds":"8","size":"1280x720"}'
# → {"id":"video_vertex-veo....","status":"queued",...}

# 2. poll: queued → in_progress → completed / failed
curl -s http://127.0.0.1:3425/v1/videos/<id> -H "Authorization: Bearer $MAGPIE_KEY"

# 3. download
curl -s http://127.0.0.1:3425/v1/videos/<id>/content -H "Authorization: Bearer $MAGPIE_KEY" -o out.mp4
```

Image-to-video puts the image in `input_reference` as a data URL; add `last_frame` for first + last frame:

```json
{
  "model": "vertex-veo/veo-3.1-fast-generate-001",
  "prompt": "The camera slowly pushes in as the cat wakes up",
  "seconds": "6",
  "size": "9:16",
  "input_reference": "data:image/png;base64,iVBORw0KGgo...",
  "last_frame": "data:image/png;base64,iVBORw0KGgo...",
  "negative_prompt": "blurry, low quality",
  "generate_audio": true
}
```

OpenAI's SDKs uploading `input_reference` as `multipart/form-data` work too: Magpie's gateway turns the file into a data URL before it reaches the plugin.

### Parameter mapping

| OpenAI / Magpie field | Vertex Veo |
| :--- | :--- |
| `prompt` | `instances[0].prompt` (may be left out when a first frame is given) |
| `input_reference` (`data:` URL or `gs://`) | `instances[0].image` |
| `last_frame` | `instances[0].lastFrame` |
| `reference_images[]` (up to 3) | `instances[0].referenceImages[] = {image, referenceType:"asset"}` |
| `seconds` | `durationSeconds`: the nearest length the model makes (the longer on a tie); 8 when not given |
| `size` = `16:9` / `9:16` | `aspectRatio` |
| `size` = `WIDTHxHEIGHT` | `aspectRatio` from the shape, `resolution` from the short side (≥2160 → `4k`, ≥1080 → `1080p`, else `720p`) |
| `size` = `720p` / `1080p` / `4k` | `resolution` (Veo 3 family only) |
| `aspect_ratio`, `resolution` | Explicit, win over `size` |
| `n` / `sampleCount` | `sampleCount` (1–4; the first video is returned) |
| `negative_prompt`, `person_generation`, `generate_audio`, `seed`, `enhance_prompt`, `compression_quality`, `resize_mode`, `storage_uri` | Their camelCase parameters; snake_case and camelCase both accepted |

The Veo 3 family generates audio unless `generate_audio: false` is sent.

## ❓ FAQ

<details>
<summary><b>Sign-in says it can't read the key file (EACCES / ENOENT)</b></summary>

Give the path **as Magpie sees it**: inside the container in Docker (e.g. `/config/credentials/xxx.json`), not the host path. The file must be readable by the container's user (UID `65532` in the official image), e.g. `chown 65532 xxx.json` or `chmod 644 xxx.json` on the host.

</details>

<details>
<summary><b>403 PERMISSION_DENIED</b></summary>

The service account lacks `roles/aiplatform.user`, the Vertex AI API isn't enabled, or the project has no Veo access yet. The account stays signed in; retry once fixed.

</details>

<details>
<summary><b>404 NOT_FOUND (model not found)</b></summary>

The region doesn't serve that model. Veo is mainly offered in `us-central1`; set the account's region to it.

</details>

<details>
<summary><b>429 / RESOURCE_EXHAUSTED</b></summary>

The project's Veo quota or rate limit was hit. Retry later or request more quota in the Cloud console. The sign-in is unaffected.

</details>

<details>
<summary><b>The video failed with content_filtered</b></summary>

Google's safety filters rejected it; the error carries Google's reason. Change the prompt or images, or try `person_generation` for videos with people.

</details>

<details>
<summary><b>The account asks to sign in again</b></summary>

Only when the credentials themselves stopped working: the key file can't be read or parsed, the private key can't sign, Google answers `invalid_grant` (key deleted or disabled), or Vertex still says 401 with a fresh token. Fix the key and run `magpie plugin login vertex-veo` again.

</details>

<details>
<summary><b>I want the videos kept in GCS</b></summary>

Set `storageUri` at sign-in (e.g. `gs://my-bucket/veo-output/`) or send `storage_uri` with a request. The video stays in your bucket and `/content` is streamed from it with the same service account.

</details>

## 🔒 Privacy & security

- The plugin only talks to Google: `oauth2.googleapis.com` (tokens), `{region}-aiplatform.googleapis.com` (Veo), `storage.googleapis.com` (GCS output only) and, with ADC, the GCE metadata server. No telemetry.
- Magpie keeps the account in its config folder (`plugin-auth.json`). A key-file sign-in stores only the path; pasted JSON is stored as the account's key, never in its metadata. The plugin writes no logs, and its errors never include the private key.
- Access tokens are cached in memory only, per account.
- Finished results are cached in memory briefly (at most 2, for 120 s) and dropped as soon as the bytes are handed to Magpie.

## ⚙️ How it works

```text
Agent / SDK ──OpenAI Videos API──▶ Magpie gateway ──▶ plugin fetch
                                                       │
     POST /videos              ──▶  :predictLongRunning        ─┐
     GET  /videos/{id}         ──▶  :fetchPredictOperation      ├─▶ Vertex AI Veo
     GET  /videos/{id}/content ──▶  inline bytes, or GCS ?alt=media ┘
```

- **Auth**: an RS256 JWT signed with `node:crypto`, exchanged for a `cloud-platform` access token.
- **Video id**: `{project, location, model, operation}` as base64url — only `[A-Za-z0-9_-]`, so it survives any URL path.
- **Status**: mapped to OpenAI's `queued` / `in_progress` / `completed` / `failed`.
- **Sign-in state** (`X-Magpie-Sign-In`): `expired` when the credentials are unusable; `kept` for Vertex 403 / 404 / 429 and the like, with Google's message passed on.

## 🌱 Environment variables

| Variable | Effect |
| :--- | :--- |
| `VERTEX_VEO_LEGACY_MODELS=1` | List Veo 3.0 / 3.0 Fast / 2.0 for every account |
| `VERTEX_VEO_EXTRA_MODELS="a,b"` | More model ids to list |
| `GOOGLE_APPLICATION_CREDENTIALS` | The credentials file the ADC method uses |
| `VERTEX_VEO_API_BASE` / `VERTEX_VEO_GCS_BASE` | Override the Vertex / GCS roots (tests, private endpoints) |

## 🧑‍💻 Development

```bash
git clone https://github.com/null0xfff/magpie-vertex-veo.git
cd magpie-vertex-veo
bun test
magpie plugin add "$PWD"   # install the checkout to try it
```

```text
index.mjs            entry; exports only the plugin (Magpie calls every exported function as a plugin)
lib/plugin.mjs       config / provider / auth hooks and the three video routes
lib/credentials.mjs  credential parsing, JWT signing, token cache and renewal
lib/veo.mjs          request mapping, video id codec, status mapping, result cache
lib/models.mjs       model list and capabilities
test/                bun test against a local mock of Google's token endpoint, Vertex and GCS
```

Issues and PRs welcome. User-facing messages in the plugin are in Chinese.

## 📄 License

[MIT](https://github.com/null0xfff/magpie-vertex-veo/blob/main/LICENSE)

Google, Google Cloud, Vertex AI and Veo are trademarks of Google LLC. This project is not affiliated with Google.
