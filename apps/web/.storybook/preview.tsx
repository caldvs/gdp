import type { Preview } from '@storybook/nextjs-vite';
import '../app/globals.css';

const preview: Preview = {
  parameters: {
    layout: 'padded',
    nextjs: { appDirectory: true },
    backgrounds: { disable: true },
    controls: { expanded: true },
    options: { storySort: { order: ['Screens', 'Layout', 'Lists', 'Buttons', 'Forms', 'People', 'Feedback', 'Dialog', 'Shell', 'Icons'] } },
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        <Story />
      </div>
    ),
  ],
};

export default preview;
