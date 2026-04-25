import type { Mailer } from '@workspace/email'
import { z } from 'zod'

export const emailJobSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  template: z.enum(['verify', 'reset', 'magic-link', 'welcome', 'digest']),
  data: z.record(z.string(), z.unknown()),
})

export type EmailJob = z.infer<typeof emailJobSchema>

export async function handleEmailJob(mailer: Mailer, payload: unknown) {
  const job = emailJobSchema.parse(payload)
  await mailer.send(job)
}
