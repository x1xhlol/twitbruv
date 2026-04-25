import { z } from "zod"

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  EMAIL_FROM: z.string().default("twotter <noreply@localhost>"),
  EMAIL_PROVIDER: z.enum(["smtp", "resend"]).default("smtp"),
  RESEND_API_KEY: z.string().optional(),
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default("auto"),
  S3_ACCESS_KEY_ID: z.string(),
  S3_SECRET_ACCESS_KEY: z.string(),
  S3_BUCKET: z.string(),
  S3_PUBLIC_URL: z.string().url(),

  // Used by the digest dispatcher to compose absolute links inside email
  // bodies. Must match the production web URL or links won't resolve.
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:3000'),
  APP_NAME: z.string().default('twotter'),
})

export type Env = z.infer<typeof envSchema>

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    console.error("Invalid environment:", parsed.error.flatten().fieldErrors)
    process.exit(1)
  }
  return parsed.data
}
