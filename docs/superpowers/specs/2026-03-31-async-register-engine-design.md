# 异步注册引擎改造设计文档

**日期：** 2026-03-31  
**状态：** 已批准  
**范围：** `internal_register/register.py`、`internal_register/email_utils.py`

---

## 1. 背景与目标

当前注册引擎使用 `ThreadPoolExecutor` 多线程并发。主要问题：

- OTP 等待期间（最长 120 秒）线程全程阻塞，worker 全被占满时新账号无法推进
- `email_utils._session_cookie` 全局共享无锁，多线程竞态
- `_http_session()` 每次新建 `requests.Session`，无连接复用
- `threading.Lock` 在异步环境下阻塞事件循环
- 随机延迟使用 `time.sleep`，阻塞线程

**目标：** 将注册引擎改造为基于 `asyncio` + `curl_cffi.AsyncSession` 的真异步并发，彻底消除线程阻塞，OTP 等待期间让出事件循环，使其他账号可继续推进。

---

## 2. 架构总览

### 并发模型对比

| 维度 | 改造前 | 改造后 |
|---|---|---|
| 并发机制 | `ThreadPoolExecutor(max_workers=N)` | `asyncio.Semaphore(N)` + `asyncio.gather` |
| HTTP 客户端（注册） | `curl_cffi.requests.Session`（同步） | `curl_cffi.requests.AsyncSession`（异步） |
| HTTP 客户端（邮件） | `requests.Session`（每次新建） | `httpx.AsyncClient`（模块级单例） |
| OTP 等待 | `time.sleep(2)`（阻塞线程） | `asyncio.sleep(2)`（挂起协程） |
| 随机延迟 | `time.sleep(...)` | `asyncio.sleep(...)` |
| 并发锁 | `threading.Lock` | `asyncio.Lock` |

### 对外接口

`run_batch()` 保持同名、同参数签名不变。内部改为：

```python
def run_batch(...):
    asyncio.run(_run_batch_async(...))
```

外部调用者（Web 服务、CLI）无需修改。

---

## 3. 文件改造清单

### 3.1 `internal_register/email_utils.py`

**依赖变更：**
- 移除 `import requests`
- 新增 `import httpx`、`import asyncio`

**模块级变量变更：**
- `_session_cookie: dict | None = None` → 保持，加 `_login_lock = asyncio.Lock()`
- 新增模块级 `_http_client: httpx.AsyncClient | None = None`，在首次使用时初始化

**函数改造：**

| 函数 | 改造内容 |
|---|---|
| `_http_session()` | 删除；改为模块级 `_get_http_client()` 返回持久 `httpx.AsyncClient` |
| `_login()` | `async def`，加 `async with _login_lock` + double-check |
| `_ensure_mail_session()` | `async def` |
| `list_mailbox_emails()` | `async def`，用 `_get_http_client()` 异步请求 |
| `fetch_email_detail()` | `async def` |
| `snapshot_mailbox_ids()` | `async def` |
| `snapshot_mailbox_max_id()` | `async def` |
| `fetch_verification_code()` | `async def`，`time.sleep` → `asyncio.sleep` |
| `create_test_email()` | `async def` |

**不变（纯逻辑）：**
- `extract_verification_code()`
- `generate_random_name()`
- `_coerce_email_id()`、`_coerce_timestamp()`、`_extract_message_timestamp()`
- `_build_email_content()`、`_normalize_domain_list()`

### 3.2 `internal_register/register.py`

**依赖变更：**
- 新增 `import asyncio`
- 删除 `from concurrent.futures import ThreadPoolExecutor, as_completed`（`run_batch` 中用 `asyncio.gather` 替代；ProxyPool 的代理验证保留局部 ThreadPoolExecutor）
- `threading.Lock` 用于 `_print_lock`、`_file_lock` 替换为 `asyncio.Lock()`

**模块级变量：**
- `_print_lock = asyncio.Lock()`
- `_file_lock = asyncio.Lock()`

