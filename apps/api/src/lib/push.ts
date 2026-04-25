import webpush from 'web-push'
import { schema } from '@workspace/db'
import { eq, inArray } from '@workspace/db'
import type { Database } from '@workspace/db'
import type { Env } from './env.ts'

export interface PushSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface PushPayload {
  title: string
  body: string
  url?: string
  tag?: string
  icon?: string
}

let configured = false
function configure(env: Env) {
  if (configured) return
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY)
  configured = true
}

export function pushEnabled(env: Env): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY)
}

// Read the per-user push subscriptions from profile_private. Each user can
// have multiple subscriptions (one per browser/device), stored as a JSON
// array. We tolerate either an array or a single object for forward-compat
// with older shapes.
async function loadSubscriptions(
  db: Database,
  userIds: Array<string>,
): Promise<Map<string, Array<PushSubscription>>> {
  if (userIds.length === 0) return new Map()
  const rows = await db
    .select({
      userId: schema.profilePrivate.userId,
      pushSubscriptions: schema.profilePrivate.pushSubscriptions,
    })
    .from(schema.profilePrivate)
    .where(inArray(schema.profilePrivate.userId, userIds))
  const out = new Map<string, Array<PushSubscription>>()
  for (const row of rows) {
    const raw = row.pushSubscriptions as unknown
    const list = Array.isArray(raw)
      ? (raw as Array<PushSubscription>)
      : raw && typeof raw === 'object'
        ? [raw as PushSubscription]
        : []
    if (list.length > 0) out.set(row.userId, list)
  }
  return out
}

// Best-effort delivery to every subscription for the given users. On a
// terminal failure (404/410 — subscription expired) we strip the failing
// endpoint from the user's row so we don't keep retrying. Other errors are
// logged via the caller but don't propagate; push is fire-and-forget from
// the caller's perspective.
export async function pushDeliver(opts: {
  db: Database
  env: Env
  userIds: Array<string>
  payload: PushPayload
}): Promise<{ sent: number; pruned: number }> {
  configure(opts.env)
  if (!pushEnabled(opts.env) || opts.userIds.length === 0) {
    return { sent: 0, pruned: 0 }
  }
  const subs = await loadSubscriptions(opts.db, opts.userIds)
  if (subs.size === 0) return { sent: 0, pruned: 0 }
  const json = JSON.stringify(opts.payload)
  let sent = 0
  let pruned = 0
  for (const [userId, list] of subs) {
    const stillValid: Array<PushSubscription> = []
    for (const sub of list) {
      try {
        await webpush.sendNotification(sub, json, { TTL: 60 })
        sent++
        stillValid.push(sub)
      } catch (e: unknown) {
        const status = (e as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) {
          pruned++
          // Drop this subscription from the user's row.
        } else {
          stillValid.push(sub)
        }
      }
    }
    if (stillValid.length !== list.length) {
      await opts.db
        .update(schema.profilePrivate)
        .set({ pushSubscriptions: stillValid.length > 0 ? stillValid : null })
        .where(eq(schema.profilePrivate.userId, userId))
    }
  }
  return { sent, pruned }
}
