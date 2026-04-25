import { Heading, Hr, Link, Section, Text } from '@react-email/components'
import { Layout } from './layout.tsx'

export interface DigestItem {
  kind: 'like' | 'repost' | 'reply' | 'mention' | 'follow' | 'dm' | 'article_reply' | 'quote'
  actorDisplay: string
  actorHandle: string | null
  preview?: string | null
  url: string
}

export function DigestEmail({
  appName = 'twotter',
  webUrl,
  recipientName,
  itemsByKind,
  totalCount,
  unsubscribeUrl,
}: {
  appName?: string
  webUrl: string
  recipientName: string
  itemsByKind: Array<{ kind: string; label: string; items: Array<DigestItem> }>
  totalCount: number
  unsubscribeUrl: string
}) {
  return (
    <Layout preview={`${totalCount} new ${totalCount === 1 ? 'notification' : 'notifications'} on ${appName}`} appName={appName}>
      <Section>
        <Heading as="h1" style={{ fontSize: 22 }}>
          {recipientName}, you missed {totalCount}{' '}
          {totalCount === 1 ? 'notification' : 'notifications'}
        </Heading>
        <Text>
          Here's the rollup since you last visited. Open {appName} to reply,
          like, or dive into a thread.
        </Text>
      </Section>
      {itemsByKind.map((group) => (
        <Section key={group.kind}>
          <Heading as="h2" style={{ fontSize: 16, marginTop: 16 }}>
            {group.label} ({group.items.length})
          </Heading>
          {group.items.slice(0, 5).map((item, i) => (
            <Text key={i} style={{ margin: '4px 0' }}>
              <Link href={`${webUrl}${item.url}`}>{item.actorDisplay}</Link>
              {item.actorHandle ? ` @${item.actorHandle}` : ''} · {prettyKind(item.kind)}
              {item.preview ? `: "${item.preview}"` : ''}
            </Text>
          ))}
          {group.items.length > 5 && (
            <Text style={{ color: '#888', margin: '4px 0' }}>
              + {group.items.length - 5} more
            </Text>
          )}
        </Section>
      ))}
      <Hr />
      <Section>
        <Text>
          <Link href={`${webUrl}/notifications`}>Open notifications</Link>
        </Text>
        <Text style={{ color: '#888', fontSize: 12 }}>
          You're receiving this digest because you opted in on {appName}.{' '}
          <Link href={unsubscribeUrl}>Unsubscribe</Link>.
        </Text>
      </Section>
    </Layout>
  )
}

function prettyKind(kind: string): string {
  switch (kind) {
    case 'like':
      return 'liked your post'
    case 'repost':
      return 'reposted your post'
    case 'reply':
      return 'replied'
    case 'mention':
      return 'mentioned you'
    case 'follow':
      return 'followed you'
    case 'dm':
      return 'messaged you'
    case 'article_reply':
      return 'replied to your article'
    case 'quote':
      return 'quoted your post'
    default:
      return kind
  }
}
