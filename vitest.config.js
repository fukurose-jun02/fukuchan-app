import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      // テスト専用のダミー値。本番のシークレットとは無関係で、.dev.vars 不要でCIでも動く。
      miniflare: {
        bindings: {
          GEMINI_API_KEY: 'test-gemini-key',
          GITHUB_TOKEN: 'test-github-token',
          WORKER_PIN: '9999',
          AUTH_TOKEN_SECRET: 'test-auth-token-secret-not-for-production-use',
        },
      },
    }),
  ],
});
