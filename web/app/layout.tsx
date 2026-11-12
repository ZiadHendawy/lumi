import type { Metadata, Viewport } from 'next';
import { Fraunces, Inter } from 'next/font/google';
import './globals.css';

// next/font downloads the fonts at build time and serves them from our own domain,
// so there is no request to Google from the user's browser.
const display = Fraunces({ subsets: ['latin'], axes: ['SOFT', 'opsz'], variable: '--font-display' });
const body = Inter({ subsets: ['latin'], variable: '--font-body' });

export const metadata: Metadata = {
  title: 'Lumi',
  description: 'A task board you run by voice.',
};

// Matches the page background so the mobile browser chrome blends into the night.
export const viewport: Viewport = { themeColor: '#0c0a08' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
