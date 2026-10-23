# 上传大文件到 GitHub Release

记录往 Release 上传大资产时踩的坑，以及可用的方法。

---

## 现象

上传 112 MB 的桌面端 zip 时，**四种方式全部卡死**：

| 方式 | 结果 |
|---|---|
| `curl --data-binary` | 卡在 `state=starter`，20 分钟不动 |
| `curl -T`（流式） | 同上 |
| `HttpClient.PostAsync` | 5 分钟后报「将内容复制到流时出错」 |
| `gh release upload` | 同上 |

但 **APK（72.8 MB）能正常上传**，这让人误以为是大小阈值问题。

关键误导点：API 返回的 `size` 一开始就是完整的 `112.4 MB`，
看起来「数据传完了，只是 GitHub 收尾慢」。

---

## 真正的根因

**本机代理的 fake-ip 模式干扰了 `uploads.github.com`。**

```
$ Resolve-DnsName uploads.github.com
uploads.github.com  →  198.18.1.110
```

`198.18.0.0/15` 是 **RFC 2544 保留段**（基准测试专用），不可能是 GitHub 的地址。

对照其他域名：

```
github.com           → 198.18.0.117
api.github.com       → 198.18.0.36
uploads.github.com   → 198.18.1.110
codeload.github.com  → 198.18.1.132
```

全是 fake-ip。代理软件（Clash 之类）在 TUN/透明代理模式下接管了 DNS，
把这些域名解析到一个本地虚拟 IP。

**为什么小请求能通、大文件不行**：
代理能处理 API 的短连接，但长时间的大流量上传会被中断或挂起。

**为什么 APK 能成功**：72.8 MB 相对小，在代理撑不住之前就传完了。

---

## 解法：强制直连真实 IP

### 1. 拿到真实 IP

```powershell
Invoke-RestMethod -Uri 'https://dns.google/resolve?name=uploads.github.com&type=A' |
  Select-Object -ExpandProperty Answer |
  Where-Object { $_.type -eq 1 } |
  Select-Object -ExpandProperty data
```

得到 `140.82.116.14`（`uploads.github.com` 的真实地址）。

### 2. 用 `--resolve` 绕过 DNS

```powershell
curl.exe -X POST `
  --resolve "uploads.github.com:443:140.82.116.14" `
  -H "Authorization: Bearer $token" `
  -H "Content-Type: application/zip" `
  -H "Expect:" `
  --data-binary "@包.zip" `
  "https://uploads.github.com/repos/<owner>/<repo>/releases/<releaseId>/assets?name=<文件名>"
```

**成功**：HTTP 201，248 秒，476 KB/s。

> `-H "Expect:"` 去掉 `Expect: 100-continue` —— 某些代理不处理它，
> 会导致 curl 一直等下去。

### 3. API 请求也要加 `--resolve`

```powershell
curl.exe --resolve "api.github.com:443:140.82.116.6" ...
```

`api.github.com` 的真实 IP 用同样方法查。

---

## 顺带：压缩能让体积减半

原本 260 MB 的 Electron 包，改压缩策略后变成 **112 MB**：

| 配置 | 大小 |
|---|---|
| store（不压缩） | 260.6 MB |
| deflate level 6 | 260.6 MB |
| **deflate level 9** | **112.4 MB** |

之前的假设「Electron 的 exe/dll 已经压过了，再压没用」是**错的** ——
那些文件确实压不了多少，但 `icudtl.dat`、`resources.pak`、
`LICENSES.chromium.html` 加起来可压空间很大。

打包时间只多约 20 秒，但用户下载快一半，上传也稳得多。

见 `dsh-outpost-desktop/pack.js` 的压缩策略注释。

---

## 检查清单

上传大文件前先确认：

- [ ] `Resolve-DnsName uploads.github.com` 返回的是真实 IP（不是 `198.18.x.x`）
- [ ] 如果是 fake-ip，用 `--resolve` 强制直连
- [ ] 加 `-H "Expect:"` 避免 100-continue 卡住
- [ ] 先确认包体积能不能再压（往往能减一半）
- [ ] 上传后用 API 确认 `state` 变成 `uploaded`（不是 `starter`）
- [ ] 用 `curl -L --range 0-1023` 验证下载链接返回 206

---

## 怎么判断「卡住」还是「还在传」

API 返回的 `state` 字段：

| state | 含义 |
|---|---|
| `starter` | 已创建记录，数据在传（或卡住） |
| `uploaded` | 完成，可以下载 |

**`size` 字段不可靠** —— 它在创建时就填成最终大小了，
不代表数据真的传完。只看 `state`。

---

## 参考

- [Release Assets API](https://docs.github.com/en/rest/releases/assets)
- [RFC 2544 保留地址段](https://datatracker.ietf.org/doc/html/rfc2544)
