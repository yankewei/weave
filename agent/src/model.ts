import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

export function commandCodeModels() {
  const models = createModels();
  const modelId =
    process.env.CMD_MODEL?.trim() || 'deepseek/deepseek-v4.1-flash';
  const baseUrl =
    process.env.CMD_BASE_URL || 'https://api.commandcode.ai/provider/v1';
  const key = process.env.CMD_API_KEY?.trim();
  models.setProvider(
    createProvider({
      id: 'command-code',
      baseUrl,
      auth: {
        apiKey: {
          name: 'Command Code',
          resolve: async () => (key ? { auth: { apiKey: key } } : undefined),
        },
      },
      models: [
        {
          id: modelId,
          name: modelId,
          provider: 'command-code',
          api: 'openai-completions',
          baseUrl,
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
      api: openAICompletionsApi(),
    }),
  );
  return {
    models,
    model: { provider: 'command-code', modelId },
    ready: Boolean(key),
  };
}
