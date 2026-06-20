import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { analyzeAndScoreLead, generateFollowUpPlan, analyzeReply, extractLeadFromText } from './gemini';
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

  describe('extractLeadFromText', () => {
    it('falls back to rules-based extraction when no API key is present', async () => {
      const emailBody = 'Name: Ada Okafor\nCompany: Ada Legal\nService: Immigration\nBudget: 5000\nUrgency: ASAP\nPain: slow lawyer';
      const result = await extractLeadFromText(emailBody, 'New Lead Inquiry', 'ada@example.com');
      
      expect(result.name).toBe('Ada Okafor');
      expect(result.company).toBe('Ada Legal');
      expect(result.service).toBe('Immigration');
      expect(result.budget).toBe('5000');
      expect(result.urgency).toBe('ASAP');
      expect(result.pain).toBe('slow lawyer');
      expect(result.contact).toBe('ada@example.com');
      expect(result.channel).toBe('Email');
    });

    it('maps common JSON webhook fields without Gemini', async () => {
      const payload = JSON.stringify({
        firstName: 'Maya',
        lastName: 'Johnson',
        org: 'Johnson Roofing',
        requestedService: 'roof repair estimate',
        budgetAmount: 3500,
        timeframe: 'this week',
        message: 'web leads are not answered quickly',
        preferredChannel: 'SMS',
        phone: '+15551234567',
      });

      const result = await extractLeadFromText(payload, 'CRM Webhook Intake');

      expect(result.name).toBe('Maya Johnson');
      expect(result.company).toBe('Johnson Roofing');
      expect(result.service).toBe('roof repair estimate');
      expect(result.budget).toBe('3500');
      expect(result.urgency).toBe('this week');
      expect(result.pain).toBe('web leads are not answered quickly');
      expect(result.channel).toBe('SMS');
      expect(result.contact).toBe('+15551234567');
    });

    it('calls live API when API key is provided and parses lead successfully', async () => {
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
                          name: 'Sarah Smith',
                          company: 'Smith LLC',
                          service: 'Contract Review',
                          budget: '1500',
                          urgency: 'Next week',
                          pain: 'Need help reviewing a vendor agreement.',
                          channel: 'SMS',
                          contact: '+123456789',
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

      const result = await extractLeadFromText(
        'Vendor agreement help needed. Sarah Smith from Smith LLC. Call me at +123456789. Budget 1500, next week timeline.',
        'Help',
        'sarah@smith.com',
        'test-key'
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.name).toBe('Sarah Smith');
      expect(result.company).toBe('Smith LLC');
      expect(result.service).toBe('Contract Review');
      expect(result.budget).toBe('1500');
      expect(result.urgency).toBe('Next week');
      expect(result.pain).toBe('Need help reviewing a vendor agreement.');
      expect(result.channel).toBe('SMS');
      expect(result.contact).toBe('+123456789');
    });

    it('falls back to rules-based extraction if Gemini fetch fails', async () => {
      const mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve('Error'),
        })
      );
      vi.stubGlobal('fetch', mockFetch);

      const emailBody = 'Name: Ada Okafor\nCompany: Ada Legal\nService: Immigration\nBudget: 5000\nUrgency: ASAP\nPain: slow lawyer';
      const result = await extractLeadFromText(emailBody, 'Inquiry', 'ada@example.com', 'test-key');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.name).toBe('Ada Okafor');
      expect(result.budget).toBe('5000');
    });
  });
});

