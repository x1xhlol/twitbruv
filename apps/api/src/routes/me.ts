import { Hono } from 'hono'
import { and, asc, desc, eq, inArray, isNull, lt, sql } from '@workspace/db'
import { schema } from '@workspace/db'
import { buildZip } from '../lib/zip.ts'
import { updateProfileSchema, claimHandleSchema } from '@workspace/validators'
import { assetUrl, extractKey } from '@workspace/media/s3'
import { requireAuth, type HonoEnv } from '../middleware/session.ts'
import { isReservedHandle } from '../lib/handles.ts'
import { toPostDto } from '../lib/post-dto.ts'
import { loadViewerFlags } from '../lib/viewer-flags.ts'
import { loadPostMedia } from '../lib/post-media.ts'
import { loadArticleCards } from '../lib/article-cards.ts'
import { loadRepostTargets } from '../lib/repost-targets.ts'
import { loadQuoteTargets } from '../lib/quote-targets.ts'
import { loadPolls } from '../lib/polls.ts'
import { parseCursor } from '../lib/cursor.ts'

export const meRoute = new Hono<HonoEnv>()

meRoute.use('*', requireAuth())

meRoute.get('/', async (c) => {
  const session = c.get('session')!
  const { db } = c.get('ctx')
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, session.user.id)).limit(1)
  if (!user) return c.json({ error: 'not_found' }, 404)
  return c.json({ user: toSelfDto(user, c.get('ctx').mediaEnv) })
})

meRoute.patch('/', async (c) => {
  const session = c.get('session')!
  const { db } = c.get('ctx')
  const raw = await c.req.json()
  const body = updateProfileSchema.parse(raw)

  // Only write columns that were explicitly included in the request body. Empty string is
  // treated as "clear this field" (→ null). Missing keys are left untouched.
  const patch: Partial<typeof schema.users.$inferInsert> = { updatedAt: new Date() }
  const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k)
  // Empty string from the client means "clear this field" → store NULL.
  if (has('displayName')) patch.displayName = body.displayName || null
  if (has('bio')) patch.bio = body.bio || null
  if (has('location')) patch.location = body.location || null
  if (has('websiteUrl')) patch.websiteUrl = body.websiteUrl || null
  // Store the bare object key so we never have to migrate when the asset host changes.
  if (has('avatarUrl'))
    patch.avatarUrl = body.avatarUrl ? extractKey(c.get('ctx').mediaEnv, body.avatarUrl) : null
  if (has('bannerUrl'))
    patch.bannerUrl = body.bannerUrl ? extractKey(c.get('ctx').mediaEnv, body.bannerUrl) : null
  if (has('birthday')) patch.birthday = body.birthday || null
  if (has('timezone')) patch.timezone = body.timezone ?? null
  if (has('locale')) patch.locale = body.locale ?? 'en'

  const [user] = await db
    .update(schema.users)
    .set(patch)
    .where(eq(schema.users.id, session.user.id))
    .returning()
  if (!user) return c.json({ error: 'not_found' }, 404)
  return c.json({ user: toSelfDto(user, c.get('ctx').mediaEnv) })
})

meRoute.post('/handle', async (c) => {
  const session = c.get('session')!
  const { db } = c.get('ctx')
  const { handle } = claimHandleSchema.parse(await c.req.json())
  if (isReservedHandle(handle)) return c.json({ error: 'reserved_handle' }, 400)

  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.handle, handle))
    .limit(1)
  if (existing.length > 0) return c.json({ error: 'handle_taken' }, 409)

  const [user] = await db
    .update(schema.users)
    .set({ handle, updatedAt: new Date() })
    .where(eq(schema.users.id, session.user.id))
    .returning()
  if (!user) return c.json({ error: 'not_found' }, 404)
  return c.json({ user: toSelfDto(user, c.get('ctx').mediaEnv) })
})

