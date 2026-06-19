# Omoha Follow-Up Agent

AI follow-up agent MVP for service businesses. It captures inbound leads, scores urgency/value, drafts or sends first responses, schedules follow-ups, imports email leads, accepts CRM/webform webhooks, and surfaces the next owner action.

## What is built

- Manual lead intake form
- Rules-based lead scoring with optional Gemini GenAI scoring
- Universal lead extraction from unstructured emails/webhooks with Gemini and deterministic fallbacks
- Hot/Warm/Nurture classification
- Five-step follow-up sequence generator
- Draft-only human approval mode for safe demos
- Autopilot mode for auto-send / dry-run follow-up workflows
- Twilio SMS send helper with dry-run fallback
- Email and call delivery timeline logging for demo/ops visibility
- Gmail OAuth readiness flow, mock Gmail connection, and inbox sync
- CRM/webform webhook ingestion endpoint
- Editable booking link used inside follow-up plans
- Money-on-the-table dashboard and owner daily digest
- Public API state redaction so secrets/tokens do not leak to the browser
- Test coverage for scoring, planning, extraction, webhook intake, inbox sync, autopilot, and UI flow

## Run locally

```bash
npm install
npm run dev
```

Frontend:

```text
http://127.0.0.1:5173/
```

API:

```text
http://127.0.0.1:8787/api/state
```

## Verify

```bash
npm test
npm run lint
npm run build
```

## Useful demo actions

1. Click **Clear backend state** for a fresh demo.
2. Create a lead manually from **Lead Trigger**.
3. Use **Approve & Send** in draft-only mode, or enable **Autopilot** to auto-send/dry-run.
4. Connect a `.demo` inbox like `owner@omohasolutions.demo`, then click **Sync inbox now**.
5. POST an external lead to:

```text
http://127.0.0.1:8787/api/webhooks/lead
```

Example webhook payload:

```json
{
  "firstName": "Maya",
  "lastName": "Johnson",
  "org": "Johnson Roofing",
  "requestedService": "roof repair estimate",
  "budgetAmount": 3500,
  "timeframe": "this week",
  "message": "web leads are not answered quickly",
  "preferredChannel": "SMS",
  "phone": "+15551234567"
}
```

## Optional environment variables

```bash
# App/API
AGENT_API_PORT=8787
BOOKING_LINK=https://calendar.google.com/calendar/appointments/schedules/demo
OWNER_BOOKING_LINK=https://calendar.google.com/calendar/appointments/schedules/demo
VITE_API_BASE_URL=http://127.0.0.1:8787/api

# Gemini
GEMINI_API_KEY=...

# Gmail OAuth
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...

# Twilio SMS
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=...

# Firestore persistence, optional depending on local credentials
GOOGLE_APPLICATION_CREDENTIALS=...
FIRESTORE_PROJECT_ID=...
```

If Gemini or Twilio are not configured, the app still runs using rules-based intelligence and dry-run delivery.

## MVP positioning

Promise: We install an AI follow-up agent that replies to your leads quickly and keeps following up until they book, decline, or need a human.

Best first verticals:

- roofers and contractors
- clinics and dental offices
- law firm intake
- real estate teams
- agencies and consultants
