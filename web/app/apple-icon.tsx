import { ImageResponse } from 'next/og';
import LanternMark from '@/components/LanternMark';

// The home-screen icon. iOS rounds the corners itself and wants a full square,
// so this is the lantern on a plain night background rather than icon.svg's tile.
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0c0a08',
        }}
      >
        <LanternMark size={136} />
      </div>
    ),
    size,
  );
}
