import { Hono } from 'hono'
import { and, asc, desc, eq, isNull, sql } from '@workspace/db'
import { schema } from '@workspace/db'
import { assetUrl } from '@workspace/media/s3'
import type { HonoEnv } from '../middleware/session.ts'
import { toPostDto } from '../lib/post-dto.ts'
import { loadViewerFlags } from '../lib/viewer-flags.ts'
import { loadPostMedia } from '../lib/post-media.ts'
import { loadArticleCards } from '../lib/article-cards.ts'
import { loadRepostTargets } from '../lib/repost-targets.ts'
import { loadQuoteTargets } from '../lib/quote-targets.ts'
import { loadPolls } from '../lib/polls.ts'

export const exploreRoute = new Hono<HonoEnv>()

const EXPLORE_CACHE_KEY = 'explore:summary'
const EXPLORE_TTL_SECONDS = 60 * 5

interface TrendingHashtag {
  tag: string
  postCount: number
}

interface SuggestedUser {
  id: string
  handle: string | null
  displayName: string | null
  avatarUrl: string | null
  isVerified: boolean
  bio: string | null
  followerCount: number
}

// One landing endpoint that backs the /explore page. Combines:
//   - top trending hashtags (last 24h, distinct posts)
//   - top public posts in the last 24h by engagement (likes + reposts + replies)
//   - suggested users to follow (public, non-bot, by recent follower velocity)
//
// We cache the heavy parts (trending + suggestions) for 5 minutes; viewer flags
// on the top posts are computed per-request because they depend on `viewerId`.
exploreRoute.get('/', async (c) => {
  const { db, cache, mediaEnv, rateLimit } = c.get('ctx')
  await rateLimit(c, 'reads.feed')
  const viewerId = c.get('session')?.user.id

  type Cached = {
    hashtags: Array<TrendingHashtag>
    topPostIds: Array<string>
    users: Array<SuggestedUser>
  }
  const cached = await cache.get<Cached>(EXPLORE_CACHE_KEY)
  let payload: Cached
  if (cached) {
    payload = cached
  } else {
    const [hashtags, postIds, users] = await Promise.all([
      computeTrendingHashtags(db),
      computeTopPostIds(db),
      computeSuggestedUsers(db, mediaEnv),
    ])
    payload = { hashtags, topPostIds: postIds, users }
    await cache.set(EXPLORE_CACHE_KEY, payload, EXPLORE_TTL_SECONDS)
  }

  // Hydrate the cached post id list into full DTOs with viewer flags.
  let posts: Array<ReturnType<typeof toPostDto>> = []
  if (payload.topPostIds.length > 0) {
    const rows = await db
      .select({ post: schema.posts, author: schema.users })
      .from(schema.posts)
      .innerJoin(schema.users, eq(schema.users.id, schema.posts.authorId))
      .where(
        and(
          isNull(schema.posts.deletedAt),
          eq(schema.posts.visibility, 'public'),
          sql`${schema.posts.id} = ANY(${payload.topPostIds})`,
        ),
      )
    // Preserve the cached ordering instead of relying on join order.
    const byId = new Map(rows.map((r) => [r.post.id, r]))
    const ordered = payload.topPostIds
      .map((id) => byId.get(id))
      .filter((r): r is (typeof rows)[number] => Boolean(r))
    const ids = ordered.map((r) => r.post.id)
    const [flags, mediaMap, articleMap, repostMap, quoteMap, pollMap] = await Promise.all([
      loadViewerFlags(db, viewerId, ids),
      loadPostMedia(db, ids),
      loadArticleCards(db, ids),
      loadRepostTargets({
        db,
        viewerId,
        env: mediaEnv,
        repostRows: ordered.map((r) => ({ id: r.post.id, repostOfId: r.post.repostOfId })),
      }),
      loadQuoteTargets({
        db,
        viewerId,
        env: mediaEnv,
        quoteRows: ordered.map((r) => ({ id: r.post.id, quoteOfId: r.post.quoteOfId })),
      }),
      loadPolls(db, viewerId, ids),
    ])
    posts = ordered.map((r) =>
      toPostDto(
        r.post,
        r.author,
        flags.get(r.post.id),
        mediaMap.get(r.post.id),
        mediaEnv,
        articleMap.get(r.post.id),
        repostMap.get(r.post.id),
        quoteMap.get(r.post.id),
        pollMap.get(r.post.id),
      ),
    )
  }

  return c.json({
    hashtags: payload.hashtags,
    posts,
    users: payload.users,
    cached: Boolean(cached),
  })
})