// Users I've blocked. Newest first. Used by settings → Privacy so users can audit and
// unblock without remembering exact handles.
meRoute.get('/blocks', async (c) => {
  const session = c.get('session')!
  const { db, mediaEnv } = c.get('ctx')
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 100)
  const cursor = c.req.query('cursor')

  const rows = await db
    .select({ user: schema.users, block: schema.blocks })
    .from(schema.blocks)
    .innerJoin(schema.users, eq(schema.users.id, schema.blocks.blockedId))
    .where(
      and(
        eq(schema.blocks.blockerId, session.user.id),
        isNull(schema.users.deletedAt),
        cursor ? lt(schema.blocks.createdAt, new Date(cursor)) : undefined,
      ),
    )
    .orderBy(desc(schema.blocks.createdAt))
    .limit(limit)
  const users = rows.map((r) => ({
    id: r.user.id,
    handle: r.user.handle,
    displayName: r.user.displayName,
    avatarUrl: assetUrl(mediaEnv, r.user.avatarUrl),
    isVerified: r.user.isVerified,
    blockedAt: r.block.createdAt.toISOString(),
  }))
  const nextCursor =
    rows.length === limit ? rows[rows.length - 1]!.block.createdAt.toISOString() : null
  return c.json({ users, nextCursor })
})

// Users I've muted, with the mute scope so the UI can show whether they're hidden from
// feed only, notifications only, or both.
meRoute.get('/mutes', async (c) => {
  const session = c.get('session')!
  const { db, mediaEnv } = c.get('ctx')
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 100)
  const cursor = c.req.query('cursor')

  const rows = await db
    .select({ user: schema.users, mute: schema.mutes })
    .from(schema.mutes)
    .innerJoin(schema.users, eq(schema.users.id, schema.mutes.mutedId))
    .where(
      and(
        eq(schema.mutes.muterId, session.user.id),
        isNull(schema.users.deletedAt),
        cursor ? lt(schema.mutes.createdAt, new Date(cursor)) : undefined,
      ),
    )
    .orderBy(desc(schema.mutes.createdAt))
    .limit(limit)
  const users = rows.map((r) => ({
    id: r.user.id,
    handle: r.user.handle,
    displayName: r.user.displayName,
    avatarUrl: assetUrl(mediaEnv, r.user.avatarUrl),
    isVerified: r.user.isVerified,
    mutedAt: r.mute.createdAt.toISOString(),
    scope: r.mute.scope,
  }))
  const nextCursor =
    rows.length === limit ? rows[rows.length - 1]!.mute.createdAt.toISOString() : null
  return c.json({ users, nextCursor })
})

