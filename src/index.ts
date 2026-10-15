/**
 * dsh-resource-lease — 资源租约治理插件（hybrid）。
 *
 * 解决的问题：agent 打开浏览器 tab / 后台 job / 临时进程后忘记关闭。
 * 机制（不依赖模型自觉）：
 *  1. 自动登记：tools/result 观察钩子——browser_tab_new / run_in_background
 *     的 job 一落地就写入租约（归属会话 + TTL），零提示词依赖；
 *  2. 自动回收：session/disposed 事件关闭该会话全部 session 级租约；
 *     daemon 定时扫 TTL 过期租约；浏览器空闲超时自动 browser_close；
 *  3. 分类策略：pinned（用户说留下）/ system（白名单）永不自动回收；
 *     未登记资源（cron/watchdog 服务、外部 Chrome）天然不在治理范围。
 * 注册表持久化到 ~/.dsh/resource-lease/leases.json，宿主重启不丢账。
 *
 * @module dsh-resource-lease
 */
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import z from 'schemastery'
import { LeaseRegistry, newLeaseId } from './registry.js'
import type { Lease, LeaseKind, LeasePolicy } from './registry.js'

type AppContext = Context & {
  tools: any
  jobs: any
  webServer: any
  setInterval(fn: () => void, ms: number): any
  logger?: { info?: (msg: string) => void }
}

export const name = 'dsh-resource-lease'
export const inject = ['tools', 'jobs', 'timer', 'webServer']

export interface Config {
  registryFile: string
  sweepIntervalMs: number
  tabTtlMinutes: number
  jobTtlMinutes: number
  autoCloseBrowser: boolean
  browserIdleCloseMs: number
  keepClosedHours: number
  logFile: string
}

export const Config = z.object({
  registryFile: z.string().default(''),
  sweepIntervalMs: z.number().min(5000).default(60000),
  tabTtlMinutes: z.number().min(1).default(240),
  jobTtlMinutes: z.number().min(1).default(360),
  autoCloseBrowser: z.boolean().default(true),
  browserIdleCloseMs: z.number().min(60000).default(600000),
  keepClosedHours: z.number().min(1).default(72),
  logFile: z.string().default(''),
})

const API = '/resource-lease/api'

