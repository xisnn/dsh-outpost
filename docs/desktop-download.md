# 下载与合并桌面助手

GitHub Release 上的桌面助手包是**分卷**的（因为单个 112 MB 文件在网络不稳时容易传断）。

## 为什么分卷

单文件上传实测：

| 方式 | 结果 |
|---|---|
| 112 MB 整包 | 900 秒超时 / 1150 秒超时，两次都失败 |
| **分 6 卷（每卷 20 MB）** | **131 秒全部成功** |

分卷绕过了「长连接不稳定」的问题：每个小文件都能在超时前传完，失败了单独重试。

---

## 下载

从 [Releases](https://github.com/xisnn/dsh-outpost/releases) 下载全部 6 个文件：

```
DSH-Outpost-Desktop-0.15.5-win-x64.zip.part01
DSH-Outpost-Desktop-0.15.5-win-x64.zip.part02
DSH-Outpost-Desktop-0.15.5-win-x64.zip.part03
DSH-Outpost-Desktop-0.15.5-win-x64.zip.part04
DSH-Outpost-Desktop-0.15.5-win-x64.zip.part05
DSH-Outpost-Desktop-0.15.5-win-x64.zip.part06
```

**六个都要下**，缺一个就合并不了。

---

## 合并

### PowerShell（Windows 自带）

把 6 个文件放在同一个目录，然后：

```powershell
cd 下载目录

# 按顺序拼接
$out = "DSH-Outpost-Desktop-0.15.5-win-x64.zip"
if (Test-Path $out) { Remove-Item $out }

Get-ChildItem "DSH-Outpost-Desktop-0.15.5-win-x64.zip.part*" |
  Sort-Object Name |
  ForEach-Object {
    $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
    [System.IO.File]::AppendAllBytes((Join-Path $PWD $out), $bytes)
  }

# 检查大小（应该是 112.4 MB 左右）
Get-Item $out | Select-Object Name, @{N='MB';E={[math]::Round($_.Length/1MB,1)}}
```

> `AppendAllBytes` 需要 PowerShell 7+。Windows 10/11 自带的 5.1 没有这个 API，
> 用下面的替代写法。

### PowerShell 5.1（Windows 10/11 默认）

```powershell
cd 下载目录

$out = "DSH-Outpost-Desktop-0.15.5-win-x64.zip"
$fs = [System.IO.File]::Create((Join-Path $PWD $out))
try {
  Get-ChildItem "DSH-Outpost-Desktop-0.15.5-win-x64.zip.part*" |
    Sort-Object Name |
    ForEach-Object {
      $in = [System.IO.File]::OpenRead($_.FullName)
      try { $in.CopyTo($fs) } finally { $in.Close() }
    }
} finally { $fs.Close() }

Get-Item $out | Select-Object Name, @{N='MB';E={[math]::Round($_.Length/1MB,1)}}
```

### 命令行（cmd + copy）

```cmd
cd 下载目录
copy /b DSH-Outpost-Desktop-0.15.5-win-x64.zip.part01+DSH-Outpost-Desktop-0.15.5-win-x64.zip.part02+DSH-Outpost-Desktop-0.15.5-win-x64.zip.part03+DSH-Outpost-Desktop-0.15.5-win-x64.zip.part04+DSH-Outpost-Desktop-0.15.5-win-x64.zip.part05+DSH-Outpost-Desktop-0.15.5-win-x64.zip.part06 DSH-Outpost-Desktop-0.15.5-win-x64.zip
```

### 7-Zip

右键 `part01` → 7-Zip → 提取到当前位置。7-Zip 会自动识别分卷。

---

## 校验（可选但推荐）

合并后的大小应该是 **112.4 MB**（117,929,175 字节左右）。

如果大小不对，说明某个分卷没下完整。各分卷的正确大小：

| 分卷 | 大小 |
|---|---|
| part01 ~ part05 | 20 MB（20,971,520 字节） |
| part06 | 12.36 MB（12,958,135 字节） |

MD5（用来确认下载完整）：

```
part01  894417CBB0F41E31132A3DB213843D99
part02  163EBF8C2775676D7C63112F005131E2
part03  8AC8FB59BD45E76EBDB11373DE991F98
part04  8128B12E7975FEB7A0B8C74632DCC07B
part05   EC012B15682E41FAF408C1AE28CC8293
part06  A976DD3D9FA04909151A5A064B238B9E
```

检查某个分卷：

```powershell
Get-FileHash "DSH-Outpost-Desktop-0.15.5-win-x64.zip.part01" -Algorithm MD5
```

---

## 解压与运行

合并出的 `.zip` 是正常的压缩包：

1. 右键 → 全部解压
2. 双击 `DSH Outpost.exe`
3. 遇到 SmartScreen → **更多信息 → 仍要运行**

详见 [桌面助手 README](../dsh-outpost-desktop/README.md)。

---

## 如果还是不行

**网络问题**：GitHub 在国内访问不稳定。可以试试：

- 用代理/VPN 后重下
- 用 [ghproxy](https://ghproxy.com/) 之类的镜像加速：把链接前面加 `https://ghproxy.com/`
- 挑网络好的时段重试

**分卷缺失**：告诉我缺哪个，我重新上传那一卷。

**合并后解压失败**：先确认大小对不对，多半是某个分卷没下完整。
