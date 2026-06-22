import twilio from 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;

export const hasTwilioConfig = !!(accountSid && authToken && twilioNumber);

let client: ReturnType<typeof twilio> | null = null;
if (hasTwilioConfig) {
  client = twilio(accountSid, authToken);
}

/**
 * Verify an inbound Twilio webhook request via its X-Twilio-Signature header.
 * Twilio HMACs the full public URL plus the sorted POST params with your auth
 * token; this confirms the request genuinely came from Twilio and wasn't forged.
 *
 * Returns false when no auth token is available (cannot verify). Callers decide
 * whether to enforce — in practice, enforce whenever TWILIO_AUTH_TOKEN is set.
 */
export function validateTwilioSignature(opts: {
  signature: string;
  url: string;
  params: Record<string, unknown>;
  authToken?: string;
}): boolean {
  const token = opts.authToken ?? process.env.TWILIO_AUTH_TOKEN;
  if (!token || !opts.signature) return false;
  return twilio.validateRequest(token, opts.signature, opts.url, opts.params as Record<string, string>);
}

export async function sendSms(to: string, body: string): Promise<{ success: boolean; sid?: string; error?: string }> {
  if (!hasTwilioConfig || !client) {
    console.log(`[TWILIO DRY RUN] Sending SMS to ${to}: ${body}`);
    return { success: true, sid: 'mock_sid_dry_run' };
  }

  try {
    const message = await client.messages.create({
      body,
      from: twilioNumber,
      to,
    });
    console.log(`[TWILIO SUCCESS] SMS sent to ${to}, SID: ${message.sid}`);
    return { success: true, sid: message.sid };
  } catch (error) {
    const err = error as Error;
    console.error(`[TWILIO ERROR] Failed to send SMS to ${to}:`, error);
    return { success: false, error: err.message || String(error) };
  }
}
