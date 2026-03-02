# CPA Credential Manager

## 安装

### 1) 克隆并进入项目目录

```powershell
git clone <your-repo-url>
cd CPA_crd_manager
```

### 2) 配置前端本地连接参数

编辑 `frontend/config.yaml`：

```yaml
cpa_url: http://127.0.0.1:8317
management_key: sk-39c5bb
```

注意：`management_key` 必须与远程 CPA 服务端配置的管理密码保持一致，否则 WebUI 登录会失败。

### 3) 本地启动（推荐）

```powershell
.\start.bat
```

默认访问：`http://localhost:8333`

### 4) Docker 启动（可选）

```powershell
docker compose up -d --build
```

默认访问：`http://localhost:8333`
