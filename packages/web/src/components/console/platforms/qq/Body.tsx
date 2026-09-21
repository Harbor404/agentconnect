import { useRef, useState } from 'react'
import type { Agent } from '@/lib/data'
import type { WizardHost } from '../contract'
import { usePublishedFooter } from '../publish'

export function QQWizardBody({ agent, host }: { agent: Agent; host: WizardHost }) {
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const busy = useRef(false)
  const valid = /^\d+$/.test(appId.trim()) && !!appSecret.trim()
  async function submit() {
    if (!valid || busy.current) return
    busy.current = true
    setSaving(true)
    host.setError(null)
    try {
      await host.createIntegration({
        platform: 'qq',
        agentId: agent.id,
        qq: { appId: appId.trim(), appSecret: appSecret.trim() }
      })
      host.close()
    } catch (error) {
      host.setError(error instanceof Error ? error.message : String(error))
      busy.current = false
      setSaving(false)
    }
  }
  usePublishedFooter(host, {
    label: saving ? 'Checking credentials…' : 'Connect',
    enabled: valid && !saving,
    onSubmit: () => void submit()
  })
  if (host.mode !== 'create') return null
  return (
    <div className="flex flex-col gap-4">
      <p className="psub">
        Connect an official QQ bot for private conversations and group @mentions, with Markdown replies and PNG, JPEG or
        WEBP images. Private replies stream; groups receive limited progress updates and complete answers. Other file
        types are not supported yet.
      </p>
      <a href="https://q.qq.com/" target="_blank" rel="noreferrer" className="text-(--brand)">
        Open QQ bot developer portal
      </a>
      <label className="flex flex-col gap-2">
        AppID
        <input
          className="inp"
          value={appId}
          onChange={(event) => setAppId(event.target.value)}
          inputMode="numeric"
          autoComplete="off"
          disabled={saving}
        />
      </label>
      <label className="flex flex-col gap-2">
        AppSecret
        <input
          className="inp"
          type="password"
          value={appSecret}
          onChange={(event) => setAppSecret(event.target.value)}
          autoComplete="new-password"
          disabled={saving}
        />
      </label>
      <p className="psub">
        Enable private and group messaging in the QQ bot developer portal. For an unpublished bot, configure your test
        account and test group there. After connecting, send a private message or @mention the bot in a group to verify
        delivery. Members share the group's bot conversation; ordinary group discussion is not included.
      </p>
    </div>
  )
}
