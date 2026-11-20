// Issues a short-lived LiveKit token and asks LiveKit to dispatch the Lumi agent
// into the room. Adapted from livekit-examples/agent-starter-react.
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';
import { voicePaused } from '@/lib/paused';

const AGENT_NAME = 'lumi'; // must match AGENT_NAME in agent/config.py
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  // Checked first and here, not only in the page: anyone can call this route directly, and a
  // refused token means no room and no agent, so nothing on the free tiers is used.
  if (voicePaused(process.env.NEXT_PUBLIC_VOICE_PAUSED)) {
    return new Response('Voice is paused', { status: 503 });
  }
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return new Response('LiveKit env vars are not set', { status: 500 });
  }

  // The identity is the browser's anonymous user id; the agent uses it to look up
  // memory. There is no login (friction for a first-time user), so we only check its shape.
  const body = await req.json().catch(() => ({}));
  const identity: unknown = body?.participant_identity;
  if (typeof identity !== 'string' || !UUID.test(identity)) {
    return new Response('participant_identity must be a UUID', { status: 400 });
  }

  // The starter refuses to run this route in production because anyone can call it.
  // That's the point of a public demo; abuse is bounded by the 15 min token TTL,
  // the agent's own session caps, and LiveKit's free-tier concurrency limit.
  // Room config is built here, not taken from the client, so callers can't pick the agent.
  const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, ttl: '15m' });
  const roomName = `lumi_${crypto.randomUUID()}`;
  token.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
  token.roomConfig = new RoomConfiguration({
    agents: [new RoomAgentDispatch({ agentName: AGENT_NAME })],
  });

  // Field names follow LiveKit's standard token-endpoint format, which TokenSource.endpoint expects.
  return Response.json(
    { server_url: LIVEKIT_URL, participant_token: await token.toJwt() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
