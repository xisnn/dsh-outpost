# 05 · 新发现：P4-0.2 锁仲裁残留竞态（三进程交错，CI 负载暴露）

- 状态：**RED 证据确凿，修复待第二方批准**（锁仲裁 = 持久化安全敏感模块）。
- 归属：缺陷存在于 P4-0.2 仲裁代码（`patches/mobile-gateway-home-isolation/files/registry-lock.js`），
  **P4-0.3 未改该模块一行**；CI（Node 20/Linux，run 44544978457）负载下首次暴露。
  本地 Node 24 全量链 122/122 绿（含本 spec 默认 15 轮）——概率性，非必现。

## CI 违例轨迹（ticket-race round 5，15×4）

```
ACQUIRED 53939                      ← 正常 reclaim 死锁 L0，发布 L39
REFUSED  53940 "a concurrent reclaim changed the lock…"
ACQUIRED 53938                      ← 第二所有者（违例）
REFUSED  53937 "already owned by live process 53938"
STILLOWNS 53939 NO                  ← 活主 53939 的记录被顶替
```

## 根因（代码级，registry-lock.js）

1. 53939：take-away L0 → 验证死 → `wx` 发布 L39 → finally 清 marker M39。
2. 53938：在 53939 的 take→publish 空窗内 `wx` 创建**空占位**成功，进入
   「defer to live reclaimer」检查队列。
3. 53940：confirm 读到 L0（死）→ take-away 时取走的已是 **L39（活）**→
   mis-take 分支 `linkSync(grave40, lockPath)` 因占位存在而 EEXIST →
   throw（400 行）→ **finally 清 marker M40**（428 行）→ L39 孤悬 grave40。
4. 53938：`liveReclaimInProgress` 见 M39/M40 均已清 → 放行；
   `recoverCrashedReclaim` 只救**死** reclaimers 的孤儿（264 行 `isAlive → continue`）→
   无 failClosed → 认领空占位，写 L38 → 双所有权。

两个洞：
- **A**：mis-take 归还失败即 throw 且 finally 无条件清 marker，活记录孤儿化后
  窗口失去守卫（活 reclaimer 放弃时 marker 不应清）。
- **B**：fresh-create 认领空占位前不扫 grave；任何 grave 里躺着活记录即意味着
  存在被顶替的活主，应 fail-closed（与补充修复「活主不可证明缺席即拒绝」同向）。

## 修复设计（只紧不松，待批准）

- A：mis-take 且 `linkSync` 失败时置 `orphanLiveTaken=true`，finally **保留 marker**
  （活 pid 守卫窗口）；进程退出后 `recoverCrashedReclaim` 按既有孤儿规程恢复/拒启。
  归还成功路径不变。
- B：fresh-create 在 `liveReclaimInProgress` 与 `recoverCrashedReclaim` 之后、
  认领之前，扫 `RECLAIM_PREFIX` sidecars：任一 grave 记录 `isAlive(pid)` →
  退避（unlink 自己的空占位，sleep，continue），不认领。
- 不改动：wx 仲裁唯一性、take-away 原子性、fail-closed 清单、混版 stop-the-world 结论。
- 验证：本 spec 高轮次（30+）RED→GREEN；JVM 无关（纯 JS 模块）；
  混版安全文档需补「P4-0.2↔P4-0.3 仲裁补丁亦须 stop-the-world」。

## 本轮处置

- 不削弱断言、不降轮次、不重试掩盖；CI 红如实交付并归因。
- 本地高轮次复现日志：`P4-0.3-lock-race-local-repro.log`（30 轮）：
  **35/35 绿、0 违例**——与「概率性、需 CI 负载与三进程交错」定性一致；
  发现以 CI 轨迹 + 代码级根因为准，不宣称本地必现。
- 审批表单超时未答 ⇒ 按治理「未批准 = 不修」，**本轮不动锁模块**；
  修复设计待第二方批准后另提交（同分支），复跑 CI 双绿再议合并。