export function apply(ctx: AppContext, config: Config): void {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const registryFile = config.registryFile || join(dshHome, 'resource-lease', 'leases.json')
  const logFile = config.logFile || join(dshHome, 'resource-lease', 'lease.log')
  const registry = new LeaseRegistry(registryFile)

  let lastBrowserActivity = 0
  let browserEverActive = false
  let sweepSeq = 0

  const log = (msg: string): void => {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, '[' + new Date().toISOString() + '] ' + msg + '\n')
    } catch { /* 日志失败静默 */ }
  }

  // ═══ 程序化调用工具（回收执行器）═══
  // 首选 ctx.tools.execute（走完整策略管线）；被 PTC 收敛拒绝时降级为
  // 直接调用工具体（治理回收是宿主内部动作，可绕过模型侧策略）。
  async function execTool(toolName: string, args: Record<string, unknown>): Promise<{ ok: boolean; note: string; value?: any }> {
    const callId = 'lease-sweep-' + Date.now().toString(36) + '-' + (++sweepSeq)
    try {
      const res: any = await ctx.tools.execute({ callId, name: toolName, arguments: args, signal: AbortSignal.timeout(20000) })
      if (res && res.isError === true) {
        const text = String(res?.content?.[0]?.text ?? JSON.stringify(res?.content ?? 'error')).slice(0, 200)
        return { ok: false, note: text }
      }
      return { ok: true, note: 'ok', value: res?.value }
    } catch (e) {
      try {
        const def: any = ctx.tools.get(toolName)
        if (!def || typeof def.execute !== 'function') return { ok: false, note: 'tool unavailable: ' + String(e).slice(0, 120) }
        const value = await def.execute(args, { callId, name: toolName, arguments: args, rootCallId: callId, token: Symbol('lease'), signal: AbortSignal.timeout(20000) })
        return { ok: true, note: 'ok (direct)', value }
      } catch (e2) {
        return { ok: false, note: String(e2).slice(0, 200) }
      }
    }
  }

  // 「资源已不存在」特征——视为关闭成功。注意不含 unknown：'unknown tool' 是
  // 工具面问题（作用域注册不可见），必须走失败路径而不是误标已关。
  const GONE = /not found|no tab|already|ESRCH|no such|not running|already-finished/i

  async function closeLease(l: Lease, trigger: string, force: boolean): Promise<boolean> {
    if (!force && l.policy !== 'session') return false
    let res: { ok: boolean; note: string }
    switch (l.kind) {
      case 'browser-tab':
        res = await execTool('browser_tab_close', { id: l.handle.tabId })
        break
      case 'job': {
        // job_kill 工具是 agent 作用域注册（全局视图不可见），首选 jobs 服务直连；
        // 服务不可用时降级工具调用。kill 的 caller 传归属会话，通过所有权校验。
        const jobId = String(l.handle.jobId ?? '')
        try {
          const outcome = ctx.jobs?.kill?.(jobId, l.sessionId || undefined, 'resource-lease ' + trigger)
          res = { ok: true, note: 'jobs.kill: ' + String(outcome) }
        } catch (e) {
          if (String(e).includes('unknown job') || String(e).includes('not found')) {
            res = { ok: true, note: 'job already gone' }
          } else {
            res = await execTool('job_kill', { job_id: jobId, reason: 'resource-lease ' + trigger })
          }
        }
        break
      }
      case 'process':
      case 'port': {
        const pid = Number(l.handle.pid)
        if (!Number.isFinite(pid) || pid <= 0) { res = { ok: false, note: 'no pid in handle' }; break }
        try {
          process.kill(pid, 'SIGTERM')
          res = { ok: true, note: 'SIGTERM ' + pid }
        } catch (e) {
          res = { ok: String(e).includes('ESRCH'), note: String(e).slice(0, 120) }
        }
        break
      }
      default:
        res = { ok: false, note: 'custom lease：无自动关闭动作，请人工处理' }
    }
    if (res.ok || GONE.test(res.note)) {
      registry.markClosed(l.id, res.note, trigger)
      log('closed ' + l.kind + ' ' + l.handleKey + ' session=' + l.sessionId.slice(0, 12) + ' trigger=' + trigger + ' note=' + res.note)
      return true
    }
    const dead = registry.markFail(l.id, res.note)
    log('close FAILED ' + l.kind + ' ' + l.handleKey + ' trigger=' + trigger + (dead ? ' (marked failed)' : '') + ' note=' + res.note)
    return false
  }

  // ═══ 回收触发点 1：会话销毁 ═══
  async function sweepSession(sessionId: string, trigger: string): Promise<number> {
    const targets = registry.active().filter((l) => l.sessionId === sessionId && l.policy === 'session')
    let n = 0
    for (const l of targets) { if (await closeLease(l, trigger, false)) n += 1 }
    if (n > 0) log('sweepSession ' + sessionId.slice(0, 12) + ' closed=' + n + ' trigger=' + trigger)
    return n
  }

  ctx.effect(() => ctx.on('session/disposed', ((session: any) => {
    const sid = String(session?.id ?? '')
    if (sid) void sweepSession(sid, 'session-disposed').catch((e) => log('sweepSession error: ' + String(e)))
  }) as never), name + ': session-disposed hook')

  // ═══ 自动登记：tools/result 观察钩子 ═══
  function registerAuto(kind: LeaseKind, handle: Record<string, unknown>, handleKey: string, sessionId: string, label: string, ttlMs: number): void {
    if (registry.findActiveByHandle(handleKey)) return
    const now = Date.now()
    registry.add({
      id: newLeaseId(), kind, handle, handleKey, sessionId,
      label: label.slice(0, 160), policy: 'session', source: 'auto',
      status: 'active', createdAt: now, expiresAt: ttlMs > 0 ? now + ttlMs : 0,
      closedAt: null, closeNote: '', closeTrigger: '', failCount: 0,
    })
    log('registered ' + kind + ' ' + handleKey + ' session=' + sessionId.slice(0, 12) + ' label=' + label.slice(0, 60))
  }

  function observe(exec: any, result: any): void {
    const toolName = String(exec?.name ?? '')
    const args: any = exec?.arguments ?? {}
    const value: any = result && result.isError !== true ? result.value : undefined
    const sessionId = String(exec?.agent?.session?.id ?? '')

    if (toolName.startsWith('browser_')) {
      browserEverActive = true
      lastBrowserActivity = Date.now()
      if (toolName === 'browser_close') {
        browserEverActive = false
        for (const l of registry.active()) {
          if (l.kind === 'browser-tab') registry.markClosed(l.id, 'browser closed', 'browser_close')
        }
      }
      if (toolName === 'browser_tab_close' && args.id !== undefined && args.id !== null) {
        const l = registry.findActiveByHandle('tab:' + args.id)
        if (l) registry.markClosed(l.id, 'closed by agent', 'agent-tab-close')
      }
    }
    if (toolName === 'job_kill' && args.job_id) {
      const l = registry.findActiveByHandle('job:' + args.job_id)
      if (l) registry.markClosed(l.id, 'killed by agent', 'agent-job-kill')
    }
    if (!sessionId || !value) return

    if (toolName === 'browser_tab_new' && typeof value.tabId === 'number') {
      registerAuto('browser-tab', { tabId: value.tabId }, 'tab:' + value.tabId, sessionId,
        String(args.url ?? value.url ?? value.title ?? 'tab ' + value.tabId), config.tabTtlMinutes * 60000)
    }
    const isBg = args.run_in_background === true
    if (isBg && value.kind === 'background' && value.jobId) {
      const label = String(args.description ?? args.command ?? args.prompt ?? toolName).slice(0, 120)
      registerAuto('job', { jobId: value.jobId }, 'job:' + value.jobId, sessionId, label, config.jobTtlMinutes * 60000)
    }
  }

  ctx.effect(() => ctx.on('tools/result', ((exec: any, result: any) => {
    try { observe(exec, result) } catch (e) { log('observe error: ' + String(e)) }
  }) as never), name + ': tools/result observer')

  // ═══ 回收触发点 2+3：TTL 扫描 / 浏览器空闲关闭 / 历史清理（daemon loop）═══
  async function sweepExpired(trigger: string): Promise<number> {
    const now = Date.now()
    let n = 0
    for (const l of registry.active()) {
      if (l.policy === 'session' && l.expiresAt > 0 && l.expiresAt <= now) {
        if (await closeLease(l, trigger, false)) n += 1
      }
    }
    return n
  }

  async function idleBrowserCheck(): Promise<void> {
    if (!config.autoCloseBrowser || !browserEverActive) return
    const hasTabs = registry.active().some((l) => l.kind === 'browser-tab')
    if (hasTabs) return
    if (Date.now() - lastBrowserActivity < config.browserIdleCloseMs) return
    // 安全闸：浏览器是共享实例，可能存在未登记租约的 tab（插件注入前打开的、
    // 或他方直接操作留下的展示页）。实查 tab 数 > 0 就跳过本轮，绝不误关。
    const tl = await execTool('browser_tab_list', {})
    const remaining = Array.isArray(tl.value?.tabs) ? tl.value.tabs.length : -1
    if (remaining !== 0) {
      if (Date.now() - lastBrowserActivity > config.browserIdleCloseMs + 3600000) {
        // 超过 1h 仍有残留 tab：只记日志提示人工处理，不自动关
        log('idle-close skipped: ' + remaining + ' 个未登记 tab 仍在（>1h），需人工确认')
      }
      return
    }
    const res = await execTool('browser_close', {})
    browserEverActive = false
    log('idle browser_close (' + Math.round(config.browserIdleCloseMs / 60000) + 'min 无活动, 0 残留 tab): ' + res.note)
  }

  ctx.setInterval(() => {
    void (async () => {
      const expired = await sweepExpired('ttl-expired')
      await idleBrowserCheck()
      registry.pruneClosed(config.keepClosedHours * 3600000)
      if (expired > 0) registry.saveNow()
    })().catch((e) => log('sweep loop error: ' + String(e)))
  }, config.sweepIntervalMs)

  // 启动延迟扫一次过期账（宿主重启后兜底；等工具面就绪）
  ctx.effect(() => {
    const t = setTimeout(() => { void sweepExpired('startup').catch(() => {}) }, 10000)
    return () => clearTimeout(t)
  }, name + ': startup sweep')

  // ═══ 工具面（agent 显式操作租约）═══
  const strOutput = { schema: { type: 'string' as const }, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: String(v) }] }

  function fmt(l: Lease): Record<string, unknown> {
    return {
      id: l.id, kind: l.kind, handle: l.handle, label: l.label,
      session: l.sessionId.slice(0, 12), policy: l.policy, status: l.status, source: l.source,
      createdAt: new Date(l.createdAt).toISOString(),
      expiresAt: l.expiresAt > 0 ? new Date(l.expiresAt).toISOString() : null,
      closeNote: l.closeNote || undefined, failCount: l.failCount || undefined,
    }
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'lease_list',
    description: '列出资源租约（浏览器tab/后台job/进程/端口）。默认当前会话的活跃租约；all=true 列全部活跃+最近终态。治理机制会自动登记 browser tab 与后台 job，并在会话结束/TTL 到期时自动回收。',
    parameters: { all: { type: 'boolean', description: '列出所有会话的租约（默认只看当前会话）' } },
    output: strOutput,
    async execute(rawArgs: unknown, exec: any) {
      const args: any = rawArgs ?? {}
      const sid = String(exec?.agent?.session?.id ?? '')
      let items = args.all === true ? registry.list() : registry.list().filter((l) => l.sessionId === sid)
      if (!args.all) items = items.filter((l) => l.status === 'active')
      items = items.slice(-200)
      return JSON.stringify({ count: items.length, leases: items.map(fmt) }, null, 1)
    },
  })), name + ': lease_list tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'lease_register',
    description: '手动登记一条资源租约（用于 run_code 里起的临时服务器/进程等自动观察覆盖不到的资源）。登记后受同一治理：会话结束/TTL 到期自动回收，lease_pin 可豁免。',
    parameters: {
      kind: { type: 'string', description: 'process | port | custom' },
      pid: { type: 'number', description: '进程 PID（process/port 类必填，回收时 SIGTERM）' },
      port: { type: 'number', description: '端口号（port 类）' },
      label: { type: 'string', description: '人类可读说明' },
      ttlMinutes: { type: 'number', description: 'TTL 分钟数，缺省 240；0 = 不过期（仍随会话回收）' },
    },
    output: strOutput,
    async execute(rawArgs: unknown, exec: any) {
      const args: any = rawArgs ?? {}
      const kind = String(args.kind ?? 'custom') as LeaseKind
      const sid = String(exec?.agent?.session?.id ?? 'unknown')
      const handle: Record<string, unknown> = {}
      if (args.pid !== undefined) handle.pid = args.pid
      if (args.port !== undefined) handle.port = args.port
      const handleKey = kind + ':' + String(args.pid ?? args.port ?? JSON.stringify(handle) ?? Date.now())
      if (registry.findActiveByHandle(handleKey)) return JSON.stringify({ ok: false, error: '已有活跃租约: ' + handleKey })
      const ttl = args.ttlMinutes === undefined ? config.tabTtlMinutes : Number(args.ttlMinutes)
      const now = Date.now()
      const id = newLeaseId()
      registry.add({
        id, kind, handle, handleKey, sessionId: sid,
        label: String(args.label ?? kind).slice(0, 160), policy: 'session', source: 'manual',
        status: 'active', createdAt: now, expiresAt: ttl > 0 ? now + ttl * 60000 : 0,
        closedAt: null, closeNote: '', closeTrigger: '', failCount: 0,
      })
      log('manual register ' + handleKey + ' session=' + sid.slice(0, 12))
      return JSON.stringify({ ok: true, id, handleKey, expiresAt: ttl > 0 ? new Date(now + ttl * 60000).toISOString() : null })
    },
  })), name + ': lease_register tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'lease_pin',
    description: '把租约升级为 pinned（永不自动回收，用户明确说「这个留着」时用）或降回 session（恢复自动回收）。',
    parameters: {
      leaseId: { type: 'string', description: '租约 id' },
      pinned: { type: 'boolean', description: 'true=固定不回收（默认），false=恢复 session 级自动回收' },
    },
    output: strOutput,
    async execute(rawArgs: unknown) {
      const args: any = rawArgs ?? {}
      const pinned = args.pinned !== false
      const ok = registry.setPolicy(String(args.leaseId), pinned ? 'pinned' : 'session')
      return JSON.stringify({ ok, leaseId: args.leaseId, policy: pinned ? 'pinned' : 'session' })
    },
  })), name + ': lease_pin tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'lease_release',
    description: '立即关闭一个租约对应的资源（tab/job/进程）。force=true 时连 pinned 也关。',
    parameters: {
      leaseId: { type: 'string', description: '租约 id' },
      force: { type: 'boolean', description: '强制关闭 pinned 租约' },
    },
    output: strOutput,
    async execute(rawArgs: unknown) {
      const args: any = rawArgs ?? {}
      const l = registry.get(String(args.leaseId))
      if (!l) return JSON.stringify({ ok: false, error: '租约不存在: ' + args.leaseId })
      if (l.status !== 'active') return JSON.stringify({ ok: true, note: '已是终态 ' + l.status })
      const closed = await closeLease(l, 'manual-release', args.force === true)
      return JSON.stringify({ ok: closed, leaseId: l.id, kind: l.kind, note: l.closeNote })
    },
  })), name + ': lease_release tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'lease_sweep',
    description: '立即执行一轮回收扫描：默认扫 TTL 过期租约；给 sessionId 则回收该会话全部 session 级租约（会话已死但 dispose 事件丢失时用）。',
    parameters: { sessionId: { type: 'string', description: '目标会话 id（缺省=扫过期）' } },
    output: strOutput,
    async execute(rawArgs: unknown) {
      const args: any = rawArgs ?? {}
      const n = args.sessionId ? await sweepSession(String(args.sessionId), 'manual-sweep') : await sweepExpired('manual-sweep')
      registry.saveNow()
      return JSON.stringify({ ok: true, closed: n })
    },
  })), name + ': lease_sweep tool')

  // ═══ 面板 HTTP API（client 半边消费）═══
  function writeJson(res: any, code: number, body: unknown): void {
    try {
      const text = JSON.stringify(body)
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) })
      res.end(text)
    } catch { try { res.end() } catch { /* noop */ } }
  }

  function readBody(req: any): Promise<any> {
    return new Promise((resolve) => {
      let data = ''
      req.on('data', (c: any) => { data += c; if (data.length > 64 * 1024) req.destroy() })
      req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch { resolve({}) } })
      req.on('error', () => resolve({}))
    })
  }

  ctx.effect(() => {
    const ws: any = ctx.webServer
    if (!ws || typeof ws.register !== 'function') return () => {}
    const disposers: Array<() => void> = []
    disposers.push(ws.register({
      kind: 'exact', path: API + '/leases',
      handler: (_req: any, res: any) => {
        writeJson(res, 200, {
          ok: true,
          state: { browserEverActive, lastBrowserActivity, autoCloseBrowser: config.autoCloseBrowser, browserIdleCloseMs: config.browserIdleCloseMs },
          leases: registry.list().slice(-300).map(fmt),
        })
      },
    }))
    disposers.push(ws.register({
      kind: 'exact', path: API + '/release',
      handler: (req: any, res: any) => { void (async () => {
        const body = await readBody(req)
        const l = registry.get(String(body?.id ?? ''))
        if (!l) { writeJson(res, 404, { ok: false, error: 'lease not found' }); return }
        const closed = await closeLease(l, 'panel-release', true)
        writeJson(res, 200, { ok: closed, note: l.closeNote })
      })() },
    }))
    disposers.push(ws.register({
      kind: 'exact', path: API + '/pin',
      handler: (req: any, res: any) => { void (async () => {
        const body = await readBody(req)
        const pinned = body?.pinned !== false
        const ok = registry.setPolicy(String(body?.id ?? ''), pinned ? 'pinned' : 'session')
        writeJson(res, 200, { ok, policy: pinned ? 'pinned' : 'session' })
      })() },
    }))
    disposers.push(ws.register({
      kind: 'exact', path: API + '/sweep',
      handler: (_req: any, res: any) => { void (async () => {
        const n = await sweepExpired('panel-sweep')
        registry.saveNow()
        writeJson(res, 200, { ok: true, closed: n })
      })() },
    }))
    return () => { for (const d of disposers) { try { d() } catch { /* noop */ } } }
  }, name + ': panel routes')

  ctx.effect(() => () => { registry.saveNow() }, name + ': flush registry on dispose')

  ctx.logger?.info?.('[' + name + '] 资源租约治理已启动（registry=' + registryFile + '，扫描间隔 ' + config.sweepIntervalMs + 'ms）')
  log('plugin started; active leases on boot: ' + registry.active().length)
}
