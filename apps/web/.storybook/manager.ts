import { addons } from 'storybook/manager-api';
import { create } from 'storybook/theming';

addons.setConfig({
  theme: create({
    base: 'light',
    brandTitle: 'Pay Me Back UI',
    colorPrimary: '#d42a55',
    colorSecondary: '#d42a55',
    appBg: '#f7f7f7',
    appContentBg: '#f7f7f7',
    fontBase: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  }),
});
