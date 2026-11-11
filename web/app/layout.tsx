import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Lumi',
  description: 'A voice assistant that remembers you.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
