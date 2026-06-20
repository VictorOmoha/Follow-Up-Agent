import { createTransport, type Transporter } from 'nodemailer';

const smtpHost = process.env.SMTP_HOST;
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const smtpFrom = process.env.SMTP_FROM || smtpUser || 'onboarding@omohasolutions.com';

export const hasSmtpConfig = !!(smtpHost && smtpUser && smtpPass);

let transporter: Transporter | null = null;
if (hasSmtpConfig) {
  transporter = createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPass },
  });
}

/**
 * Send an email via Gmail API using an OAuth access token.
 * Falls back to SMTP via Nodemailer if configured.
 * Falls back to dry-run log if neither is available.
 */
export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  gmailAccessToken?: string
): Promise<{ success: boolean; provider: string; messageId?: string; error?: string }> {
  // Try Gmail API first if token is available
  if (gmailAccessToken) {
    try {
      const rawMessage = [
        `To: ${to}`,
        `Subject: ${subject}`,
        'Content-Type: text/plain; charset=UTF-8',
        'MIME-Version: 1.0',
        '',
        body,
      ].join('\r\n');

      const encoded = Buffer.from(rawMessage)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${gmailAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw: encoded }),
      });

      if (res.ok) {
        const data = await res.json() as { id: string };
        console.log(`[EMAIL GMAIL] Sent to ${to}, ID: ${data.id}`);
        return { success: true, provider: 'gmail', messageId: data.id };
      } else {
        const errText = await res.text();
        console.error(`[EMAIL GMAIL] Failed: ${res.status} ${errText}`);
        // Fall through to SMTP
      }
    } catch (error) {
      console.error('[EMAIL GMAIL] Error:', error);
      // Fall through to SMTP
    }
  }

  // Try SMTP via Nodemailer
  if (hasSmtpConfig && transporter) {
    try {
      const info = await transporter.sendMail({
        from: smtpFrom,
        to,
        subject,
        text: body,
      });
      console.log(`[EMAIL SMTP] Sent to ${to}, ID: ${info.messageId}`);
      return { success: true, provider: 'smtp', messageId: info.messageId };
    } catch (error) {
      const err = error as Error;
      console.error(`[EMAIL SMTP] Failed:`, err.message);
      return { success: false, provider: 'smtp', error: err.message };
    }
  }

  // Dry-run fallback
  console.log(`[EMAIL DRY RUN] To: ${to} | Subject: ${subject} | Body: ${body}`);
  return { success: true, provider: 'dry-run', messageId: 'mock_email_dry_run' };
}