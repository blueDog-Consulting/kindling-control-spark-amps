// Cloudflare Worker for kindlingspark.app.
//
// Static files (landing page, user guide, presets hub pages) come from site-dist/
// through the ASSETS binding. This script only handles the presets API under
// /api/ (see wrangler.jsonc "run_worker_first"), redirects www to the apex
// domain, and runs a daily cleanup.

import { cleanup, handleApi } from './api.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return handleApi(request, env, ctx);
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanup(env.DB, Date.now()));
  },
};
