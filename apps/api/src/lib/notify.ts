import { schema } from '@workspace/db'
import type { Database } from '@workspace/db'
import type { Cache } from './cache.ts'
import type { Env } from './env.ts'
import { pushDeliver, pushEnabled, type PushPayload } from './push.ts'

export type NotificationKind =
  | 'like'
  | 'repost'
  | 'reply'
  | 'mention'
  | 'follow'
  | 'dm'
  | 'article_reply'
  | 'quote'

export interface NotifyInput {
  userId: string
  actorId: string
  kind: NotificationKind
  entityType?: 'post' | 'article' | 'conversation'
  entityId?: string
}

/**
 * Insert one or more notification rows in a single statement. Callers should invoke this
 * within the same transaction as the causing write so notifications can't get orphaned.
 * Self-notifications (actor == recipient) are dropped before insert. Returns the set of
 * recipient user ids actually inserted; callers can use this to bust any per-user
 * notification caches (unread count, etc.) after the surrounding transaction commits.
 */
export async function notify(tx: any, inputs: Array<NotifyInput>): Promise<Set<string>> {
  const rows = inputs
    .filter((n) => n.actorId !== n.userId)
    .map((n) => ({
      userId: n.userId,
      actorId: n.actorId,
      kind: n.kind,
      entityType: n.entityType ?? null,
      entityId: n.entityId ?? null,
    }))
  if (rows.length === 0) return new Set()
  await tx.insert(schema.notifications).values(rows)
  return new Set(rows.map((r) => r.userId))
}

/** Redis key for the cached unread-notification count. */
export function notificationsUnreadCacheKey(userId: string) {
  return `notif:unread:${userId}:v1`
}

/**
 * Bust the cached unread-count for the given recipients. Call this AFTER the surrounding
 * transaction commits — on rollback we'd otherwise clobber a still-correct cached value.
 * No-op for empty sets.
 */
export async function invalidateUnreadCounts(cache: Cache, userIds: Set<string> | Array<string>) {
  const ids = Array.from(userIds)
  if (ids.length === 0) return
  await cache.del(...ids.map(notificationsUnreadCacheKey))
}

/**
 * Fire-and-forget Web Push delivery for the given recipients. Looks up each
 * user's stored PushSubscriptions, sends the encrypted payload, prunes any
 * subscriptions the push service reports as gone (404/410). No-op when VAPID
 * isn't configured. Failures are swallowed so a flaky push provider never
 * fails the calling request; callers can still log via the returned
 * counters if they want.
 */
export async function dispatchPushNotifications(opts: {
  db: Database
  env: Env
  userIds: Set<string> | Array<string>
  payload: PushPayload
}): Promise<{ sent: number; pruned: number }> {
  if (!pushEnabled(opts.env)) return { sent: 0, pruned: 0 }
  const ids = Array.from(opts.userIds)
  if (ids.length === 0) return { sent: 0, pruned: 0 }
  try {
    return await pushDeliver({
      db: opts.db,
      env: opts.env,
      userIds: ids,
      payload: opts.payload,
    })
  } catch {
    return { sent: 0, pruned: 0 }
  }
}
