/**
 * Vercel Node Function adapter for the Konkred API gateway.
 *
 * The gateway's request router is also used by the standalone Docker server;
 * Vercel invokes the same handler per request instead of opening a listener.
 */
import { handleRequest } from '../gateway/src/server.mjs';

// The gateway owns JSON parsing so its size limit and error envelope stay the
// same in Docker and on Vercel. Keep Vercel's automatic body parser disabled.
export const config = {
  api: { bodyParser: false },
};

export default function handler(req, res) {
  // vercel.json rewrites OpenAI-compatible paths through the /api catch-all.
  // Restore the public path before the shared router dispatches the request.
  if (typeof req.url === 'string') {
    req.url = req.url.replace(/^\/api\/v1(?=\/|\?|$)/, '/v1');
  }
  return handleRequest(req, res);
}
