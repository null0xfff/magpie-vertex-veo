# magpie-vertex-veo

[Magpie](https://github.com/yetone/magpie) / OpenCode Provider 插件：把 **Google Vertex AI Veo** 视频模型接入 Magpie 的 `/v1/videos` 网关和 `magpie-image` MCP（`generate_video` / `generation_result`）。

- 无头运行：用 **Service Account JSON 文件路径**、**直接粘贴 JSON** 或 **ADC** 登录，不需要浏览器。
- 零依赖：只用 Bun 内置 API、`node:crypto` 和宿主注入的全局 `fetch`（自动走 Magpie 的代理设置）。
- 协议转换：OpenAI Videos API（`POST /videos`、`GET /videos/{id}`、`GET /videos/{id}/content`）⇄ Vertex AI（`:predictLongRunning`、`:fetchPredictOperation`），视频可内联返回字节，也可写到 GCS 后由插件流式转发。
- 多账号：每个 Magpie 账号各自的凭据、项目和 Token 缓存，互不混用。

## 模型

| 模型 ID | 说明 |
| --- | --- |
| `veo-3.1-generate-001` | Veo 3.1（默认推荐） |
| `veo-3.1-fast-generate-001` | Veo 3.1 Fast |
| `veo-3.1-lite-generate-001` | Veo 3.1 Lite |
| `veo-3.0-generate-001` / `veo-3.0-fast-generate-001` / `veo-2.0-generate-001` | 可选：登录时选「Also list Veo 3.0 / Veo 2 models? → Yes」，或设置环境变量 `VERTEX_VEO_LEGACY_MODELS=1` |

Google 发布了新的模型 ID（比如 preview 版）时，可以用环境变量 `VERTEX_VEO_EXTRA_MODELS="id1,id2"` 加进来，不用等插件更新。

所有模型都只声明视频输出（`capabilities.output.video = true`，`text = false`），Magpie 会把它们算作视频模型（`customVideomakers`）。

## 安装

要求 `magpie >= 0.1.4029`。

```bash
# 在 Docker 容器里（容器名按你的实际情况）
docker exec -it magpie-magpie-1 /magpie plugin add github:null0xfff/magpie-vertex-veo
```

也可以装本地目录：先把仓库放到容器能读到的位置，再执行 `/magpie plugin add /path/to/magpie-vertex-veo`。

> 仓库是 private 的话，容器里的 git 需要有 GitHub 读取权限；否则把仓库改成 public，或者用本地目录安装。

## 登录 / 配置

把 Service Account 密钥放进容器挂载目录，例如 `/config/credentials/vertex-still-function-sa.json`。这个 Service Account 需要有 Vertex AI 权限（如 `roles/aiplatform.user`）；如果用 GCS 输出，还需要该存储桶的对象读权限。

```bash
docker exec -it magpie-magpie-1 /magpie plugin login vertex-veo 1
```

也可以在 Magpie Web 界面里给 **Vertex AI Veo** 添加账号。有三种方式：

1. **Service account key file (path inside the container)**（Docker 推荐）
   - `credentialsPath`：`/config/credentials/vertex-still-function-sa.json`
   - `projectId`：可留空，留空时使用 JSON 里的 `project_id`
   - `location`：可留空，默认 `us-central1`
   - `storageUri`：可留空。留空时 Vertex 直接把视频字节内联返回，不需要 GCS 存储桶；填 `gs://bucket/prefix/` 则视频写到 GCS，插件再用同一个 SA Token 流式下载
   - `accountLabel`：可选，账号显示名称
   - 每次请求都会重新读取密钥文件，轮换密钥文件后不需要重新登录。
2. **Paste service account key JSON**：粘贴完整 JSON，字段同上。JSON 会作为账号的 key 保存在 Magpie 的凭据存储里，不会写进 metadata。
3. **Application Default Credentials**：使用 `GOOGLE_APPLICATION_CREDENTIALS`、gcloud 的 `application_default_credentials.json`（`authorized_user`），或者 GCE/GKE 元数据服务器。

登录时插件会实际换取一次 OAuth Token 来校验凭据，密钥错误会在登录时直接报出来，不会等到第一次生成视频才失败。

### 设为默认视频模型

在 Magpie 设置的模型页把视频生成模型（Video generation）选为 `vertex-veo/veo-3.1-generate-001`。之后 `magpie-image` MCP 的 `generate_video`，以及不指定 `model` 的 `/v1/videos` 请求都会使用它。

## 调用示例

```bash
curl -s http://127.0.0.1:3425/v1/videos \
  -H "Authorization: Bearer $MAGPIE_KEY" -H "Content-Type: application/json" \
  -d '{"model":"vertex-veo/veo-3.1-generate-001","prompt":"A fluffy orange cat on a sunlit windowsill","seconds":"8","size":"1280x720"}'
# → {"id":"video_vertex-veo....","status":"queued",...}
curl -s http://127.0.0.1:3425/v1/videos/<id> -H "Authorization: Bearer $MAGPIE_KEY"
curl -s http://127.0.0.1:3425/v1/videos/<id>/content -H "Authorization: Bearer $MAGPIE_KEY" -o out.mp4
```

### 参数映射

| OpenAI / Magpie 字段 | Vertex Veo |
| --- | --- |
| `prompt` | `instances[0].prompt` |
| `input_reference`（`data:` URL 或 `gs://`） | `instances[0].image` |
| `last_frame` | `instances[0].lastFrame` |
| `reference_images[]`（最多 3 张） | `instances[0].referenceImages[] = {image, referenceType:"asset"}` |
| `seconds` | `durationSeconds`：Veo 3.x 取 4/6/8 中最接近的值，Veo 2 取 5–8；不传时为 8 |
| `size` = `16:9` / `9:16` | `aspectRatio` |
| `size` = `WIDTHxHEIGHT` | 按宽高比得到 `aspectRatio`，按短边得到 `resolution`（≥2160 → `4k`，≥1080 → `1080p`，其余 → `720p`） |
| `size` = `720p` / `1080p` / `4k` | `resolution`（只对 Veo 3 系列生效） |
| `aspect_ratio`、`resolution` | 显式指定，优先级高于 `size` |
| `n` / `sampleCount` | `sampleCount`（1–4，只返回第一个视频） |
| `negative_prompt`、`person_generation`、`generate_audio`、`seed`、`enhance_prompt`、`compression_quality`、`resize_mode`、`storage_uri` | 对应的 camelCase 参数原样透传 |

Veo 3 系列在没传 `generate_audio` 时默认开启音频（`generateAudio: true`）。

### 状态与错误

- `GET /videos/{id}` 返回 OpenAI 的状态枚举：`in_progress`、`completed`、`failed`（Vertex 报错，或安全过滤 `content_filtered`）。
- 视频 ID 是 `{project, location, model, operation}` 经 base64url 编码后的字符串，只含 `[A-Za-z0-9_-]`。
- `X-Magpie-Sign-In: expired` 只在凭据本身不可用时返回：密钥文件读不到或无法解析、私钥无法签名、Google Token 端点返回 `invalid_grant` 或 401、Vertex 用新 Token 重试后仍然 401。Vertex 的 403（没有 Veo 权限或配额）、404（该区域没有这个模型）、429 等错误返回 `kept`，并把原始错误信息透传出来。
- 已完成的结果只在内存里短时缓存：最多 2 条，TTL 120 秒，视频字节交出去后立即删除。

## 开发

```bash
bun test
```

测试在本地起一个 mock HTTP 服务器，模拟 Google Token 端点、Vertex Veo 和 GCS，覆盖以下内容：JWT RS256 签名与 Token 缓存（含过期刷新、并发去重），`models()` 输出，`POST /videos` 参数映射，视频 ID 编解码往返，四种状态流转，内联 Base64 视频与 `gs://` 流式下载，`X-Magpie-Sign-In` 状态，以及多账号隔离。

测试用的环境变量：`VERTEX_VEO_API_BASE` 改写 Vertex 根地址，`VERTEX_VEO_GCS_BASE` 改写 GCS 地址。

## License

MIT
