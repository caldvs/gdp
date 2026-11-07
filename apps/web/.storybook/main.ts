import type { StorybookConfig } from '@storybook/nextjs-vite';

const config: StorybookConfig = {
  stories: ['../stories/**/*.stories.tsx'],
  framework: { name: '@storybook/nextjs-vite', options: {} },
  core: { disableTelemetry: true },
  // The Pages stories are the real pages (stories/screens/harness.tsx).
  // Platform fees show only when a Stripe key is set, so give them a
  // placeholder one; and no test bar.
  viteFinal: async (config) => {
    config.define = {
      ...config.define,
      'process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY': JSON.stringify('pk_test_storybook'),
      'process.env.NEXT_PUBLIC_TEST_TOOLS': JSON.stringify('0'),
    };
    return config;
  },
};

export default config;
