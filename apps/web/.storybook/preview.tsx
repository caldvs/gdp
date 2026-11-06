import type { Preview } from '@storybook/nextjs-vite';
import { fontClasses } from '../app/fonts';
import { withScreen } from '../stories/screens/harness';
import '../app/globals.css';

// What the root layout puts on <html>: the fonts' CSS variables.
document.documentElement.classList.add(...fontClasses.split(' '));

const preview: Preview = {
  parameters: {
    layout: 'padded',
    nextjs: { appDirectory: true },
    backgrounds: { disable: true },
    controls: { expanded: true },
    options: { storySort: { order: ['Pages', 'Layout', 'Lists', 'Buttons', 'Forms', 'People', 'Feedback', 'Dialog', 'Shell', 'Icons'] } },
  },
  decorators: [
    // Pages (stories/pages) are the real app at phone size; the pieces sit in a narrow column.
    (Story, ctx) => (ctx.parameters.phone ? <Story /> : <div style={{ maxWidth: 560, margin: '0 auto' }}><Story /></div>),
    withScreen,
  ],
};

export default preview;
