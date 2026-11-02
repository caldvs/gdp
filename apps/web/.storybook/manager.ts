import { addons } from 'storybook/manager-api';
import { create } from 'storybook/theming';

addons.setConfig({
  theme: create({
    base: 'light',
    brandTitle: 'Pay Me Back UI',
    colorPrimary: '#0b57d0',
    colorSecondary: '#0b57d0',
    appBg: '#f3f5f8',
    appContentBg: '#f3f5f8',
    fontBase: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  }),
});
