import type { MetadataRoute } from 'next';

// Lets a user add Lumi to a phone's home screen and open it without browser chrome.
// The icon paths are where Next serves app/icon.svg and app/apple-icon.tsx.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Lumi',
    short_name: 'Lumi',
    description: 'A task board you run by voice.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0c0a08',
    theme_color: '#0c0a08',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/apple-icon', sizes: '180x180', type: 'image/png' },
    ],
  };
}
