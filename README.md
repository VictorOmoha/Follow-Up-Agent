# Omoha Follow-Up Agent

MVP for an AI follow-up agent that responds, qualifies, books, and keeps leads warm until they convert, decline, or need a human.

## What is built

- Lead intake form
- Lead scoring engine
- Hot/Warm/Nurture classification
- Five-step follow-up sequence generator
- Money-on-the-table dashboard
- Human approval mode copy for safe demos
- Test coverage for scoring, plan generation, and core UI flow

## Run locally

```bash
cd /home/victor147/.openclaw/workspace/omoha-follow-up-agent
npm install
npm run dev
```

## Verify

```bash
npm test
npm run lint
npm run build
```

## MVP positioning

Promise: We install an AI follow-up agent that replies to your leads in under 60 seconds and keeps following up until they book, decline, or need a human.

Best first verticals:
- roofers and contractors
- clinics and dental offices
- law firm intake
- real estate teams
- agencies and consultants

Next product steps:
1. Add persistence with Firebase or Supabase.
2. Add Twilio SMS draft/send with human approval.
3. Add Google Calendar booking links.
4. Add owner daily digest: money on the table, hot leads, stalled leads.
5. Add CRM/webform webhook ingestion.
