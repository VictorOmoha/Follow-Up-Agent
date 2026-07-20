# OpenAI Build Week 2026 Submission Notes

This document keeps the final Devpost materials, evidence, judge access, and demo flow in one place. Replace every `TBD` before submission.

## Submission facts

- Project: Omoha Follow-Up Agent
- Entrant: Victor Omoha, Omoha Solutions
- Category: Work and Productivity
- Submission deadline: July 21, 2026 at 5:00 p.m. Pacific / 8:00 p.m. Eastern
- Build Week branch: [`build-week-gpt56`](https://github.com/VictorOmoha/Follow-Up-Agent/tree/build-week-gpt56)
- Pre-event baseline: [`ed5b307`](https://github.com/VictorOmoha/Follow-Up-Agent/commit/ed5b3077027771bf861a13f50cb1dc2388e29f45)
- Challenge-period diff: [`main...build-week-gpt56`](https://github.com/VictorOmoha/Follow-Up-Agent/compare/main...build-week-gpt56)
- Judge build URL: `TBD`
- Public demo video URL: `TBD`
- Codex `/feedback` session ID: `TBD`

## One-sentence description

Omoha Follow-Up Agent uses GPT-5.6 to turn unstructured inbound messages into validated lead records, then moves each opportunity through a controlled follow-up workflow so service businesses respond faster and lose fewer leads.

## Short description

Service businesses receive leads through forms, email, referrals, ads, SMS, and CRMs, but those inquiries rarely arrive in a consistent format. Omoha Follow-Up Agent uses GPT-5.6 structured output to extract the prospect, company, requested service, budget, urgency, pain point, preferred channel, and contact information. The existing agent workflow then scores the lead, prepares the follow-up sequence, tracks replies, and keeps the owner in approval mode or an explicitly enabled autopilot mode. If OpenAI is unavailable, the system falls back to the existing provider and then deterministic mapping so lead capture continues.

## Build Week contribution

The product existed before the event. The Build Week submission covers only the GPT-5.6 and Codex extension developed after July 13:

- OpenAI Responses API integration using GPT-5.6
- strict JSON Schema extraction
- untrusted-input boundary and runtime validation
- GPT-5.6 to Gemini to deterministic fallback chain
- Firebase Secret Manager binding
- model/provider attribution in the activity timeline
- focused automated tests and synthetic emulator verification
- Build Week-specific documentation and reproducible setup

## Codex collaboration summary

Codex audited the existing application, traced the canonical webhook ingestion path, created a clean challenge branch, implemented the GPT-5.6 extraction boundary, preserved fallbacks, added secret binding and provider attribution, wrote tests, supported emulator verification, and compared the final branch against the pre-event baseline. Victor made the product decisions, approved full-message processing when OpenAI is configured, required graceful degradation and human control, and selected the recruiting follow-up scenario for the demonstration.

## Suggested demo video, maximum 2:50

### 0:00-0:20 | Problem

"Small service businesses receive leads from many channels, but each message is different. Important details get missed and follow-up stalls."

Show the empty or reset dashboard.

### 0:20-0:45 | Synthetic inbound lead

Send the Triangle Talent Partners webhook payload. Briefly show that it is ordinary free text rather than a pre-structured form.

### 0:45-1:20 | GPT-5.6 result

Show the created lead. Point out the extracted name, company, recruiting workflow, monthly urgency, $3,000 budget, and contact. Show the timeline attribution identifying OpenAI GPT-5.6.

### 1:20-1:55 | Existing workflow receives better data

Show scoring, classification, the follow-up plan, and the owner approval control. Explain that the Build Week extension improves the extraction boundary while preserving established scheduling and safety behavior.

### 1:55-2:20 | Reliability and safety

Show or explain strict JSON Schema, runtime validation, server-side secrets, synthetic data, and the GPT-5.6 to Gemini to deterministic fallback chain.

### 2:20-2:40 | Codex collaboration

Show the branch comparison and tests. Explain how Codex traced the existing architecture, implemented the bounded extension, and helped verify it without rewriting the product.

### 2:40-2:50 | Impact

"Every inbound lead gets captured, understood, and moved toward the right next step, without requiring a small business to hire an SDR."

## Judge-access checklist

- [ ] Deploy the `build-week-gpt56` branch.
- [ ] Confirm the judge URL loads without authentication barriers, or provide test credentials in Devpost.
- [ ] Set `OPENAI_API_KEY` through Firebase Secret Manager.
- [ ] Confirm no real lead or customer data is visible.
- [ ] Reset the app to a clean demo state.
- [ ] Run the synthetic webhook against the deployed URL.
- [ ] Confirm HTTP `201` and the `OpenAI GPT-5.6` timeline entry.
- [ ] Confirm README setup instructions from a fresh checkout.
- [x] Public repository includes the [MIT License](../LICENSE).
- [ ] Record and upload a public video shorter than three minutes.
- [ ] Add the majority-core-work Codex `/feedback` session ID.
- [ ] Submit before 8:00 p.m. Eastern on July 21.

## Final quality check

- [ ] Description distinguishes the pre-event baseline from the Build Week extension.
- [ ] Video shows the new GPT-5.6 behavior, not only the pre-existing dashboard.
- [ ] Claims match the `main...build-week-gpt56` diff.
- [ ] Synthetic data is used throughout.
- [ ] Audio is clear and no unauthorized music, logos, or media are included.
- [ ] Repository, judge build, demo video, and `/feedback` ID are accessible.