# 配置与环境变量

所有路径和端口都可以改，代码里**没有写死任何盘符**。
不配置也能跑：默认值会从脚本位置和 `%LOCALAPPDATA%` 推导出来。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_POCKET_ROOT` | 脚本所在目录 | 仓库根目录 |
| `DSH_STATE_DIR` | `%LOCALAPPDATA%\dsh-pocket` | 状态文件目录（tunnel.json / pairing.json / 日志）|
| `DSH_CLI` | 自动查找 | `dsh.cmd` 的完整路径 |
| `DSH_CLOUDFLARED` | 自动查找 | `cloudflared.exe` 的完整路径 |
| `DSH_WEB_PORT` | `3095` | DSH Web 端口 |
| `DSH_TUNNEL_PORT` | `3199` | 隧道控制服务端口 |
| `DSH_PERMISSION_MODE` | `workspace-write` | DSH 权限模式 |

### dsh 的自动查找顺序

1. `$env:DSH_CLI`
2. `PATH` 里的 `dsh`
3. `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`
4. `%ProgramFiles%\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`

### cloudflared 的自动查找顺序

1. `$env:DSH_CLOUDFLARED`
2. `PATH` 里的 `cloudflared`
3. `E:\cloudflared\cloudflared.exe`（这是历史遗留的默认位置，建议新装用 `%LOCALAPPDATA%`）
4. `%LOCALAPPDATA%\cloudflared\cloudflared.exe`
5. `%ProgramFiles%\cloudflared\cloudflared.exe`

**建议**：把 cloudflared 放到 `%LOCALAPPDATA%\cloudflared\`，
或者直接加进 PATH，就不用设环境变量了：

```powershell
# 方式一：放进推荐的默认位置
mkdir "$env:LOCALAPPDATA\cloudflared"
# 把 cloudflared.exe 复制进去

# 方式二：加进 PATH（当前用户，永久）
[Environment]::SetEnvironmentVariable(
  'Path',
  [Environment]::GetEnvironmentVariable('Path','User') + ";C:\你的\cloudflared目录",
  'User'
)
```

## 状态目录里有什么

```
%LOCALAPPDATA%\dsh-pocket\
├── tunnel.json          # 隧道状态（域名、pid、token）
├── pairing.json         # 配对信息（局域网地址 + token）
├── tunnel.log           # cloudflared 输出
├── tunnel.log.err
├── tunnel.pid
├── tunnel-service.log   # 控制服务输出
└── tunnel-service.pid
```

> **注意**：`tunnel.json` 和 `pairing.json` 里**有 token**，
> 拿到就能操作你电脑上的 DSH。别提交到仓库、别随便传给别人。
> 仓库的 `.gitignore` 已经把这两个文件名和 `_*.log` 都排除了。

## 改端口

```powershell
# DSH Web 用 8080
.\start-dsh-web.ps1 -Port 8080

# 隧道控制服务跟着改（两个必须一致）
$env:DSH_WEB_PORT = 8080
$env:DSH_TUNNEL_PORT = 3299
.\start-tunnel-service.ps1
```

插件面板读的是控制服务的 `/tunnel/status`，
所以只要服务端配置对，插件不用改。

## 放到别的盘 / 别的机器

```powershell
# clone 到任意位置
git clone https://github.com/xisnn/dsh-pocket.git D:\tools\dsh-pocket
cd D:\tools\dsh-pocket

# 直接跑就行，路径会从脚本位置推导
.\start-dsh-web.ps1 -Bind lan
```

不用设任何环境变量 —— `$PSScriptRoot` 会自动指向脚本所在目录。

## 排查

```powershell
# 看服务实际用的路径
node -e "console.log(process.env.LOCALAPPDATA + '\\dsh-pocket')"

# 看服务状态（含诊断字段）
curl http://127.0.0.1:3199/tunnel/status

# 看 DSH 找没找到
.\start-dsh-web.ps1 -Bind lan   # 找不到会明说
```
