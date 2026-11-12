import { ImageResponse } from 'next/og';
import LanternMark from '@/components/LanternMark';

// The card a chat app shows when someone pastes the link: the board's night, lit from below.
// No metadataBase in layout.tsx: on Vercel, Next builds the absolute og:image URL from the
// deployment's own domain (VERCEL_PROJECT_PRODUCTION_URL, or the preview URL on previews).
// The default font is used, so the build fetches nothing.
export const alt = 'Lumi: a task board you run by voice';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#0c0a08',
          backgroundImage:
            'radial-gradient(70% 75% at 50% 115%, rgba(255, 150, 60, 0.45), rgba(255, 130, 50, 0.12) 55%, transparent)',
        }}
      >
        <LanternMark size={190} />
        <div
          style={{
            marginTop: 28,
            fontSize: 128,
            lineHeight: 1,
            letterSpacing: '-0.03em',
            color: '#ffdca0',
            textShadow: '0 0 40px rgba(255, 170, 70, 0.45)',
          }}
        >
          Lumi
        </div>
        <div
          style={{
            marginTop: 26,
            fontSize: 28,
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
            color: 'rgba(244, 234, 217, 0.6)',
          }}
        >
          a task board you run by voice
        </div>
      </div>
    ),
    size,
  );
}
