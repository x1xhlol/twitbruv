import { Link, createFileRoute } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { IconHash, IconSparkles, IconUsers } from "@tabler/icons-react"
import { ApiError, api } from "../lib/api"
import { Avatar } from "../components/avatar"
import { PageFrame } from "../components/page-frame"
import { PostCard } from "../components/post-card"
import { VerifiedBadge } from "../components/verified-badge"
import type { Post } from "../lib/api"

interface ExplorePayload {
  hashtags: Array<{ tag: string; postCount: number }>
  posts: Array<Post>
  users: Array<{
    id: string
    handle: string | null
    displayName: string | null
    avatarUrl: string | null
    isVerified: boolean
    bio: string | null
    followerCount: number
  }>
}

export const Route = createFileRoute("/explore")({ component: Explore })

function Explore() {
  const [data, setData] = useState<ExplorePayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .explore()
      .then((p) => {
        if (cancelled) return
        setData({ hashtags: p.hashtags, posts: p.posts, users: p.users })
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof ApiError ? e.message : "couldn't load explore")
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <PageFrame>
      <main>
        <header className="border-b border-border px-4 py-3">
          <h1 className="flex items-center gap-1.5 text-base font-semibold">
            <IconSparkles size={16} stroke={1.75} />
            <span>Explore</span>
          </h1>
          <p className="text-xs text-muted-foreground">
            top posts, trending hashtags, and people picking up followers in
            the last 24 hours. No algorithmic ranking, just counts.
          </p>
        </header>

        {error && (
          <p className="px-4 py-6 text-sm text-destructive">{error}</p>
        )}
        {!error && !data && (
          <p className="px-4 py-6 text-sm text-muted-foreground">loading…</p>
        )}

        {data && (
          <>
            {data.hashtags.length > 0 && (
              <section className="border-b border-border">
                <h2 className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  <IconHash size={12} stroke={1.75} />
                  <span>Trending hashtags</span>
                </h2>
                <div className="flex flex-wrap gap-1.5 px-4 pb-3">
                  {data.hashtags.map((h) => (
                    <Link
                      key={h.tag}
                      to="/hashtag/$tag"
                      params={{ tag: h.tag }}
                      className="rounded-full border border-border bg-muted/40 px-3 py-1 text-xs hover:bg-muted"
                    >
                      <span className="font-medium">#{h.tag}</span>
                      <span className="ml-2 text-muted-foreground">
                        {h.postCount}
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {data.users.length > 0 && (
              <section className="border-b border-border">
                <h2 className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  <IconUsers size={12} stroke={1.75} />
                  <span>People to follow</span>
                </h2>
                <div className="divide-y divide-border">
                  {data.users.map((u) =>
                    u.handle ? (
                      <Link
                        key={u.id}
                        to="/$handle"
                        params={{ handle: u.handle }}
                        className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40"
                      >
                        <Avatar
                          src={u.avatarUrl}
                          initial={(u.displayName || u.handle).slice(0, 1).toUpperCase()}
                          className="size-10 shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1 text-sm font-medium">
                            <span className="truncate">
                              {u.displayName || `@${u.handle}`}
                            </span>
                            {u.isVerified && <VerifiedBadge size={13} />}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            @{u.handle} · +{u.followerCount} new follower
                            {u.followerCount === 1 ? "" : "s"}
                          </div>
                          {u.bio && (
                            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                              {u.bio}
                            </p>
                          )}
                        </div>
                      </Link>
                    ) : null,
                  )}
                </div>
              </section>
            )}

            <section>
              <h2 className="px-4 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Top posts
              </h2>
              {data.posts.length > 0 ? (
                data.posts.map((p) => <PostCard key={p.id} post={p} />)
              ) : (
                <p className="px-4 py-6 text-sm text-muted-foreground">
                  No posts to show yet.
                </p>
              )}
            </section>
          </>
        )}
      </main>
    </PageFrame>
  )
}
