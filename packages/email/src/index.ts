import { render } from '@react-email/render'
import nodemailer from 'nodemailer'
import { Resend } from 'resend'
import { VerifyEmail } from './templates/verify.tsx'
import { ResetEmail } from './templates/reset.tsx'
import { MagicLinkEmail } from './templates/magic-link.tsx'
import { WelcomeEmail } from './templates/welcome.tsx'
import { DigestEmail } from './templates/digest.tsx'

export type { DigestItem } from './templates/digest.tsx'

export type TemplateName = 'verify' | 'reset' | 'magic-link' | 'welcome' | 'digest'

export interface SendArgs {
  to: string
  subject: string
  template: TemplateName
  data: Record<string, unknown>
}

export interface MailerConfig {
  from: string
  provider: 'smtp' | 'resend'
  resendApiKey?: string
  smtp?: { host: string; port: number; user?: string; pass?: string }
}

async function renderTemplate(template: TemplateName, data: Record<string, unknown>) {
  switch (template) {
    case 'verify':
      return render(VerifyEmail({ url: data.url as string, name: (data.name as string) || '' }))
    case 'reset':
      return render(ResetEmail({ url: data.url as string, name: (data.name as string) || '' }))
    case 'magic-link':
      return render(MagicLinkEmail({ url: data.url as string }))
    case 'welcome':
      return render(WelcomeEmail({ handle: data.handle as string }))
    case 'digest':
      return render(
        DigestEmail({
          webUrl: data.webUrl as string,
          recipientName: data.recipientName as string,
          itemsByKind: data.itemsByKind as never,
          totalCount: data.totalCount as number,
          unsubscribeUrl: data.unsubscribeUrl as string,
        }),
      )
  }
}

export function createMailer(config: MailerConfig) {
  if (config.provider === 'resend') {
    if (!config.resendApiKey) throw new Error('RESEND_API_KEY required for resend provider')
    const client = new Resend(config.resendApiKey)
    return {
      async send(args: SendArgs) {
        const html = await renderTemplate(args.template, args.data)
        await client.emails.send({
          from: config.from,
          to: args.to,
          subject: args.subject,
          html,
        })
      },
    }
  }

  if (!config.smtp) throw new Error('SMTP config required for smtp provider')
  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: false,
    auth: config.smtp.user && config.smtp.pass ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  })
  return {
    async send(args: SendArgs) {
      const html = await renderTemplate(args.template, args.data)
      await transporter.sendMail({
        from: config.from,
        to: args.to,
        subject: args.subject,
        html,
      })
    },
  }
}

export type Mailer = ReturnType<typeof createMailer>
