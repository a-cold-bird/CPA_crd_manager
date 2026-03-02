# CPA 凭证管理 API 文档（Codex Phase 1）

## 1. 目的与范围

本文件用于前端直接对接 CPA 服务完成 `codex` 凭证管理，不包含额度展示。

支持能力：
- 获取 OAuth 登录链接
- 提交 OAuth 回调并轮询状态
- 查询凭证列表
- 探测凭证是否有效
- 自动禁用失效凭证
- 启用/禁用单个凭证
- 删除凭证

## 2. 访问约定

- Base URL: `http://<cpa-host>:<port>`
- 所有管理 API 前缀：`/v0/management`
- 认证头：`Authorization: Bearer <management_key>`
- 内容类型：
  - `GET/DELETE`: 无 body
  - `POST/PATCH`: `Content-Type: application/json`

## 3. API 列表

### 3.1 获取 OAuth 链接

- 方法：`GET`
- 路径：`/v0/management/codex-auth-url`
- Query：
  - `is_webui=true|false`
- 成功响应示例：

```json
{
  "status": "ok",
  "url": "https://auth.openai.com/oauth/authorize?...&state=xxx",
  "state": "xxx"
}
```

### 3.2 提交 OAuth 回调

- 方法：`POST`
- 路径：`/v0/management/oauth-callback`
- 请求体：

```json
{
  "provider": "codex",
  "redirect_url": "http://localhost:1455/auth/callback?code=...&state=...",
  "state": "optional_state_override"
}
```

- 成功响应：

```json
{
  "status": "ok"
}
```

### 3.3 查询 OAuth 状态

- 方法：`GET`
- 路径：`/v0/management/get-auth-status`
- Query：
  - `state=<oauth_state>`
- 响应示例：

```json
{
  "status": "wait"
}
```

```json
{
  "status": "ok"
}
```

```json
{
  "status": "error",
  "error": "unknown or expired state"
}
```

### 3.4 查询凭证列表

- 方法：`GET`
- 路径：`/v0/management/auth-files`
- 成功响应（节选）：

```json
{
  "files": [
    {
      "id": "codex-user@example.com-free.json",
      "name": "codex-user@example.com-free.json",
      "provider": "codex",
      "auth_index": "xxxxxxxxxxxxxxxx",
      "disabled": false
    }
  ]
}
```

### 3.5 凭证探测（有效性检查）

- 方法：`POST`
- 路径：`/v0/management/api-call`
- 请求体（codex 探测）：

```json
{
  "auth_index": "xxxxxxxxxxxxxxxx",
  "method": "POST",
  "url": "https://chatgpt.com/backend-api/codex/responses",
  "header": {
    "Authorization": "Bearer $TOKEN$",
    "Content-Type": "application/json",
    "Openai-Beta": "responses=experimental",
    "Version": "0.98.0",
    "Originator": "codex_cli_rs",
    "User-Agent": "codex_cli_rs/0.98.0"
  },
  "data": "{\"model\":\"gpt-4.1-mini\",\"input\":\"ping\",\"stream\":false}"
}
```

- 成功响应（外层固定 200，需解析内部字段）：

```json
{
  "status_code": 200,
  "body": "{\"ok\":true}"
}
```

### 3.6 设置凭证启用/禁用

- 方法：`PATCH`
- 路径：`/v0/management/auth-files/status`
- 请求体：

```json
{
  "name": "codex-user@example.com-free.json",
  "disabled": true
}
```

- 响应：

```json
{
  "status": "ok",
  "disabled": true
}
```

### 3.7 删除凭证

- 方法：`DELETE`
- 路径：`/v0/management/auth-files`
- Query：
  - `name=<credential_name>`
- 响应：

```json
{
  "status": "ok"
}
```

## 4. Codex 状态分类规则（前端展示建议）

前端根据 `api-call` 返回的 `status_code/body` 分类：

- `invalidated`
  - `status_code == 401` 且 body 含 `invalidated`
- `deactivated`
  - `status_code == 401` 且 body 含 `deactivated`
- `unauthorized`
  - `status_code == 401` 且不满足以上两类
- `active`
  - `status_code` 属于 `{200,201,400,402,403,404,409,422,429}`
- `unknown`
  - 其他情况

## 5. 推荐业务流程

### 5.1 自动禁用失效凭证

1. 拉取 `/auth-files`（过滤 `provider=codex`）。
2. 对每条凭证调用 `/api-call` 做探测。
3. 对 `invalidated/deactivated/unauthorized/expired_by_time` 执行 `/auth-files/status disabled=true`。
4. 记录结果日志（成功数、失败数、失败原因）。

### 5.2 单次刷新凭证（OAuth）

1. `GET /codex-auth-url`
2. 浏览器登录拿回调 URL
3. `POST /oauth-callback`
4. `GET /get-auth-status?state=...` 直到 `ok/error/timeout`

## 6. 常见错误码

- `400`: 参数错误（如缺失 `state`/`code`）
- `401`: 管理密钥无效
- `404`: 未找到 state 或凭证
- `409`: OAuth 状态不是 pending（重复提交）
- `500`: 服务端内部异常

## 7. 安全建议

- `management_key` 仅保存在前端内存，不做长期持久化。
- 不在前端日志打印完整回调 URL（避免泄露 code/state）。
- 对高风险操作（禁用/删除）增加二次确认。
