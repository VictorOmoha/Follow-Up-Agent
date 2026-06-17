import { scoreLead, buildFollowUpPlan, type LeadInput, type LeadScore } from '../src/lib/agent';

export type LLMScoreResult = LeadScore;

export interface LLMPlanResult {
  summary: string;
  steps: Array<{
    timing: string;
    goal: string;
    message: string;
  }>;
}

export interface LLMReplyResult {
  isBookingIntent: boolean;
  isDecline: boolean;
  draftReply: string;
  reasoning: string;
}

function getApiKey(configKey?: string): string | undefined {
  return configKey?.trim() || process.env.GEMINI_API_KEY?.trim() || undefined;
}

/**
 * Invokes Gemini 2.5 Flash API with JSON mode
 */
async function callGeminiJSON<T>(prompt: string, apiKey: string, systemInstruction?: string): Promise<T> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: prompt }]
      }],
      systemInstruction: systemInstruction ? {
        parts: [{ text: systemInstruction }]
      } : undefined,
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
      }
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API Error: Status ${response.status} - ${errorText}`);
  }

  interface GeminiResponse {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
        }>;
      };
    }>;
  }

  const data = (await response.json()) as GeminiResponse;
  const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!jsonText) {
    throw new Error('No content returned from Gemini API');
  }

  return JSON.parse(jsonText) as T;
}

/**
 * Dynamic lead scoring & triage
 */
export async function analyzeAndScoreLead(lead: LeadInput, configKey?: string): Promise<LLMScoreResult> {
  const apiKey = getApiKey(configKey);
  if (!apiKey) {
    console.log('[GEMINI SERVICE] No API key. Falling back to rules-based scoring.');
    return scoreLead(lead);
  }

  try {
    const prompt = `
Analyze the following inbound lead request and score it on a scale of 0 to 100 based on fit, budget size, urgency, and revenue loss pain.

Lead Details:
Name: ${lead.name || 'Unknown'}
Company: ${lead.company || 'Unknown'}
Requested Service: ${lead.service || 'Unknown'}
Stated Budget: ${lead.budget || 'unknown'}
Stated Urgency/Timeline: ${lead.urgency || 'unknown'}
Stated Pain Point/Description: ${lead.pain || 'none'}

Return a JSON object matching this schema:
{
  "score": number (0 to 100),
  "temperature": "Hot" | "Warm" | "Nurture",
  "reasons": string[], (list of concise reasons, e.g. ["High budget specified", "Immediate timeline requested"])
  "nextAction": string (recommended next step for the owner or agent)
}
    `;

    const systemInstruction = 'You are a professional lead qualification scoring engine. Evaluate the quality of inbound leads accurately.';
    const result = await callGeminiJSON<LLMScoreResult>(prompt, apiKey, systemInstruction);

    // Validate structure
    if (typeof result.score !== 'number' || !['Hot', 'Warm', 'Nurture'].includes(result.temperature) || !Array.isArray(result.reasons)) {
      throw new Error('Invalid JSON response format from Gemini');
    }

    console.log(`[GEMINI SERVICE] Lead scored dynamically: ${result.score} (${result.temperature})`);
    return result;
  } catch (error) {
    console.error('[GEMINI SERVICE] Scoring failed. Falling back to rules-based scoring:', error);
    return scoreLead(lead);
  }
}

/**
 * Personalized 5-Step Follow-Up Plan
 */
export async function generateFollowUpPlan(lead: LeadInput, bookingLink: string, configKey?: string): Promise<LLMPlanResult> {
  const apiKey = getApiKey(configKey);
  if (!apiKey) {
    console.log('[GEMINI SERVICE] No API key. Falling back to rules-based plan generation.');
    const standardPlan = buildFollowUpPlan(lead, bookingLink);
    return {
      summary: standardPlan.summary,
      steps: standardPlan.steps,
    };
  }

  try {
    const prompt = `
Create a personalized 5-step follow-up plan for this lead.
Lead Name: ${lead.name || 'there'}
Company: ${lead.company || 'the business'}
Service: ${lead.service || 'your request'}
Budget: ${lead.budget || 'unknown'}
Urgency: ${lead.urgency || 'unknown'}
Pain Point: ${lead.pain || 'none'}
Calendar Booking Link: ${bookingLink}

The follow-up plan consists of exactly 5 steps:
1. "0-60 seconds": Goal is instant outreach to prevent lead decay.
2. "5 minutes": Goal is to qualify pain, timeline, and decision path.
3. "2 hours": Goal is to offer the booking link without sounding desperate. Include the link "${bookingLink}" naturally.
4. "24 hours": Goal is to revive the lead with value or a gentle checkout.
5. "72 hours": Goal is to close the loop cleanly.

Generate a natural, professional, custom message for each step. Avoid generic placeholders like "[My Name]" since they will be sent directly. The sender is "Omoha Follow-Up Agent".

