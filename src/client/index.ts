/**
 * dsh-resource-lease — client 面板（conversation.view slot，React 风格）。
 * 租约看板：活跃资源列表 + 单个关闭 / 固定(pin) / 一键清扫过期，10s 自动刷新。
 * 数据来自宿主路由 /resource-lease/api/*。
 * 编译约定：react/slots 均为 shorthand ambient module（any）——本文件不使用
 * 它们的类型空间（无 React.CSSProperties / SlotsService 引用），回调参数显式标注。
 * 注意：super-injector 预检正则要求 register({ 与 name 紧邻，勿重排。
 */
import * as React from 'react'

type SlotsService = {
  inject(slot: string, fn: () => unknown): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

type ClientContext = {
  slots: SlotsService
  effect(fn: () => (() => void) | void, tag?: string): void
}

export const inject = ['slots']

const API = '/resource-lease/api'

interface LeaseView {
  id: string
  kind: string
  handle: Record<string, unknown>
  label: string
  session: string
  policy: string
  status: string
  source: string
  createdAt: string
  expiresAt: string | null
  closeNote?: string
  failCount?: number
}

interface PanelState {
  browserEverActive: boolean
  lastBrowserActivity: number
  autoCloseBrowser: boolean
  browserIdleCloseMs: number
}

interface PanelData {
  ok: boolean
  error?: string
  leases?: LeaseView[]
  state?: PanelState
}

const S = {
  root: { padding: 12, fontFamily: 'system-ui, -apple-system, "PingFang SC", sans-serif', fontSize: 12.5, lineHeight: 1.6, color: 'inherit' },
  title: { fontSize: 14, fontWeight: 700, marginBottom: 4, display: 'flex', gap: 8, alignItems: 'center' },
  summary: { opacity: 0.75, marginBottom: 8 },
  table: { borderCollapse: 'collapse', width: '100%' },
  th: { textAlign: 'left', padding: '2px 6px', borderBottom: '1px solid rgba(128,128,128,.4)', whiteSpace: 'nowrap' },
  td: { padding: '2px 6px', borderBottom: '1px solid rgba(128,128,128,.15)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  button: { fontSize: 11, marginRight: 4, cursor: 'pointer', borderRadius: 4, border: '1px solid rgba(128,128,128,.4)', background: 'transparent', color: 'inherit', padding: '0 6px' },
  err: { color: '#d44', padding: 8 },
  section: { fontWeight: 700, margin: '10px 0 4px', opacity: 0.8 },
}

function post(path: string, body: unknown): Promise<any> {
  return fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }))
}

function LeasePanel(): any {
  const [data, setData] = React.useState(null) as [PanelData | null, (v: PanelData | null) => void]
  const [err, setErr] = React.useState('') as [string, (v: string) => void]

  const refresh = React.useCallback(() => {
    fetch(API + '/leases').then((r) => r.json()).then((d: PanelData) => { setData(d); setErr('') })
      .catch((e: unknown) => setErr(String(e)))
  }, [])

  React.useEffect(() => {
    refresh()
    const t = setInterval(refresh, 10000)
    return () => clearInterval(t)
  }, [refresh])

  if (err) return React.createElement('div', { style: S.err }, '租约数据获取失败：' + err)
  if (!data || !data.ok) return React.createElement('div', { style: S.root }, '正在加载租约数据…')

  const leases: LeaseView[] = data.leases ?? []
  const active = leases.filter((l: LeaseView) => l.status === 'active')
  const done = leases.filter((l: LeaseView) => l.status !== 'active').slice(-10).reverse()
  const st = data.state
  const idleInfo = st && st.browserEverActive
    ? '浏览器: 在用，空闲 ' + Math.round((Date.now() - st.lastBrowserActivity) / 60000) + 'min'
      + (st.autoCloseBrowser ? '（空闲 ' + Math.round(st.browserIdleCloseMs / 60000) + 'min 自动关）' : '（自动关: 关）')
    : '浏览器: 未启动'

  const row = (l: LeaseView): any => React.createElement('tr', { key: l.id },
    React.createElement('td', { style: S.td }, l.kind),
    React.createElement('td', { style: S.td, title: l.label }, (l.label || JSON.stringify(l.handle)).slice(0, 60)),
    React.createElement('td', { style: S.td }, l.session),
    React.createElement('td', { style: S.td }, l.policy + (l.source === 'auto' ? '/auto' : '/manual')),
    React.createElement('td', { style: S.td }, l.expiresAt ? l.expiresAt.slice(5, 16).replace('T', ' ') : '—'),
    React.createElement('td', { style: S.td }, l.status === 'active' ? '活跃' : l.status + (l.closeNote ? ': ' + l.closeNote.slice(0, 30) : '')),
    React.createElement('td', { style: S.td },
      l.status === 'active'
        ? [
          React.createElement('button', {
            key: 'c', style: S.button,
            onClick: () => { void post('/release', { id: l.id }).then(() => refresh()) },
          }, '关闭'),
          React.createElement('button', {
            key: 'p', style: S.button,
            onClick: () => { void post('/pin', { id: l.id, pinned: l.policy !== 'pinned' }).then(() => refresh()) },
          }, l.policy === 'pinned' ? '取消固定' : '固定'),
        ]
        : null))

  const header = React.createElement('tr', { key: 'h' },
    ...['类型', '资源', '会话', '策略', '到期', '状态', '操作'].map((h: string) => React.createElement('th', { key: h, style: S.th }, h)))

  return React.createElement('div', { style: S.root },
    React.createElement('div', { style: S.title }, '资源租约看板',
      React.createElement('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } },
        React.createElement('button', { style: S.button, onClick: () => { void post('/sweep', {}).then(() => refresh()) } }, '清扫过期'),
        React.createElement('button', { style: S.button, onClick: () => refresh() }, '刷新'))),
    React.createElement('div', { style: S.summary }, '活跃 ' + active.length + ' 条 | ' + idleInfo),
    active.length > 0
      ? React.createElement('table', { style: S.table }, header, active.map(row))
      : React.createElement('div', { style: S.summary }, '（无活跃租约）'),
    done.length > 0
      ? React.createElement(React.Fragment, null,
        React.createElement('div', { style: S.section }, '最近回收'),
        React.createElement('table', { style: S.table }, header, done.map(row)))
      : null)
}

export function apply(ctx: ClientContext): void {
  ctx.effect(
    () =>
      ctx.slots.inject('conversation.view', () =>
        ctx.slots.register({
          name: 'conversation.view',
          id: 'dsh-resource-lease-panel',
          label: () => '资源租约',
          order: 91,
        }, LeasePanel),
      ),
    'dsh-resource-lease: panel',
  )
}
