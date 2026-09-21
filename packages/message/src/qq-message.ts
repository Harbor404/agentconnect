import type { NormalizedPlatformMessage, PlatformAttachment } from '@agentconnect.md/protocol'

interface QQUrl {
  protocol: string
  username: string
  password: string
  port: string
  hostname: string
  href: string
}

interface QQUrlConstructor {
  new (input: string): QQUrl
}

export interface QQImageAttachment {
  content_type: string
  url: string
  filename?: string
  size?: number
}

export interface QQMessageEvent {
  rawEventType: string
  kind: string
  senderId: string
  senderName?: string
  senderIsBot?: boolean
  groupOpenid?: string
  content: string
  messageId: string
  attachments?: QQImageAttachment[]
  msgIdx?: string
  refMsgIdx?: string
  msgElements?: { msg_idx?: string; content?: string; attachments?: QQImageAttachment[] }[]
}

export interface QQQuotedMessage {
  messageId?: string
  sender?: string
  content?: string
  attachments?: QQImageAttachment[]
  excerpt?: boolean
}

export function QQImageUrl(value: string): string | undefined {
  try {
    const URLConstructor = (globalThis as typeof globalThis & { URL?: QQUrlConstructor }).URL
    if (!URLConstructor) return undefined
    const url = new URLConstructor(value.startsWith('//') ? `https:${value}` : value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return undefined
    if (
      !['qpic.cn', 'qq.com', 'qq.com.cn'].some(
        (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)
      )
    )
      return undefined
    url.protocol = 'https:'
    return url.href
  } catch {
    return undefined
  }
}

// Admit DMs and explicit group mentions before core routing; ambient messages must never activate through affinity.
export function normalizeQQMessage(
  appId: string,
  message: QQMessageEvent,
  traceId: string,
  reference?: QQQuotedMessage
): NormalizedPlatformMessage | null {
  const isDm = message.rawEventType === 'C2C_MESSAGE_CREATE' && message.kind === 'c2c'
  const isGroup = message.rawEventType === 'GROUP_AT_MESSAGE_CREATE' && message.kind === 'group'
  if (
    (!isDm && !isGroup) ||
    (isGroup && !message.groupOpenid) ||
    message.senderIsBot ||
    !message.senderId ||
    !message.messageId
  )
    return null
  const attachments: PlatformAttachment[] = []
  let unsupported = false
  const element = message.refMsgIdx
    ? (message.msgElements?.find((item) => item.msg_idx === message.refMsgIdx) ?? message.msgElements?.[0])
    : undefined
  const quotedAttachments = element?.attachments ?? reference?.attachments ?? []
  const sources = [
    ...(message.attachments ?? []).map((attachment, index) => ({ attachment, id: `${message.messageId}:${index}` })),
    ...quotedAttachments.map((attachment, index) => ({ attachment, id: `${message.refMsgIdx}:quote:${index}` }))
  ]
  for (const { attachment, id } of sources) {
    const mimeType = attachment.content_type.toLowerCase().split(';')[0]!.trim().replace('image/jpg', 'image/jpeg')
    const sourceUrl = QQImageUrl(attachment.url)
    if (!sourceUrl || !['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) {
      unsupported = true
      continue
    }
    const name = attachment.filename?.replace(/[\\/\x00-\x1f\x7f()]/g, '_').slice(0, 160)
    if (attachments.some((item) => item.sourceUrl === sourceUrl)) continue
    attachments.push({
      id,
      name: name || `image-${attachments.length + 1}.${mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice(6)}`,
      mimeType,
      sourceUrl,
      ...(Number.isFinite(attachment.size) && attachment.size! >= 0 ? { size: attachment.size } : {})
    })
  }
  const text = [
    isGroup
      ? message.content.replace(/<@!?([^>]+)>/g, (marker, id: string) => (id === appId ? '' : marker)).trim()
      : message.content,
    ...(unsupported ? ['[QQ attachment unavailable: only PNG, JPEG and WEBP images are supported.]'] : [])
  ]
    .filter(Boolean)
    .join('\n')
  const quoteText = [
    element?.content ?? reference?.content ?? '',
    ...quotedAttachments.map((item) => `[Attachment: ${item.filename ?? item.content_type}]`)
  ]
    .filter(Boolean)
    .join('\n')
  const replyTo = message.refMsgIdx ? (reference?.messageId ?? `ref:${message.refMsgIdx}`) : undefined
  if (!text.trim() && !attachments.length && !quoteText) return null
  return {
    platform: 'qq',
    source: 'user',
    traceId,
    msgId: isDm
      ? `qq:${appId}:${message.senderId}:${message.messageId}`
      : `qq:${appId}:group:${message.groupOpenid}:${message.messageId}`,
    channel: isDm ? `dm:${message.senderId}` : `group:${message.groupOpenid}`,
    thread: isDm ? 'dm' : 'group',
    sender: { id: message.senderId, isBot: false, ...(message.senderName ? { name: message.senderName } : {}) },
    text,
    ...(attachments.length ? { attachments } : {}),
    mentionedBots: isDm ? [] : [appId],
    isDm,
    ...(replyTo ? { replyTo } : {}),
    ...(replyTo && quoteText
      ? {
          quoted: {
            messageId: replyTo,
            ...(reference?.sender ? { sender: reference.sender } : {}),
            text: quoteText.slice(0, 1000),
            ...(quoteText.length > 1000 || reference?.excerpt ? { excerpt: true } : {})
          }
        }
      : {}),
    adapterExt: { qq: { replyId: message.messageId } }
  }
}
