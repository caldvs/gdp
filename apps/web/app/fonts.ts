import { Anton, Plus_Jakarta_Sans } from 'next/font/google';

// The two fonts, as CSS variables on <html> (globals.css reads them at
// :root). Shared by the root layout and Storybook's preview.
const jakarta = Plus_Jakarta_Sans({ subsets: ['latin'], variable: '--font-jakarta', display: 'swap' });
// Headings and big amounts (#180).
const anton = Anton({ weight: '400', subsets: ['latin'], variable: '--font-anton', display: 'swap' });

export const fontClasses = `${jakarta.variable} ${anton.variable}`;
