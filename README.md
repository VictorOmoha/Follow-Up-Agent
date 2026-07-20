# Omoha Follow-Up Agent

An AI-assisted lead operations system for service businesses. It captures inbound inquiries, turns unstructured messages into structured lead records, prioritizes opportunities, prepares follow-up sequences, tracks replies, and keeps the business owner in control of what is sent.

Built by [Omoha Solutions](https://omohasolutions.com/) for OpenAI Build Week 2026.

## Links

- Existing product demo: [omoha-followup-agent-mvp.web.app](https://omoha-followup-agent-mvp.web.app/)
- Walkthrough guide: [omoha-followup-agent-mvp.web.app/demo-guide.html](https://omoha-followup-agent-mvp.web.app/demo-guide.html)
- Build Week branch: [`build-week-gpt56`](https://github.com/VictorOmoha/Follow-Up-Agent/tree/build-week-gpt56)
- Build Week change evidence: [`main...build-week-gpt56`](https://github.com/VictorOmoha/Follow-Up-Agent/compare/main...build-week-gpt56)

> The public demo above predates the Build Week deployment. Use the Build Week branch and local setup below to review the GPT-5.6 extension until the judge build is deployed.

## The problem

Small service businesses receive leads through forms, email, referrals, ads, SMS, and CRM webhooks. Those inquiries often arrive as inconsistent free text. An owner or small team must manually identify the prospect, understand what they need, judge urgency, decide the next step, and remember every follow-up.

The Follow-Up Agent creates a consistent operating workflow:

1. Capture the inbound message.
2. Extract a structured lead record.
3. Score and classify the opportunity.
4. Prepare a follow-up plan.
5. Keep the owner in approval mode or run an explicitly enabled autopilot workflow.
6. Detect replies, booking intent, and opt-outs.
7. Surface the next owner action and the value still in the pipeline.

## Build Week eligibility and scope

This project existed before OpenAI Build Week. The submission is based only on the meaningful GPT-5.6 and Codex extension developed after the challenge opened on July 13, 2026.

### Pre-Build Week baseline

The baseline is the `main` branch at commit [`ed5b307`](https://github.com/VictorOmoha/Follow-Up-Agent/commit/ed5b3077027771bf861a13f50cb1dc2388e29f45), dated July 1, 2026. It already included:

- React dashboard and manual lead intake
- CRM, webform, inbound-email, Gmail, and Twilio ingestion paths
- Rules-based scoring with optional Gemini scoring and plan generation
- Hot, Warm, and Nurture classification
- Five-step follow-up scheduling
- Draft-only approval and explicitly enabled autopilot modes
- Reply handling, booking escalation, and opt-out enforcement
- Firestore persistence, scheduled workers, rate limiting, and API redaction
- Lead deduplication, activity timelines, owner digest, and pipeline-value dashboard

### Added during Build Week

The [`build-week-gpt56`](https://github.com/VictorOmoha/Follow-Up-Agent/tree/build-week-gpt56) branch adds:

- GPT-5.6 lead extraction through the OpenAI Responses API
- Strict JSON Schema output for eight required lead fields
- Full-message extraction from inbound CRM and webform payloads
- Explicit prompt-injection boundaries that treat lead content as untrusted data
- Runtime validation before model output enters the agent workflow
- A resilient provider chain: GPT-5.6, then the existing Gemini extractor, then deterministic field mapping
- Server-side `OPENAI_API_KEY` binding through Firebase Secret Manager
- A configurable `OPENAI_EXTRACTION_MODEL`, defaulting to `gpt-5.6-luna`
- Webhook timeline annotation identifying OpenAI GPT-5.6 when the OpenAI extraction path is configured
- Focused Vitest coverage for the OpenAI request, structured output, complete-payload handling, and missing-secret behavior

Only the additions in this section are presented as Build Week work.

## How GPT-5.6 is used

The first high-leverage decision in a follow-up workflow is converting an inconsistent inbound message into reliable structured data. GPT-5.6 receives the message, optional subject, and sender metadata through the Responses API and returns:

```json
{
  "name": "Dana Brooks",
  "company": "Triangle Talent Partners",
  "service": "Recruiting follow-up automation",
  "budget": "$3,000",
  "urgency": "this month",
  "pain": "Recruiters lose track of screening follow-ups and interview reminders.",
  "channel": "Email",
  "contact": "dana@triangletalent.example"
}
```

The response must conform to a strict JSON Schema with no additional properties. The application validates the parsed result again at runtime before passing it to the existing agent engine.

The model instructions also establish a trust boundary: inbound content is data, not executable instruction. Missing values use explicit defaults instead of fabricated facts.

## Architecture

```text
Forms / CRM / Email / SMS
            |
            v
Express API on Firebase Cloud Functions
            |
            v
Lead extraction orchestrator
  1. OpenAI Responses API with GPT-5.6
  2. Existing Gemini extractor on OpenAI failure
  3. Deterministic mapper when no model is available
            |
            v
Agent engine
  scoring -> classification -> follow-up plan -> approval/autopilot
            |
            +----> Firestore state and activity timeline
            |
            +----> React owner dashboard
```

The Build Week work deliberately extends the extraction boundary rather than rewriting the complete application. This keeps the existing scheduling, compliance, delivery, and human-approval behavior stable while improving the quality of the data entering those systems.

## Engineering decisions

### 1. Extend the existing product instead of rebuilding it

The goal was a production-oriented extension with a traceable diff. All challenge work lives on a dedicated branch created from the last pre-Build Week `main` commit.

### 2. Send the complete inbound message

The system sends the full inbound lead message to GPT-5.6 because budget, urgency, service need, contact information, and pain often appear in different parts of the same inquiry. The user explicitly controls whether an OpenAI key is configured. Synthetic data is used for demos and evaluation.

### 3. Require structured output

Strict JSON Schema output and runtime validation prevent downstream agent code from depending on loosely formatted model text.

### 4. Preserve graceful degradation

Lead capture must not stop because one model or network request fails. The OpenAI path therefore sits in front of the existing Gemini and deterministic extraction paths. Each fallback preserves the original product behavior.

### 5. Keep secrets server-side

`OPENAI_API_KEY` is a Firebase secret bound only to functions that may process inbound leads. It is not accepted from the browser and is not returned through the public state API.

### 6. Keep high-impact actions under existing controls

The GPT-5.6 extension structures inbound data. Existing draft approval, explicit autopilot settings, opt-out precedence, task cancellation, and owner escalation remain responsible for outbound actions.

## How Codex was used

Codex served as an engineering collaborator throughout the Build Week extension:

- Audited the existing repository and traced the canonical ingestion path before making changes
- Created the dedicated `build-week-gpt56` branch so the pre-event baseline remained intact
- Helped select lead extraction as the first bounded GPT-5.6 integration
- Implemented the Responses API client and strict JSON Schema contract
- Added prompt-injection boundaries and output validation
- Wired the OpenAI path into the existing fallback chain without removing previous providers
- Bound the production secret to Firebase functions
- Added provider attribution to the activity timeline
- Wrote focused tests and corrected test and timeline issues found during verification
- Compared the Build Week branch against `main` so the submission documentation distinguishes old and new work precisely

Victor retained the key product and engineering decisions: use the existing Follow-Up Agent rather than begin a new product, process complete inbound messages when OpenAI is configured, preserve human approval and fallback behavior, use synthetic evaluation data, and focus the demonstration on a measurable service-business workflow.

## Evaluation

### Verified Build Week checks

| Check | Result | Scope |
|---|---|---|
| Focused OpenAI unit tests | Passed, 2 of 2 | Structured request and response handling, complete payload, and missing-key behavior |
| Functions TypeScript build | Passed | The new OpenAI module and Firebase integration compile cleanly |
| Synthetic Firebase webhook | Re-run before recording | The command and success criteria below provide the reproducible final check |

### Automated tests included

`functions/src/openai.test.ts` verifies that:

- the complete lead message and sender metadata are sent to the Responses API
- the configured GPT-5.6 model is selected
- strict JSON Schema output is requested
- valid structured output is returned to the application
- a missing `OPENAI_API_KEY` fails before any network request is made

Run the focused function tests:

```bash
cd functions
npm install
npm test
npm run build
```

### Manual emulator evaluation

Start the Firebase emulators from the repository root:

```bash
firebase emulators:start --only functions,firestore,hosting
```

In another terminal, submit a synthetic unstructured lead:

```bash
curl -i -X POST http://127.0.0.1:5000/api/webhooks/lead \
  -H "Content-Type: application/json" \
  --data-binary '{
    "message": "Hi, my name is Dana Brooks. I run Triangle Talent Partners in Raleigh. We receive about 80 candidates each week through email and job boards. Recruiters lose track of screening follow-ups and interview reminders. We want to test an automated follow-up workflow this month. Our initial budget is around $3,000. Contact me at dana@triangletalent.example."
  }'
```

If `WEBHOOK_API_KEY` is configured, include the header required by your local configuration.

Success criteria:

- HTTP `201`
- a structured lead with the expected name, company, need, budget, urgency, and contact
- a created lead and follow-up plan in the response
- an activity-timeline entry identifying `OpenAI GPT-5.6` as the mapper
- no real customer or production lead data used in the evaluation

## Local setup

### Prerequisites

- Node.js 22
- npm
- Firebase CLI for emulator or deployment workflows
- OpenAI API key for the Build Week extraction path

### Install

```bash
git clone https://github.com/VictorOmoha/Follow-Up-Agent.git
cd Follow-Up-Agent
git switch build-week-gpt56
npm install
cd functions
npm install
cd ..
```

### Configure

Create a local `.env` file or export the variables in your shell:

```bash
OPENAI_API_KEY=your_openai_api_key
OPENAI_EXTRACTION_MODEL=gpt-5.6-luna
BOOKING_LINK=https://your-booking-link.example
```

Optional integrations:

```bash
GEMINI_API_KEY=your_optional_fallback_key
GMAIL_CLIENT_ID=your_gmail_client_id
GMAIL_CLIENT_SECRET=your_gmail_client_secret
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_PHONE_NUMBER=your_twilio_number
WEBHOOK_API_KEY=your_optional_webhook_key
```

Never commit `.env` files or secret values.

For Firebase deployment, store the OpenAI key in Secret Manager:

```bash
firebase functions:secrets:set OPENAI_API_KEY
```

### Run the local application

```bash
npm run dev
```

- Frontend: `http://127.0.0.1:5173/`
- Local API: `http://127.0.0.1:8787/api/state`

### Run the Firebase stack

```bash
npm run build
cd functions
npm run build
cd ..
firebase emulators:start --only functions,firestore,hosting
```

- Hosting emulator: `http://127.0.0.1:5000/`
- Functions emulator: `http://127.0.0.1:5001/`

## Existing product capabilities

- Manual, CRM, webform, email, Gmail, and SMS lead intake
- Lead scoring and Hot, Warm, or Nurture classification
- Five-step follow-up sequences with plan-aligned timing
- Draft-only human approval and explicitly enabled autopilot modes
- Email and SMS delivery helpers with dry-run support
- Reply intelligence for booking, neutral responses, declines, and opt-outs
- Lead deduplication and E.164-tolerant phone matching
- Firestore persistence and scheduled follow-up workers
- Activity timeline, owner decision log, daily digest, and pipeline-value dashboard
- Authentication hooks, webhook authentication, rate limiting, and public-state redaction

## Privacy and safety

- The OpenAI path is enabled only when `OPENAI_API_KEY` is configured.
- Complete inbound messages may be sent to the OpenAI API when that path is enabled.
- Demo and evaluation payloads should contain synthetic data only.
- Inbound text is explicitly treated as untrusted data.
- Model output is constrained by JSON Schema and validated again at runtime.
- Secrets remain server-side.
- Existing human approval and opt-out controls remain in force.

## Repository guide

```text
functions/src/openai.ts       GPT-5.6 Responses API integration
functions/src/openai.test.ts  Focused OpenAI integration tests
functions/src/gemini.ts       Extraction orchestration and fallbacks
functions/src/index.ts        Webhook routes and provider attribution
functions/src/firebase.ts     Firebase function and secret bindings
functions/src/agent-engine.ts Existing workflow and state engine
src/                          React owner dashboard
public/demo-guide.html        Shareable product walkthrough
```

## Build Week submission notes

The demo video, judge-access checklist, evidence links, and final submission fields are tracked in [`docs/build-week-submission.md`](docs/build-week-submission.md).

## Positioning

**Promise:** Every inbound lead is captured, understood, and moved toward the right next step without forcing a small business owner to hire an SDR or constantly monitor every channel.

Initial target workflows include staffing and recruiting agencies, consultants, marketing agencies, contractors, clinics, law-firm intake, and other service businesses where delayed follow-up means lost revenue.

## License

Copyright (c) 2026 Victor Omoha. Released under the [MIT License](LICENSE).
