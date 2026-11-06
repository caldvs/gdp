import { Bricolage_Grotesque, IBM_Plex_Mono, Plus_Jakarta_Sans } from 'next/font/google';

// The fonts, as CSS variables on <html> (globals.css reads them at :root).
// Shared by the root layout and Storybook's preview. The Tickets look (#212).
const jakarta = Plus_Jakarta_Sans({ subsets: ['latin'], variable: '--font-jakarta', display: 'swap' });
// Headings, the logo and big amounts.
const bricolage = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-bricolage', display: 'swap' });
// The bill, and only the bill (<Receipt>).
const plexMono = IBM_Plex_Mono({ weight: ['400', '500', '600'], subsets: ['latin'], variable: '--font-plex-mono', display: 'swap' });

export const fontClasses = `${jakarta.variable} ${bricolage.variable} ${plexMono.variable}`;