Return a JSON object matching this schema:
{
  "summary": string (a one-line summary of the lead's service need and score),
  "steps": [
    {
      "timing": "0-60 seconds",
      "goal": "Acknowledge instantly and prevent lead decay",
      "message": string
    },
    {
      "timing": "5 minutes",
      "goal": "Qualify pain, timeline, and decision path",
      "message": string
    },
    {
      "timing": "2 hours",
      "goal": "Offer booking without sounding desperate",
      "message": string
    },
    {
      "timing": "24 hours",
      "goal": "Revive the lead with value",
      "message": string
    },
    {
      "timing": "72 hours",
      "goal": "Close the loop cleanly",
      "message": string
    }
  ]
}
    `;

    const systemInstruction = 'You are a premium follow-up writer. Write natural, helpful, copywriter-grade outreach messages.';
    const result = await callGeminiJSON<LLMPlanResult>(prompt, apiKey, systemInstruction);

    if (!result.summary || !Array.isArray(result.steps) || result.steps.length !== 5) {
      throw new Error('Invalid JSON plan format from Gemini');
    }

    console.log(`[GEMINI SERVICE] Custom 5-step plan generated dynamically.`);
    return result;
  } catch (error) {
    console.error('[GEMINI SERVICE] Plan generation failed. Falling back to template-based planning:', error);
    const standardPlan = buildFollowUpPlan(lead, bookingLink);
    return {
      summary: standardPlan.summary,
      steps: standardPlan.steps,
    };
  }
}

/**
 * Conversational Reply Analysis
 */
export async function analyzeReply(
  lead: LeadInput,
  replyBody: string,
  history: Array<{ direction: 'outbound' | 'inbound'; body: string }>,
  configKey?: string
): Promise<LLMReplyResult> {
  const apiKey = getApiKey(configKey);
  if (!apiKey) {
    console.log('[GEMINI SERVICE] No API key. Falling back to rules-based reply analysis.');
    const isBooking = /\b(yes|works|book|schedule|tomorrow|today|available|call|appointment|10|3:30)\b/i.test(replyBody);
    const isDecline = /\b(stop|unsubscribe|no|not interested|remove|optout|cancel)\b/i.test(replyBody);
    return {
      isBookingIntent: isBooking,
      isDecline: isDecline,
      reasoning: 'Rules-based regex matched keywords.',
      draftReply: isBooking
        ? 'Great! Looking forward to it. If you need anything else, just let me know.'
        : 'Understood. I will stop following up.',
    };
  }

  try {
    const historyText = history.map(h => `${h.direction.toUpperCase()}: ${h.body}`).join('\n');
    const prompt = `
Analyze the incoming message from the lead in the context of the conversation history.

Lead Name: ${lead.name || 'there'}
Requested Service: ${lead.service || 'unknown'}

Conversation History (oldest first):
${historyText || 'No history yet.'}

Incoming Lead Reply:
"${replyBody}"

Determine:
1. "isBookingIntent": true if the lead wants to schedule a call, agrees to a meeting slot, asks for booking links, says they booked, or wants to talk on the phone.
2. "isDecline": true if they tell you to stop, say they are not interested, say no, ask to be removed, or decline the offer.
3. "draftReply": A short, natural follow-up response to send back to them. If it is booking intent, acknowledge and provide helpful booking details. If decline, acknowledge it politely.
4. "reasoning": A short explanation of your classification.

Return a JSON object matching this schema:
{
  "isBookingIntent": boolean,
  "isDecline": boolean,
  "draftReply": string,
  "reasoning": string
}
    `;

    const systemInstruction = 'You are an AI inbox assistant. Classify lead replies accurately and draft concise, helpful replies.';
    const result = await callGeminiJSON<LLMReplyResult>(prompt, apiKey, systemInstruction);

    if (typeof result.isBookingIntent !== 'boolean' || typeof result.isDecline !== 'boolean' || !result.draftReply) {
      throw new Error('Invalid JSON reply analysis format from Gemini');
    }

    console.log(`[GEMINI SERVICE] Reply analyzed: booking=${result.isBookingIntent}, decline=${result.isDecline}`);
    return result;
  } catch (error) {
    console.error('[GEMINI SERVICE] Reply analysis failed. Falling back to rules-based analysis:', error);
    const isBooking = /\b(yes|works|book|schedule|tomorrow|today|available|call|appointment|10|3:30)\b/i.test(replyBody);
    const isDecline = /\b(stop|unsubscribe|no|not interested|remove|optout|cancel)\b/i.test(replyBody);
    return {
      isBookingIntent: isBooking,
      isDecline: isDecline,
      reasoning: 'Rules-based regex matched keywords after LLM error.',
      draftReply: isBooking
        ? 'Great! Looking forward to it. If you need anything else, just let me know.'
        : 'Understood. I will stop following up.',
    };
  }
}