// Viewer's bookmarked posts, newest bookmark first.
meRoute.get('/bookmarks', async (c) => {
  const session = c.get('session')!
  const { db, mediaEnv } = c.get('ctx')
  const limit = Math.min(Number(c.req.query('limit') ?? 40), 100)
  const cursor = parseCursor(c.req.query('cursor'))

  const rows = await db
    .select({ post: schema.posts, author: schema.users, bookmarkedAt: schema.bookmarks.createdAt })
    .from(schema.bookmarks)
    .innerJoin(schema.posts, eq(schema.posts.id, schema.bookmarks.postId))
    .innerJoin(schema.users, eq(schema.users.id, schema.posts.authorId))
    .where(
      and(
        eq(schema.bookmarks.userId, session.user.id),
        isNull(schema.posts.deletedAt),
        cursor ? lt(schema.bookmarks.createdAt, cursor) : undefined,
      ),
    )
    .orderBy(desc(schema.bookmarks.createdAt))
    .limit(limit)

  const ids = rows.map((r) => r.post.id)
  const [flags, mediaMap, articleMap, repostMap, quoteMap, pollMap] = await Promise.all([
    loadViewerFlags(db, session.user.id, ids),
    loadPostMedia(db, ids),
    loadArticleCards(db, ids),
    loadRepostTargets({
      db,
      viewerId: session.user.id,
      env: mediaEnv,
      repostRows: rows.map((r) => ({ id: r.post.id, repostOfId: r.post.repostOfId })),
    }),
    loadQuoteTargets({
      db,
      viewerId: session.user.id,
      env: mediaEnv,
      quoteRows: rows.map((r) => ({ id: r.post.id, quoteOfId: r.post.quoteOfId })),
    }),
    loadPolls(db, session.user.id, ids),
  ])
  const posts = rows.map((r) =>
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
  const nextCursor = rows.length === limit ? rows[rows.length - 1]!.bookmarkedAt.toISOString() : null
  return c.json({ posts, nextCursor })
})

// Account data export: returns a ZIP archive (single-disk, store-mode) with
// JSON files for each scope of the viewer's data. Designed for self-service
// data takeout / GDPR-style requests; the response is streamed all at once
// since the row counts per user are bounded by app-level limits.
meRoute.get('/export', async (c) => {
  const session = c.get('session')!
  const { db } = c.get('ctx')
  const me = session.user.id

  // Pull every relevant table for this user, capped per relation so a runaway
  // export can't OOM the API. The caps match X's published export sizes
  // (~50k posts, ~10k DMs) and are generous for most accounts.
  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, me))
    .limit(1)
  if (!user) return c.json({ error: 'not_found' }, 404)

  const POST_CAP = 50_000
  const MSG_CAP = 50_000
  const ROW_CAP = 20_000

  const [
    posts,
    edits,
    likes,
    bookmarksRows,
    follows,
    followers,
    blocks,
    mutes,
    notifications,
    listsOwned,
    listMemberships,
    articles,
    convs,
    messages,
  ] = await Promise.all([
    db.select().from(schema.posts).where(eq(schema.posts.authorId, me)).limit(POST_CAP),
    db
      .select({
        id: schema.postEdits.id,
        postId: schema.postEdits.postId,
        previousText: schema.postEdits.previousText,
        editedAt: schema.postEdits.editedAt,
      })
      .from(schema.postEdits)
      .where(eq(schema.postEdits.editedBy, me))
      .limit(ROW_CAP),
    db.select().from(schema.likes).where(eq(schema.likes.userId, me)).limit(ROW_CAP),
    db.select().from(schema.bookmarks).where(eq(schema.bookmarks.userId, me)).limit(ROW_CAP),
    db.select().from(schema.follows).where(eq(schema.follows.followerId, me)).limit(ROW_CAP),
    db.select().from(schema.follows).where(eq(schema.follows.followeeId, me)).limit(ROW_CAP),
    db.select().from(schema.blocks).where(eq(schema.blocks.blockerId, me)).limit(ROW_CAP),
    db.select().from(schema.mutes).where(eq(schema.mutes.muterId, me)).limit(ROW_CAP),
    db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, me))
      .orderBy(desc(schema.notifications.createdAt))
      .limit(ROW_CAP),
    db.select().from(schema.userLists).where(eq(schema.userLists.ownerId, me)).limit(ROW_CAP),
    db
      .select({
        listId: schema.userListMembers.listId,
        addedAt: schema.userListMembers.addedAt,
      })
      .from(schema.userListMembers)
      .where(eq(schema.userListMembers.memberId, me))
      .limit(ROW_CAP),
    db.select().from(schema.articles).where(eq(schema.articles.authorId, me)).limit(ROW_CAP),
    db
      .select({
        conv: schema.conversations,
        member: schema.conversationMembers,
      })
      .from(schema.conversationMembers)
      .innerJoin(
        schema.conversations,
        eq(schema.conversations.id, schema.conversationMembers.conversationId),
      )
      .where(eq(schema.conversationMembers.userId, me))
      .limit(ROW_CAP),
    db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.senderId, me))
      .orderBy(desc(schema.messages.createdAt))
      .limit(MSG_CAP),
  ])

  const profile = {
    id: user.id,
    handle: user.handle,
    email: user.email,
    emailVerified: user.emailVerified,
    displayName: user.displayName,
    bio: user.bio,
    location: user.location,
    websiteUrl: user.websiteUrl,
    avatarUrl: user.avatarUrl,
    bannerUrl: user.bannerUrl,
    birthday: user.birthday,
    locale: user.locale,
    timezone: user.timezone,
    isVerified: user.isVerified,
    isBot: user.isBot,
    role: user.role,
    createdAt: user.createdAt,
  }

  const readme = [
    'twotter account export',
    '',
    'This archive contains the data twotter has on file for your account, as of ',
    new Date().toISOString() + '.',
    '',
    'Files:',
    '  profile.json         — your account profile + settings',
    '  posts.json           — posts you authored (capped at 50k)',
    '  post-edits.json      — historical text of your edited posts',
    '  likes.json           — posts you liked',
    '  bookmarks.json       — posts you bookmarked',
    '  follows.json         — accounts you follow + accounts who follow you',
    '  blocks.json          — accounts you blocked',
    '  mutes.json           — accounts you muted',
    '  notifications.json   — notifications you received',
    '  lists.json           — lists you own + lists you are a member of',
    '  articles.json        — articles you authored',
    '  conversations.json   — DM conversations you are a member of (headers only)',
    '  messages.json        — DM messages you sent',
    '',
    'For privacy, the export does NOT include direct messages from other users; only',
    'messages you sent appear in messages.json. To request your full inbox a member',
    'view, use the in-app request flow.',
  ].join('\n')

  const zip = buildZip([
    { name: 'README.txt', data: readme },
    { name: 'profile.json', data: JSON.stringify(profile, null, 2) },
    { name: 'posts.json', data: JSON.stringify(posts, null, 2) },
    { name: 'post-edits.json', data: JSON.stringify(edits, null, 2) },
    { name: 'likes.json', data: JSON.stringify(likes, null, 2) },
    { name: 'bookmarks.json', data: JSON.stringify(bookmarksRows, null, 2) },
    {
      name: 'follows.json',
      data: JSON.stringify({ following: follows, followers }, null, 2),
    },
    { name: 'blocks.json', data: JSON.stringify(blocks, null, 2) },
    { name: 'mutes.json', data: JSON.stringify(mutes, null, 2) },
    { name: 'notifications.json', data: JSON.stringify(notifications, null, 2) },
    {
      name: 'lists.json',
      data: JSON.stringify({ owned: listsOwned, memberOf: listMemberships }, null, 2),
    },
    { name: 'articles.json', data: JSON.stringify(articles, null, 2) },
    { name: 'conversations.json', data: JSON.stringify(convs, null, 2) },
    { name: 'messages.json', data: JSON.stringify(messages, null, 2) },
  ])

  const stamp = new Date().toISOString().slice(0, 10)
  c.header('Content-Type', 'application/zip')
  c.header(
    'Content-Disposition',
    `attachment; filename="twotter-export-${user.handle ?? 'account'}-${stamp}.zip"`,
  )
  c.header('Cache-Control', 'no-store')
  return c.body(zip as unknown as ArrayBuffer)
})

function toSelfDto(
  u: typeof schema.users.$inferSelect,
  env: import('@workspace/media/env').MediaEnv,
) {
  return {
    id: u.id,
    email: u.email,
    emailVerified: u.emailVerified,
    handle: u.handle,
    displayName: u.displayName,
    bio: u.bio,
    location: u.location,
    websiteUrl: u.websiteUrl,
    avatarUrl: assetUrl(env, u.avatarUrl),
    bannerUrl: assetUrl(env, u.bannerUrl),
    birthday: u.birthday,
    isVerified: u.isVerified,
    isBot: u.isBot,
    role: u.role,
    locale: u.locale,
    timezone: u.timezone,
    createdAt: u.createdAt,
  }
}
