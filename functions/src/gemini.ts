import { scoreLead, buildFollowUpPlan, type LeadInput, type LeadScore } from './shared/agent.js';

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
    const isDecline = /\b(stop|unsubscribe|no thanks|not interested|remove me|optout|opt-out|cancel|do not contact|don't contact)\b/i.test(replyBody);
    const draftReply = isBooking
      ? 'Great! Looking forward to it. If you need anything else, just let me know.'
      : isDecline
        ? 'Understood. I will stop following up.'
        : 'Thanks for getting back to me. What would be the best time to connect for a quick call?';
    return {
      isBookingIntent: isBooking,
      isDecline: isDecline,
      reasoning: 'Rules-based regex matched keywords.',
      draftReply,
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
    const isDecline = /\b(stop|unsubscribe|no thanks|not interested|remove me|optout|opt-out|cancel|do not contact|don't contact)\b/i.test(replyBody);
    return {
      isBookingIntent: isBooking,
      isDecline: isDecline,
      reasoning: 'Rules-based regex matched keywords after LLM error.',
      draftReply: isBooking
        ? 'Great! Looking forward to it. If you need anything else, just let me know.'
        : isDecline
          ? 'Understood. I will stop following up.'
          : 'Thanks for getting back to me. What would be the best time to connect for a quick call?',
    };
  }
}

export interface LLMExtractedLead {
  name: string;
  company: string;
  service: string;
  budget: string;
  urgency: string;
  pain: string;
  channel: 'Email' | 'SMS' | 'Call';
  contact: string;
}

function fieldFromEmail(body: string, field: string, fallback = '') {
  const match = body.match(new RegExp(`${field}:\\s*(.+)`, 'i'));
  return match?.[1]?.trim() || fallback;
}

function getStringField(record: Record<string, unknown>, keys: string[], fallback = '') {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return fallback;
}

function fallbackExtractLead(text: string, subject?: string, fromEmail?: string): LLMExtractedLead {
  let jsonRecord: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      jsonRecord = parsed as Record<string, unknown>;
    }
  } catch {
    jsonRecord = undefined;
  }

  // If we have a JSON record, use structured field mapping
  if (jsonRecord) {
    // Check if the JSON has any standard lead fields. If it only has a "message"
    // or "body" field, treat that as free text and fall through to heuristics.
    const hasStandardFields = ['name', 'fullName', 'firstName', 'lastName', 'company', 'org', 'organization',
      'service', 'requestedService', 'interest', 'budget', 'budgetAmount', 'value',
      'urgency', 'timeframe', 'timeline', 'pain', 'description', 'notes',
      'channel', 'preferredChannel', 'contact', 'email', 'phone'].some(key => {
      const v = jsonRecord[key];
      return v !== undefined && v !== null && String(v).trim();
    });

    if (hasStandardFields) {
      const firstLast = [jsonRecord.firstName, jsonRecord.lastName].filter(Boolean).map(String).join(' ').trim();
      const name = getStringField(jsonRecord, ['name', 'fullName'], firstLast || fromEmail?.split('@')[0] || 'Unknown Lead');
      const company = getStringField(jsonRecord, ['company', 'org', 'organization'], fromEmail?.split('@')[0] || 'Self-Employed');
      const service = getStringField(jsonRecord, ['service', 'requestedService', 'interest'], subject || 'General Inquiry');
      const budget = getStringField(jsonRecord, ['budget', 'budgetAmount', 'value'], 'unknown');
      const urgency = getStringField(jsonRecord, ['urgency', 'timeframe', 'timeline'], 'unknown');
      const pain = getStringField(jsonRecord, ['pain', 'description', 'message', 'notes'], subject || 'No pain described');
      const contact = getStringField(jsonRecord, ['contact', 'email', 'phone'], fromEmail || 'none');

      let channel: 'Email' | 'SMS' | 'Call' = 'Email';
      const rawChannel = getStringField(jsonRecord, ['channel', 'preferredChannel'], '').toUpperCase();
      if (rawChannel === 'SMS') channel = 'SMS';
      else if (rawChannel === 'CALL') channel = 'Call';

      return { name, company, service, budget, urgency, pain, channel, contact };
    }

    // JSON only has a message/body/text field - extract that and use free-text heuristics
    const messageText = getStringField(jsonRecord, ['message', 'body', 'text', 'content', 'description'], '');
    if (messageText) {
      // Fall through to free-text heuristics with the extracted message
      return fallbackExtractLead(messageText, subject, fromEmail);
    }
  }

  // No JSON: try "Field: value" format first, then fall back to free-text heuristics
  const name = fieldFromEmail(text, 'Name', '');
  const company = fieldFromEmail(text, 'Company', '');
  const service = fieldFromEmail(text, 'Service', '');
  const budget = fieldFromEmail(text, 'Budget', '');
  const urgency = fieldFromEmail(text, 'Urgency', '');
  const pain = fieldFromEmail(text, 'Pain', '');

  // If "Field: value" patterns were found, use them
  if (name || company || service) {
    let channel: 'Email' | 'SMS' | 'Call' = 'Email';
    const rawChannel = fieldFromEmail(text, 'Channel', '').toUpperCase();
    if (rawChannel === 'SMS') channel = 'SMS';
    else if (rawChannel === 'CALL') channel = 'Call';

    return {
      name: name || fromEmail?.split('@')[0] || 'Unknown Lead',
      company: company || fromEmail?.split('@')[0] || 'Self-Employed',
      service: service || subject || 'General Inquiry',
      budget: budget || 'unknown',
      urgency: urgency || 'unknown',
      pain: pain || subject || text.slice(0, 200),
      channel,
      contact: fromEmail || 'none',
    };
  }

  // Free-text heuristics for unstructured messages
  const lowerText = text.toLowerCase();

  // Extract name: look for "I'm X", "my name is X", "this is X", "I am X"
  let extractedName = '';
  const namePatterns = [
    /i['']?m\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    /my name is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    /this is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    /i am\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+))/,
  ];
  for (const pattern of namePatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      extractedName = match[1].trim();
      break;
    }
  }

  // Extract company: look for "from X", "X company", "X LLC", "X Inc", "X Corp"
  let extractedCompany = '';
  const companyPatterns = [
    /from\s+([A-Z][A-Za-z0-9&\s]+?)(?:\.|\,|$)/,
    /([A-Z][A-Za-z0-9&\s]+?)\s+(?:LLC|Inc|Corp|Corporation|Company|Co\.|Group|Firm|Dental|Law|Roofing|Construction|Services)/,
  ];
  for (const pattern of companyPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      extractedCompany = match[1].trim();
      break;
    }
  }

  // Extract budget: look for dollar amounts or "budget is X"
  let extractedBudget = '';
  const budgetMatch = text.match(/\$?\s*([\d,]+)\s*(?:dollars|k|thousand|budget|budget is)/i);
  const budgetMatch2 = text.match(/budget(?:\s+is)?(?:\s+around|\s+about)?\s*:?\s*\$?\s*([\d,]+)/i);
  if (budgetMatch2?.[1]) extractedBudget = budgetMatch2[1];
  else if (budgetMatch?.[1]) extractedBudget = budgetMatch[1];

  // Extract urgency: look for urgency keywords
  let extractedUrgency = '';
  if (/\basap\b|urgent|immediately|right away|emergency/i.test(text)) extractedUrgency = 'ASAP';
  else if (/this week|this month|soon|next week|next month/i.test(text)) extractedUrgency = text.match(/(this week|this month|soon|next week|next month)/i)?.[0] || 'soon';
  else if (/whenever|no rush|not urgent/i.test(text)) extractedUrgency = 'whenever';

  // Extract email or phone for contact
  let extractedContact = fromEmail || '';
  const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (emailMatch?.[0]) extractedContact = emailMatch[0];
  const phoneMatch = text.match(/(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  if (phoneMatch?.[0] && !extractedContact) extractedContact = phoneMatch[0];

  return {
    name: extractedName || fromEmail?.split('@')[0] || 'Unknown Lead',
    company: extractedCompany || fromEmail?.split('@')[0] || 'Self-Employed',
    service: subject || 'General Inquiry',
    budget: extractedBudget || 'unknown',
    urgency: extractedUrgency || 'unknown',
    pain: text.slice(0, 300),
    channel: phoneMatch?.[0] ? 'SMS' : 'Email',
    contact: extractedContact || 'none',
  };
}

/**
 * Extract structured lead data from any unstructured text, email, booking form note, CRM body, or ad payload.
 */
export async function extractLeadFromText(
  text: string,
  subject?: string,
  fromEmail?: string,
  configKey?: string
): Promise<LLMExtractedLead> {
  const apiKey = getApiKey(configKey);
  if (!apiKey) {
    console.log('[GEMINI SERVICE] No API key. Falling back to rules-based lead extraction.');
    return fallbackExtractLead(text, subject, fromEmail);
  }

  try {
    const prompt = `
You are a lead extraction assistant. Extract structured details from the following unstructured text, email, contact form, CRM payload, booking form note, or ad lead form.

Subject/Metadata info: ${subject || 'none'}
Contact/Sender info: ${fromEmail || 'unknown'}

Text/Payload Content:
"""
${text}
"""

Analyze the text carefully. Map the fields as follows:
1. name: Extract the lead's full name. If not found, try to infer from the email/text or use 'Unknown Lead'.
2. company: Extract the lead's company or organization. If not found, use 'Self-Employed' or 'Unknown'.
3. service: Identify the service requested (e.g. Legal, web development, immigration).
4. budget: Extract any budget numbers or estimates. If not found, use 'unknown'.
5. urgency: Extract the timeline or urgency mentioned (e.g., ASAP, next month, next week). If not found, use 'unknown'.
6. pain: Extract the main pain point, problem, or description of what they need help with.
7. channel: "Email" or "SMS" or "Call". Default to "Email" if not specified.
8. contact: Extract the email address or phone number. Default to the provided contact/sender info if not explicitly overridden.

Return a JSON object matching this schema:
{
  "name": string,
  "company": string,
  "service": string,
  "budget": string,
  "urgency": string,
  "pain": string,
  "channel": "Email" | "SMS" | "Call",
  "contact": string
}
    `;

    const systemInstruction = 'You are a professional lead extraction agent. Extract structured details from unstructured contact forms, emails, booking notes, and CRM inputs.';
    const result = await callGeminiJSON<LLMExtractedLead>(prompt, apiKey, systemInstruction);

    return {
      name: result.name || 'Unknown Lead',
      company: result.company || 'Self-Employed',
      service: result.service || 'General Inquiry',
      budget: String(result.budget || 'unknown'),
      urgency: result.urgency || 'unknown',
      pain: result.pain || 'No pain described',
      channel: result.channel || 'Email',
      contact: result.contact || fromEmail || 'none',
    };
  } catch (error) {
    console.error('[GEMINI SERVICE] Lead extraction failed. Falling back to rules-based extraction:', error);
    return fallbackExtractLead(text, subject, fromEmail);
  }
}

