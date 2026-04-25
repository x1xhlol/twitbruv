import { schema, eq, and, gt, isNull, isNotNull, desc, sql } from '@workspace/db'
import type { Database } from '@workspace/db'
import type { Mailer, DigestItem } from '@workspace/email'

// Shape the rest of the system writes into profile_private.notification_prefs.
// Everything is optional; default behavior is "no digest".
//
//   {
//     "email": {
//       "digest": "off" | "daily",
//       "kinds": ["like", "repost", "reply", "mention", "follow", "dm",
//                 "article_reply", "quote"],
//       "lastSentAt": "2026-04-25T10:00:00.000Z"
//     }
//   }
//
// We send a digest at most once per 24h per user, and only when there are
// new (unread, since lastSentAt) notifications matching the requested kinds.
interface NotificationPrefs {
  email?: {
    digest?: 'off' | 'daily'
    kinds?: Array<string>
    lastSentAt?: string
  }
}

const DIGEST_MIN_INTERVAL_MS = 22 * 60 * 60 * 1000 // 22h to avoid drifting past 24h windows

interface SendDigestArgs {
  db: Database
  mailer: Mailer
  webUrl: string
  appName: string
}

export async function dispatchDigests(args: SendDigestArgs): Promise<{
  candidates: number
  sent: number
}> {
  const candidates = await args.db
    .select({
      userId: schema.profilePrivate.userId,
      prefs: schema.profilePrivate.notificationPrefs,
      email: schema.users.email,
      handle: schema.users.handle,
      displayName: schema.users.displayName,
    })
    .from(schema.profilePrivate)
    .innerJoin(schema.users, eq(schema.users.id, schema.profilePrivate.userId))
    .where(
      and(
        isNotNull(schema.profilePrivate.notificationPrefs),
        isNull(schema.users.deletedAt),
        // Email must be verified — we never send marketing-style mail to
        // unverified addresses.
        eq(schema.users.emailVerified, true),
      ),
    )
    .limit(500)

  let sent = 0
  for (const row of candidates) {
    const prefs = (row.prefs as NotificationPrefs) ?? {}
    if (prefs.email?.digest !== 'daily') continue
    const lastSentAt = prefs.email.lastSentAt ? new Date(prefs.email.lastSentAt) : null
    if (lastSentAt && Date.now() - lastSentAt.getTime() < DIGEST_MIN_INTERVAL_MS) continue

    // Pull unread notifications since lastSent (or last 24h if none) for the
    // selected kinds. Cap at 200 rows so the email body stays bounded.
    const since = lastSentAt ?? new Date(Date.now() - 24 * 60 * 60 * 1000)
    const kindsFilter = prefs.email.kinds && prefs.email.kinds.length > 0
      ? sql`${schema.notifications.kind} = ANY(${prefs.email.kinds})`
      : undefined

    const rows = await args.db
      .select({
        id: schema.notifications.id,
        kind: schema.notifications.kind,
        actorId: schema.notifications.actorId,
        entityType: schema.notifications.entityType,
        entityId: schema.notifications.entityId,
        createdAt: schema.notifications.createdAt,
        actorHandle: schema.users.handle,
        actorDisplay: schema.users.displayName,
      })
      .from(schema.notifications)
      .leftJoin(schema.users, eq(schema.users.id, schema.notifications.actorId))
      .where(
        and(
          eq(schema.notifications.userId, row.userId),
          gt(schema.notifications.createdAt, since),
          isNull(schema.notifications.readAt),
          kindsFilter,
        ),
      )
      .orderBy(desc(schema.notifications.createdAt))
      .limit(200)

    if (rows.length === 0) continue

    // Group by kind for the email body.
    const groups = new Map<
      string,
      { kind: string; label: string; items: Array<DigestItem> }
    >()
    for (const r of rows) {
      const item: DigestItem = {
        kind: r.kind,
        actorDisplay: r.actorDisplay || (r.actorHandle ? `@${r.actorHandle}` : 'Someone'),
        actorHandle: r.actorHandle,
        preview: null,
        url:
          r.entityType === 'post' && r.entityId && r.actorHandle
            ? `/${r.actorHandle}/p/${r.entityId}`
            : '/notifications',
      }
      const existing = groups.get(r.kind)
      if (existing) existing.items.push(item)
      else groups.set(r.kind, { kind: r.kind, label: labelForKind(r.kind), items: [item] })
    }

    const recipientName = row.displayName || (row.handle ? `@${row.handle}` : 'Hi')
    const unsubscribeUrl = `${args.webUrl}/settings#notifications`

    try {
      await args.mailer.send({
        to: row.email,
        subject: `${rows.length} new ${rows.length === 1 ? 'notification' : 'notifications'} on ${args.appName}`,
        template: 'digest',
        data: {
          webUrl: args.webUrl,
          recipientName,
          itemsByKind: [...groups.values()],
          totalCount: rows.length,
          unsubscribeUrl,
        },
      })
      sent++
    } catch {
      // Don't update lastSentAt if delivery failed; we'll retry next tick.
      continue
    }

    // Mark sent so we don't re-send the same window.
    const nextPrefs: NotificationPrefs = {
      ...prefs,
      email: {
        ...prefs.email,
        lastSentAt: new Date().toISOString(),
      },
    }
    await args.db
      .update(schema.profilePrivate)
      .set({ notificationPrefs: nextPrefs })
      .where(eq(schema.profilePrivate.userId, row.userId))
  }

  return { candidates: candidates.length, sent }
}

function labelForKind(kind: string): string {
  switch (kind) {
    case 'like':
      return 'Likes'
    case 'repost':
      return 'Reposts'
    case 'reply':
      return 'Replies'
    case 'mention':
      return 'Mentions'
    case 'follow':
      return 'New followers'
    case 'dm':
      return 'Direct messages'
    case 'article_reply':
      return 'Article replies'
    case 'quote':
      return 'Quote posts'
    default:
      return kind
  }
}
