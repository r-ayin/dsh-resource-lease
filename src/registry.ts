/**
 * dsh-resource-lease — 持久化租约注册表。
 *
 * 一条租约 = 一个被会话打开的资源（浏览器 tab / 后台 job / 进程 / 端口 / 自定义），
 * 记录归属会话、TTL、回收策略与状态。JSON 文件落盘（防宿主崩溃丢账），
 * 原子写（tmp + rename），变更后防抖保存。
 *
 * @module dsh-resource-lease/registry
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

export type LeaseKind = 'browser-tab' | 'job' | 'process' | 'port' | 'custom'
export type LeasePolicy = 'session' | 'pinned' | 'system'
export type LeaseStatus = 'active' | 'closed' | 'failed'

export interface Lease {
  id: string
  kind: LeaseKind
  /** 关闭资源所需的句柄字段（tabId / jobId / pid / port …）。 */
  handle: Record<string, unknown>
  /** 去重键：kind + 主句柄字段。 */
  handleKey: string
  sessionId: string
  label: string
  /** session=随会话/TTL 自动回收；pinned=用户留下；system=白名单永不回收。 */
  policy: LeasePolicy
  source: 'auto' | 'manual'
  status: LeaseStatus
  createdAt: number
  /** 0 = 不过期。 */
  expiresAt: number
  closedAt: number | null
  closeNote: string
  closeTrigger: string
  failCount: number
}

export function newLeaseId(): string {
  return 'lease-' + Date.now().toString(36) + '-' + randomBytes(3).toString('hex')
}

/** 连续关闭失败达到该次数后标记 failed，不再重试（面板可见，人工处理）。 */
const MAX_FAIL = 3

export class LeaseRegistry {
  private leases = new Map<string, Lease>()
  private byHandle = new Map<string, string>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private file: string) {
    this.load()
  }

  load(): void {
    try {
      if (!existsSync(this.file)) return
      const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      const arr: Lease[] = Array.isArray(raw) ? raw as Lease[] : ((raw as { leases?: Lease[] })?.leases ?? [])
      for (const l of arr) {
        if (!l || typeof l.id !== 'string') continue
        this.leases.set(l.id, l)
        if (l.status === 'active') this.byHandle.set(l.handleKey, l.id)
      }
    } catch {
      /* 损坏文件：从空开始（旧文件保留在磁盘供人工检查，下次保存覆盖） */
    }
  }

  /** 防抖落盘：300ms 内的连续变更合并为一次写。 */
  private persist(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.saveNow()
    }, 300)
  }

  saveNow(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify({ version: 1, leases: [...this.leases.values()] }, null, 1))
      renameSync(tmp, this.file)
    } catch {
      /* 静默：下次变更再试 */
    }
  }

  add(l: Lease): void {
    this.leases.set(l.id, l)
    if (l.status === 'active') this.byHandle.set(l.handleKey, l.id)
    this.persist()
  }

  get(id: string): Lease | undefined {
    return this.leases.get(id)
  }

  findActiveByHandle(handleKey: string): Lease | undefined {
    const id = this.byHandle.get(handleKey)
    const l = id !== undefined ? this.leases.get(id) : undefined
    return l !== undefined && l.status === 'active' ? l : undefined
  }

  list(): Lease[] {
    return [...this.leases.values()]
  }

  active(): Lease[] {
    return this.list().filter((l) => l.status === 'active')
  }

  markClosed(id: string, note: string, trigger: string): void {
    const l = this.leases.get(id)
    if (l === undefined) return
    l.status = 'closed'
    l.closedAt = Date.now()
    l.closeNote = note.slice(0, 300)
    l.closeTrigger = trigger
    if (this.byHandle.get(l.handleKey) === id) this.byHandle.delete(l.handleKey)
    this.persist()
  }

  /** 关闭失败计数；连续 MAX_FAIL 次后转 failed 停止重试。返回是否已转 failed。 */
  markFail(id: string, note: string): boolean {
    const l = this.leases.get(id)
    if (l === undefined) return false
    l.failCount += 1
    l.closeNote = note.slice(0, 300)
    if (l.failCount >= MAX_FAIL) {
      l.status = 'failed'
      l.closedAt = Date.now()
      if (this.byHandle.get(l.handleKey) === id) this.byHandle.delete(l.handleKey)
    }
    this.persist()
    return l.status === 'failed'
  }

  setPolicy(id: string, policy: LeasePolicy): boolean {
    const l = this.leases.get(id)
    if (l === undefined) return false
    l.policy = policy
    this.persist()
    return true
  }

  /** 清理终态历史（closed/failed 且超过保留期），控制账本体积。 */
  pruneClosed(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs
    let n = 0
    for (const [id, l] of this.leases) {
      if (l.status !== 'active' && (l.closedAt ?? 0) > 0 && (l.closedAt ?? 0) < cutoff) {
        this.leases.delete(id)
        if (this.byHandle.get(l.handleKey) === id) this.byHandle.delete(l.handleKey)
        n += 1
      }
    }
    if (n > 0) this.persist()
    return n
  }
}
