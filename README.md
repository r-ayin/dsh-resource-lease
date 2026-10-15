# dsh-resource-lease — 资源租约治理插件

解决「agent 打开浏览器 tab / 后台 job / 临时进程后忘记关」的问题。**不依赖模型自觉**：资源打开即自动登记租约（归属会话 + TTL），回收由机制执行。

## 三层防线

1. **自动登记**（tools/result 观察钩子，零提示词依赖）
   - browser_tab_new → browser-tab 租约（tabId + 归属会话 + TTL，默认 240min）
   - bash/subagent/workflow 带 run_in_background → job 租约（jobId，默认 360min）
   - 其他资源（run_code 里起的服务器等）→ lease_register 工具手动登记
2. **自动回收**（三个触发点互为冗余）
   - session/disposed → 关闭该会话全部 session 级租约（正常路径）
   - daemon 每 60s 扫 TTL 过期租约（会话挂死兜底）
   - 启动 10s 后扫过期账（宿主重启兜底；注册表持久化于 ~/.dsh/resource-lease/leases.json）
   - 浏览器空闲 10min 且**实查 0 残留 tab** 才 browser_close（共享实例安全闸：有未登记 tab 绝不误关）
3. **分类策略**
   - session（默认）：随会话/TTL 自动回收
   - pinned：用户说「这个留着」→ lease_pin 升级，永不自动回收
   - system：白名单（cron/watchdog 服务、外部 Chrome 本来就不登记，天然豁免）

## 工具面（agent）

| 工具 | 用途 |
|------|------|
| lease_list | 列租约（默认当前会话活跃；all=true 全部） |
| lease_register | 手动登记（kind=process/port/custom；process/port 需 pid） |
| lease_pin | pinned 升级/降级 |
| lease_release | 立即关闭（force=true 连 pinned 也关） |
| lease_sweep | 立即扫一轮（给 sessionId 则清该会话） |

## 面板（conversation.view slot「资源租约」）

活跃租约表 + 单个关闭/固定 + 清扫过期，10s 自动刷新。宿主 API：/resource-lease/api/{leases,release,pin,sweep}。

## 回收执行路径（实测）

- browser tab → ctx.tools.execute('browser_tab_close')（无 agent 上下文可用，PTC 不拦）
- job → ctx.jobs.kill(jobId, sessionId, reason) 直连服务（job_kill 工具是 agent 作用域注册，全局视图不可见——v1 实测踩坑）
- process/port → process.kill(pid, SIGTERM)
- 「资源已不存在」（not found/ESRCH/already-finished）视为关闭成功；'unknown tool' 不算——连续失败 3 次标 failed 停止重试，面板可见待人工处理

## 构建（离线，无需 npm install）

- host：bash scripts/build.sh（DSH_CHECKOUT 自动探测 ~/dsh-harness）
- client：bash scripts/build-client.sh（tsc CJS + 手工 __ModuleLoader__ 包装，替代 tsdown）
- 一键：dev_build_plugin → dev_inject_plugin / dev_reload_package 热重载

## 配置（cordis.patch.yml 可覆盖）

sweepIntervalMs(60s) tabTtlMinutes(240) jobTtlMinutes(360) autoCloseBrowser(true) browserIdleCloseMs(10min) keepClosedHours(72)
