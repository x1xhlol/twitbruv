import PgBoss from 'pg-boss'
import pino from 'pino'
import { createMailer } from '@workspace/email'
import { createDbFromEnv } from '@workspace/db'
import { createS3 } from '@workspace/media/s3'
import type { MediaEnv } from '@workspace/media/env'
import { loadEnv } from './env.ts'
import { handleEmailJob } from './jobs/email.ts'
import { handleMediaJob } from './jobs/media-process.ts'
import { publishDueScheduledPosts } from './jobs/publish-scheduled.ts'
import { dispatchDigests } from './jobs/digest.ts'

const env = loadEnv()

const log = pino({
  level: env.LOG_LEVEL,
  ...(env.NODE_ENV === 'production'
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
})

const mailer = createMailer({
  from: env.EMAIL_FROM,
  provider: env.EMAIL_PROVIDER,
  resendApiKey: env.RESEND_API_KEY,
  smtp: {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
  },
})

const db = createDbFromEnv()
const mediaEnv: MediaEnv = {
  S3_ENDPOINT: env.S3_ENDPOINT,
  S3_REGION: env.S3_REGION,
  S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY,
  S3_BUCKET: env.S3_BUCKET,
  S3_PUBLIC_URL: env.S3_PUBLIC_URL,
}
const s3 = createS3(mediaEnv)

const boss = new PgBoss({ connectionString: env.DATABASE_URL })
boss.on('error', (err) => log.error({ err: err.message }, 'pg_boss_error'))

await boss.start()
// pg-boss v10 needs queues declared before work/send. Idempotent.
// Serialize: creating two queues in parallel deadlocks on pgboss.queue row locks.
await boss.createQueue('email.send')
await boss.createQueue('media.process')

await boss.work('email.send', { batchSize: 5 }, async (jobs) => {
  await Promise.all(jobs.map((job) => handleEmailJob(mailer, job.data)))
})

await boss.work('media.process', { batchSize: 2 }, async (jobs) => {
  for (const job of jobs) {
    log.info({ payload: job.data }, 'media_process_start')
    try {
      await handleMediaJob({ db, s3, env: mediaEnv, payload: job.data })
      log.info({ payload: job.data }, 'media_process_done')
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.stack ?? err.message : err, payload: job.data },
        'media_process_failed',
      )
      throw err
    }
  }
})

// Polls every 30s for scheduled posts whose publish time has arrived. Cheap query, indexed.
// Runs in-process rather than via pg-boss because it doesn't need durability or fan-out — it
// just walks the table.
const SCHEDULED_INTERVAL_MS = 30_000
let scheduledRunning = false
const scheduledTimer = setInterval(async () => {
  if (scheduledRunning) return
  scheduledRunning = true
  try {
    const n = await publishDueScheduledPosts(db)
    if (n > 0) log.info({ published: n }, 'scheduled_posts_published')
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : err }, 'scheduled_posts_failed')
  } finally {
    scheduledRunning = false
  }
}, SCHEDULED_INTERVAL_MS)

// Daily-digest dispatcher: runs every 15 minutes, scans profile_private for
// users opted into a daily digest with new unread notifications, sends one
// rollup email per user, and updates lastSentAt. The dispatcher itself caps
// at 500 candidates per pass; for larger user bases we'd switch this over to
// a sharded sweep keyed by user id.
const DIGEST_INTERVAL_MS = 15 * 60 * 1000
let digestRunning = false
const digestTimer = setInterval(async () => {
  if (digestRunning) return
  digestRunning = true
  try {
    const res = await dispatchDigests({
      db,
      mailer,
      webUrl: env.PUBLIC_WEB_URL,
      appName: env.APP_NAME,
    })
    if (res.sent > 0) log.info(res, 'digests_sent')
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : err }, 'digests_failed')
  } finally {
    digestRunning = false
  }
}, DIGEST_INTERVAL_MS)

log.info(
  {
    queues: ['email.send', 'media.process'],
    scheduledIntervalMs: SCHEDULED_INTERVAL_MS,
    digestIntervalMs: DIGEST_INTERVAL_MS,
  },
  'worker_ready',
)

const shutdown = async () => {
  log.info('worker_shutdown')
  clearInterval(scheduledTimer)
  clearInterval(digestTimer)
  await boss.stop({ graceful: true })
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
