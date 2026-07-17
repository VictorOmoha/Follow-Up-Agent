import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractLeadWithOpenAI } from './openai.js';

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_EXTRACTION_MODEL;
  vi.unstubAllGlobals();
});

describe('extractLeadWithOpenAI', () => {
  it('sends the complete lead payload and returns structured output', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_EXTRACTION_MODEL = 'gpt-5.6-luna';

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    name: 'Jamie Rivera',
                    company: 'Rivera Roofing',
                    service: 'Website redesign',
                    budget: '$5,000',
                    urgency: 'this month',
                    pain: 'Inbound leads cannot find current project examples.',
                    channel: 'Email',
                    contact: 'jamie@example.com',
                  }),
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await extractLeadWithOpenAI(
      'I need a website redesign and my budget is $5,000.',
      'Website inquiry',
      'jamie@example.com'
    );

    expect(result.company).toBe('Rivera Roofing');
    expect(result.channel).toBe('Email');
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(request.headers).toEqual({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    });

    const body = JSON.parse(String(request.body)) as {
      model: string;
      input: string;
      text: { format: { type: string; strict: boolean } };
    };
    expect(body.model).toBe('gpt-5.6-luna');
    expect(body.input).toContain('I need a website redesign');
    expect(body.input).toContain('jamie@example.com');
    expect(body.text.format).toMatchObject({
      type: 'json_schema',
      strict: true,
    });
  });

  it('fails before making a request when the API key is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      extractLeadWithOpenAI('New lead', 'Inquiry', 'lead@example.com')
    ).rejects.toThrow('OPENAI_API_KEY is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
