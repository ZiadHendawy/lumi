// Puts the /stats page behind a password (STATS_PASSWORD). The browser shows its own
// sign-in box on a 401 with WWW-Authenticate, so there is no login page to build.
import { NextResponse, type NextRequest } from 'next/server';
import { isAuthorized } from '@/lib/stats';

export function proxy(request: NextRequest) {
  if (isAuthorized(request.headers.get('authorization'), process.env.STATS_PASSWORD)) {
    return NextResponse.next();
  }
  return new NextResponse('Password required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Lumi stats"' },
  });
}

export const config = { matcher: '/stats' };