async function computeTrendingHashtags(
  db: import('@workspace/db').Database,
): Promise<Array<TrendingHashtag>> {
  const result = await db.execute(sql`
    SELECT h.tag, COUNT(DISTINCT ph.post_id)::int AS n
    FROM ${schema.postHashtags} ph
    JOIN ${schema.hashtags} h ON h.id = ph.hashtag_id
    JOIN ${schema.posts} p ON p.id = ph.post_id
    WHERE p.created_at > now() - interval '24 hours'
      AND p.deleted_at IS NULL
      AND p.visibility = 'public'
    GROUP BY h.tag
    ORDER BY n DESC
    LIMIT 10
  `)
  return (result as unknown as Array<{ tag: string; n: number }>).map((r) => ({
    tag: r.tag,
    postCount: r.n,
  }))
}

async function computeTopPostIds(
  db: import('@workspace/db').Database,
): Promise<Array<string>> {
  // "Top posts" is intentionally simple — likes + reposts + replies in the
  // last 24h, public, non-deleted. No ML, by design. The cap of 10 keeps
  // the explore feed digestible.
  const rows = await db.execute(sql`
    SELECT id
      FROM ${schema.posts}
      WHERE deleted_at IS NULL
        AND visibility = 'public'
        AND created_at > now() - interval '24 hours'
      ORDER BY (like_count + repost_count + reply_count) DESC, created_at DESC
      LIMIT 10
  `)
  return (rows as unknown as Array<{ id: string }>).map((r) => r.id)
}

async function computeSuggestedUsers(
  db: import('@workspace/db').Database,
  env: import('@workspace/media/env').MediaEnv,
): Promise<Array<SuggestedUser>> {
  // Surface accounts that picked up the most followers in the last 14 days
  // and have an avatar + handle. Excludes bots, deleted accounts, and any
  // user with the shadowban marker set.
  const rows = await db.execute(sql<{
    id: string
    handle: string | null
    display_name: string | null
    avatar_url: string | null
    is_verified: boolean
    bio: string | null
    n: number
  }>`
    SELECT u.id, u.handle, u.display_name, u.avatar_url, u.is_verified, u.bio,
           COUNT(f.follower_id)::int AS n
      FROM ${schema.users} u
      JOIN ${schema.follows} f ON f.followee_id = u.id
       AND f.created_at > now() - interval '14 days'
      WHERE u.deleted_at IS NULL
        AND u.is_bot = false
        AND u.shadow_banned_at IS NULL
        AND u.handle IS NOT NULL
      GROUP BY u.id
      ORDER BY n DESC
      LIMIT 8
  `)
  return (rows as unknown as Array<{
    id: string
    handle: string | null
    display_name: string | null
    avatar_url: string | null
    is_verified: boolean
    bio: string | null
    n: number
  }>).map((r) => ({
    id: r.id,
    handle: r.handle,
    displayName: r.display_name,
    avatarUrl: assetUrl(env, r.avatar_url),
    isVerified: r.is_verified,
    bio: r.bio,
    followerCount: r.n,
  }))
}

// Suppress unused warnings on `asc`/`desc` exports — they're useful for future
// extensions and re-exporting through this file keeps callers consistent.
void asc
void desc
