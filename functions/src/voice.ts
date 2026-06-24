import twilio from 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const voiceFrom = process.env.TWILIO_VOICE_FROM || process.env.TWILIO_PHONE_NUMBER;
const twimlUrl = process.env.TWILIO_VOICE_TWIML_URL;

export const hasVoiceConfig = !!(accountSid && authToken && voiceFrom && twimlUrl);

let client: ReturnType<typeof twilio> | null = null;
if (hasVoiceConfig) {
  client = twilio(accountSid, authToken);
}

/**
 * Initiate a Twilio Voice call to the lead's phone number.
 * The TwiML URL should serve instructions that read the opener message.
 *
 * If Twilio Voice is not configured, logs a dry-run message.
 */
export async function makeCall(
  to: string,
  openerMessage: string
): Promise<{ success: boolean; callSid?: string; error?: string }> {
  if (!hasVoiceConfig || !client) {
    console.log(`[VOICE DRY RUN] Would call ${to}. Opener: ${openerMessage}`);
    return { success: true, callSid: 'mock_call_dry_run' };
  }

  try {
    // Append the opener message as a query param so the TwiML endpoint can read it
    const url = new URL(twimlUrl!);
    url.searchParams.set('message', openerMessage.slice(0, 500));

    const call = await client.calls.create({
      to,
      from: voiceFrom!,
      url: url.toString(),
      method: 'GET',
    });

    console.log(`[VOICE SUCCESS] Call to ${to}, SID: ${call.sid}`);
    return { success: true, callSid: call.sid };
  } catch (error) {
    const err = error as Error;
    console.error(`[VOICE ERROR] Failed to call ${to}:`, err.message);
    return { success: false, error: err.message };
  }
}