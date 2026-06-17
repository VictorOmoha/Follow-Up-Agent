import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { analyzeAndScoreLead, generateFollowUpPlan, analyzeReply } from './gemini';
import { scoreLead, buildFollowUpPlan } from '../src/lib/agent';

const mockLead = {
  name: 'John Test',
  company: 'Test Company',
  service: 'roof repair',
  budget: '4000',
  urgency: 'ASAP',
  pain: 'roof leaking',
  channel: 'Email' as const,
  contact: 'john@test.com',
};

describe('gemini service fallbacks and integrations', () => {
  beforeEach(() => {
    vi.stubEnv('GEMINI_API_KEY', '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to rules-based lead scoring when no API key is present', async () => {
    const score = await analyzeAndScoreLead(mockLead);
    const expected = scoreLead(mockLead);
    expect(score.score).toBe(expected.score);
    expect(score.temperature).toBe(expected.temperature);
  });

  it('falls back to template-based follow-up plan when no API key is present', async () => {
    const plan = await generateFollowUpPlan(mockLead, 'http://booking-link');
    const expected = buildFollowUpPlan(mockLead, 'http://booking-link');
    expect(plan.summary).toBe(expected.summary);
    expect(plan.steps).toHaveLength(expected.steps.length);
    expect(plan.steps[0].message).toBe(expected.steps[0].message);
  });

  it('falls back to regex-based reply analysis when no API key is present', async () => {
    const reply1 = await analyzeReply(mockLead, 'Yes, let us book a call for tomorrow morning.', []);
    expect(reply1.isBookingIntent).toBe(true);
    expect(reply1.isDecline).toBe(false);

    const reply2 = await analyzeReply(mockLead, 'please stop messaging me, unsubscribe', []);
    expect(reply2.isBookingIntent).toBe(false);
    expect(reply2.isDecline).toBe(true);
  });

  it('calls live API when API key is provided and parses JSON successfully', async () => {
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        score: 95,
                        temperature: 'Hot',
                        reasons: ['High budget', 'ASAP timeframe'],
                        nextAction: 'Call immediately',
                      }),
                    },
                  ],
                },
              },
            ],
          }),
      })
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await analyzeAndScoreLead(mockLead, 'test-key');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('test-key');
    expect(result.score).toBe(95);
    expect(result.temperature).toBe('Hot');
    expect(result.reasons).toContain('High budget');
  });

  it('falls back to rules-based scoring if Gemini fetch fails', async () => {
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      })
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await analyzeAndScoreLead(mockLead, 'test-key');
    const expected = scoreLead(mockLead);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.score).toBe(expected.score);
  });
});
