# CPA 凭证管理前端设计文档（Codex Phase 1）

## 1. 目标

构建一个通过 CPA 管理 API 进行凭证管理的前端控制台，聚焦：

- 凭证查看与筛选
- 状态检测
- 自动禁用失效凭证
- 手动启用/禁用/删除
- 单次 OAuth 刷新流程

不包含：
- 凭证额度展示
- 计费分析图表

## 2. 风格与框架（按 CLIProxyAPI 管理面板风格）

### 2.1 总体风格

- 运维控制台风格：简洁、密度高、信息优先
- 弱装饰、强反馈
- 组件状态明确（成功/失败/禁用/进行中）

### 2.2 技术栈建议

- `React + TypeScript + Vite`
- 数据请求：`TanStack Query`
- 表格：`TanStack Table` 或等价组件
- 表单：`react-hook-form`（可选）
- 样式：`CSS Modules` 或 `Tailwind`（二选一，建议固定一套）

### 2.3 代码类型要求

- TypeScript `strict: true`
- API 与页面分层，禁止页面内散落 fetch 逻辑
- 核心模型统一类型定义（Credential、OAuthState、OperationLog）

## 3. 信息架构

## 3.1 页面结构

1. 顶部连接区
   - CPA URL
   - Management Key
   - 连接状态
2. 凭证列表页（主页面）
   - 筛选栏
   - 凭证表格
   - 批量操作栏
3. OAuth 刷新页（或抽屉）
   - OAuth Start
   - 回调提交
   - 状态轮询
4. 操作日志区
   - 最近操作
   - 失败明细

## 3.2 导航建议

- 一级菜单：
  - `Credentials`
  - `OAuth Refresh`
  - `Operation Logs`

## 4. UI 组件清单

- `ConnectionBar`
- `CredentialFilterPanel`
- `CredentialTable`
- `BatchActionBar`
- `CredentialDetailDrawer`
- `OAuthStartPanel`
- `OAuthCallbackPanel`
- `OperationLogPanel`
- `ConfirmDialog`
- `Toast/Alert`

## 5. 状态与交互设计

## 5.1 凭证列表

- 字段建议：
  - `name/id`
  - `provider`
  - `auth_index`（可截断显示）
  - `disabled`
  - `last_check_status`
  - `last_check_time`

## 5.2 批量检测与自动禁用

1. 用户点击“检测全部（Codex）”
2. 前端并发探测每条凭证
3. 将结果归类为 `active/invalidated/deactivated/unauthorized/unknown`
4. 若开启“自动禁用失效”
   - 对失效项调用禁用接口
5. 输出本次任务摘要
   - 总数
   - active 数
   - 禁用成功/失败数

## 5.3 OAuth 刷新流程

1. 调用 `codex-auth-url` 获取 `auth_url/state`
2. 引导用户在浏览器完成登录并拿到 callback URL
3. 提交 `oauth-callback`
4. 轮询 `get-auth-status`
5. 返回成功或失败信息

## 6. API 适配层设计

建议建立统一 API 客户端：

- `getOAuthStart(provider, isWebui)`
- `postOAuthCallback(provider, redirectUrl, state?)`
- `getOAuthStatus(state)`
- `listAuthFiles()`
- `probeCredential(authIndex)`
- `patchCredentialStatus(nameOrId, disabled)`
- `deleteCredential(name)`

所有请求统一处理：
- 鉴权头注入
- 超时
- 错误格式归一化
- 重试策略（仅幂等 GET）

## 7. 数据模型建议（前端）

```ts
type Provider = "codex";

type Credential = {
  id: string;
  name: string;
  provider: Provider | string;
  auth_index: string;
  disabled: boolean;
};

type CheckStatus =
  | "active"
  | "invalidated"
  | "deactivated"
  | "unauthorized"
  | "unknown";

type OperationLog = {
  at: string;
  action: string;
  target: string;
  ok: boolean;
  message: string;
};
```

## 8. 视觉样式建议

- 颜色：
  - `active`: 绿色
  - `disabled`: 灰色
  - `invalid`: 红色
  - `running`: 蓝色
- 字体：
  - 系统字体（Windows 优先 Segoe UI）
- 布局：
  - 左右留白固定
  - 列表区为主，日志区可折叠
- 动效：
  - 仅加载骨架、按钮 loading、状态淡入

## 9. 安全与可运维性

- `management_key` 默认只驻留内存
- 高危操作（禁用/删除）二次确认
- 所有操作写本地日志面板，便于排障
- 支持导出本次操作结果（JSON/JSONL）

## 10. 迭代建议

Phase 1（当前）：
- `codex` 凭证管理完整可用

Phase 2：
- 抽象 provider 适配器（`antigravity` 等）
- OAuth 流程组件复用化
- 批量任务调度与取消能力