**`_random_delay`：**
```python
async def _random_delay(low=0.3, high=1.0):
    await asyncio.sleep(random.uniform(low, high))
```

**`ChatGPTRegister` 类：**
- `__init__` 中不再创建 `Session`；改为在 `run_register` / `perform_codex_oauth_login_http` 开头用 `async with AsyncSession(...) as session` 或实例化后手动 `await session.close()`
- 所有发 HTTP 请求的方法改为 `async def` + `await`：
  - `visit_homepage`、`get_csrf`、`signin`、`authorize`
  - `register`、`send_otp`、`validate_otp`、`create_account`、`callback`
  - `perform_codex_oauth_login_http` 及其内部所有辅助闭包
  - `run_register`
- `create_temp_email`、`create_otp_wait_context`、`wait_for_verification_email` → `async def`

**`_save_codex_tokens`（文件写入）：**
- 改为 `async def`，内部文件写入用 `asyncio.to_thread(...)` 包装（避免阻塞事件循环）
- 同样适用于 `_save_stable_proxy_to_file`、`_save_stable_proxy_to_config`

**`_register_one`：**
- 改为 `async def _register_one(...)`

**`run_batch` / `_run_batch_async`：**
```python
def run_batch(total_accounts, output_file, max_workers, ...):
    asyncio.run(_run_batch_async(total_accounts, output_file, max_workers, ...))

async def _run_batch_async(total_accounts, output_file, max_workers, ...):
    sem = asyncio.Semaphore(max_workers)

    async def _bounded(idx):
        async with sem:
            return await _register_one(idx, total_accounts, ...)

    tasks = [asyncio.create_task(_bounded(idx)) for idx in range(1, total_accounts + 1)]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    # 统计 success/fail
```

**ProxyPool（保持现有线程安全）：**
- `ProxyPool` 内部的 `threading.Lock` 保持不变（内存操作极快，直接调用不阻塞事件循环）
- `_filter_valid_proxies` 内部的 `ThreadPoolExecutor` 保持不变（代理验证是一次性批量 IO，用 `asyncio.to_thread` 包装整个 `pool.refresh()` 调用即可）
- 在 `_run_batch_async` 开头：`await asyncio.to_thread(pool.refresh, force=True)`

---

## 4. 依赖变更

**`pyproject.toml` 修改：**
```toml
dependencies = [
  "PyYAML>=6.0",
  "requests>=2.31",       # 保留（其他模块可能用）
  "curl-cffi>=0.7.0",
  "httpx[http2]>=0.27",   # 新增，替代 email_utils 中的 requests
]
```

**Python 版本：** 已要求 `>=3.9`，满足 `asyncio.to_thread` 需求。

---

## 5. 错误处理

- `asyncio.gather(*tasks, return_exceptions=True)`：单个账号失败不影响其他任务，与现有行为一致
- 每个 `_register_one` 内部保留现有 try/except + retry 逻辑，只是从同步改为异步
- `AsyncSession` 异常类型与同步 `Session` 相同（来自 `curl_cffi`），现有 `_is_proxy_related_error` 逻辑不变

---

## 6. 不在本次范围内

- Web 服务层（`runtime/`、`frontend/`）不改动
- `ProxyPool` 不完全重写为异步（`to_thread` 包装已足够）
- 不引入 pipeline/stage 流水线架构
- 不改变任何配置文件格式或对外 API

---

## 7. 风险

| 风险 | 缓解 |
|---|---|
| `curl_cffi.AsyncSession` API 与同步版本差异 | 改前核对 curl_cffi 文档，确认所有参数兼容 |
| `asyncio.Lock` 在非异步上下文中无法使用 | `_print_lock` / `_file_lock` 仅在 async 函数中 `await` 使用，同步入口 `run_batch` 通过 `asyncio.run()` 进入异步环境 |
| 模块级 `httpx.AsyncClient` 生命周期 | 注册完成后在 `_run_batch_async` 结尾调用 `await _close_http_client()` 关闭 |
