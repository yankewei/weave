import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { streamText } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandCodeTaskProposalModel } from './task-proposal-model.js';

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return { ...actual, streamText: vi.fn() };
});

describe('Command Code task proposal model', () => {
  const model = new CommandCodeTaskProposalModel();

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('refuses to call the model when the server key is missing', async () => {
    vi.stubEnv('CMD_API_KEY', '');
    await expect(
      model.stream([{ role: 'user', content: '做登录' }], () => {}),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(streamText).not.toHaveBeenCalled();
  });

  it('streams the reply and reports a failed call', async () => {
    vi.stubEnv('CMD_API_KEY', 'test-key');
    vi.stubEnv('CMD_MODEL', '');
    vi.mocked(streamText).mockReturnValueOnce({
      partialOutputStream: (async function* () {
        yield { reply: '拆' };
        yield { reply: '拆成一项。', tasks: [] };
      })(),
      output: Promise.resolve({ reply: '拆成一项。', tasks: [] }),
    } as never);
    const replies: string[] = [];
    await expect(
      model.stream(
        [
          { role: 'system', content: '只返回提案。' },
          { role: 'user', content: '做登录' },
        ],
        (reply) => replies.push(reply),
      ),
    ).resolves.toEqual({ reply: '拆成一项。', tasks: [] });
    expect(replies).toEqual(['拆', '拆成一项。']);
    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        instructions: '只返回提案。',
        messages: [{ role: 'user', content: '做登录' }],
        temperature: 0.2,
        maxRetries: 0,
        timeout: 55_000,
        model: expect.objectContaining({
          modelId: 'deepseek/deepseek-v4.1-flash',
          provider: 'command-code.chat',
        }),
      }),
    );
    vi.mocked(streamText).mockReturnValueOnce({
      partialOutputStream: (async function* () {})(),
      output: Promise.reject(new Error('provider down')),
    } as never);
    await expect(
      model.stream([{ role: 'user', content: '再来' }], () => {}),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});
