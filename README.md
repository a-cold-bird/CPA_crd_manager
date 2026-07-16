# CPA Remote Account Manager

用于管理远程 CPA 服务中的凭证：查看和探测账号状态、按配额自动禁用或恢复、手动禁用、删除、归档及恢复。项目不包含账号注册、邮箱接入、自动补号、Python 或浏览器自动化。

## Configuration

配置只支持以下字段：

```yaml
cpa_url: http://host.docker.internal:8317
management_key: sk-39c5bb
auto_probe_enabled: false
auto_probe_interval_minutes: 60
auto_probe_batch_size: 5
codex_quota_disable_remaining_percent: 10
```

首次登录使用 `sk-39c5bb`。登录后应立即在设置页换成强管理密钥。本机直接运行时，通常将 `cpa_url` 改为 `http://127.0.0.1:8317`。

## Docker

镜像使用 pinned Node.js 24 multi-stage build，只包含生产 Node dependencies、构建后的前端和远程管理服务，不安装 Python、Playwright 或浏览器。

```powershell
docker compose up -d --build
```

首次启动会自动将默认配置写入 `docker-data/config/config.yaml`。Compose 保留 `host.docker.internal` 到宿主机的映射，因此 CPA 运行在宿主机时可直接使用默认 URL。

容器以非 root UID/GID 运行。Linux 主机不是 `1000:1000` 时，将 `.env` 中的 `CPA_MANAGER_UID` 和 `CPA_MANAGER_GID` 设置为 `id -u` 和 `id -g` 的输出，并确保挂载目录可由该用户写入。

容器端口和 built frontend 均固定为 `8333`，默认仅绑定 `127.0.0.1:8333`。

健康检查：`http://127.0.0.1:8333/api/health`

## Local Node

需要 Node.js 24 和 npm：

```powershell
Copy-Item frontend/config.example.yaml frontend/config.yaml
Push-Location frontend
npm ci
npm run build
node server.js
```

Linux/macOS 使用对应的 `cp` 和 `cd frontend` 命令。默认访问 `http://127.0.0.1:8333`。

## Runtime State And Security

- Docker 配置挂载在 `/app/config`，持久状态挂载在 `/app/runtime`；重建容器不会删除宿主机数据。
- `runtime/credential_runtime_state.json` 保存探针和 runtime-owned disable 状态。手动禁用的凭证不会被自动恢复。
- `runtime/credential_archive.json` 保存归档状态。升级、迁移或手工清理前应备份这两个文件。
- 不要在服务运行时手工修改 runtime JSON；状态写入使用序列化和原子替换。
- 不要提交 `.env`、本地 `config.yaml`、runtime 状态、账号/token 数据、日志、压缩包或 session transcript。`.dockerignore` 同样排除这些 secret/runtime artifacts。
- 如果凭证曾进入 Git 历史，应先轮换凭证；只从当前版本删除不能撤销泄露。
