import type { AppContext } from "./context.ts"

const CACHE_TTL_SEC = 10 * 60
const PER_PAGE = 100
const MAX_PAGES = 10

interface ContributorEntry {
  login?: string
  type?: string
}

function cacheKey(repo: string): string {
  return `gh:contributors:${repo.toLowerCase()}`
}

function buildHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "twotter-contributor-check",
    "x-github-api-version": "2022-11-28",
  }
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}

async function fetchContributorLogins(
  ctx: AppContext,
  repo: string,
): Promise<Set<string> | null> {
  const headers = buildHeaders(ctx.env.GITHUB_UNFURL_TOKEN)
  const logins = new Set<string>()
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://api.github.com/repos/${repo}/contributors?per_page=${PER_PAGE}&anon=false&page=${page}`
    let res: Response
    try {
      res = await fetch(url, { headers })
    } catch (err) {
      ctx.log.warn(
        { repo, err: err instanceof Error ? err.message : err },
        "github_contributors_fetch_failed",
      )
      return null
    }
    if (res.status === 404) {
      ctx.log.warn({ repo }, "github_contributors_repo_not_found")
      return new Set()
    }
    if (res.status === 204 || res.status === 202) {
      return new Set()
    }
    if (!res.ok) {
      ctx.log.warn(
        { repo, status: res.status },
        "github_contributors_fetch_non_ok",
      )
      return null
    }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      return null
    }
    if (!Array.isArray(body)) return null
    let received = 0
    for (const entry of body as Array<ContributorEntry>) {
      received++
      if (entry?.type === "Bot") continue
      const login = entry?.login
      if (typeof login === "string" && login.length > 0) {
        logins.add(login.toLowerCase())
      }
    }
    if (received < PER_PAGE) break
  }
  return logins
}

async function getContributorLogins(
  ctx: AppContext,
  repo: string,
): Promise<Set<string> | null> {
  const key = cacheKey(repo)
  const cached = await ctx.cache.get<Array<string>>(key)
  if (cached) return new Set(cached)
  const fetched = await fetchContributorLogins(ctx, repo)
  if (!fetched) return null
  await ctx.cache.set(key, [...fetched], CACHE_TTL_SEC)
  return fetched
}

/**
 * Tri-state: `true`/`false` are definitive, `unknown` means the GitHub API was unreachable
 * or returned a non-OK status for every configured repo so we couldn't make a determination.
 * Callers should NOT use `unknown` to overwrite an existing contributor flag.
 */
export type ContributorStatus = "yes" | "no" | "unknown"

export async function checkUserContributorStatus(
  ctx: AppContext,
  login: string | null | undefined,
): Promise<ContributorStatus> {
  if (!login) return "no"
  const repos = ctx.env.GITHUB_CONTRIBUTOR_REPOS
  if (!repos || repos.length === 0) return "no"
  const target = login.toLowerCase()
  let sawAnyRepo = false
  for (const repo of repos) {
    const logins = await getContributorLogins(ctx, repo)
    if (logins === null) continue
    sawAnyRepo = true
    if (logins.has(target)) return "yes"
  }
  return sawAnyRepo ? "no" : "unknown"
}

export async function isUserContributor(
  ctx: AppContext,
  login: string | null | undefined,
): Promise<boolean> {
  return (await checkUserContributorStatus(ctx, login)) === "yes"
}

export function contributorReposConfigured(ctx: AppContext): boolean {
  return (ctx.env.GITHUB_CONTRIBUTOR_REPOS ?? []).length > 0
}

export function configuredContributorRepos(ctx: AppContext): Array<string> {
  return ctx.env.GITHUB_CONTRIBUTOR_REPOS ?? []
}
