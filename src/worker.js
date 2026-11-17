import { handleRequest } from './routes.js';
import { scheduledCleanup } from './cleanup.js';

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(scheduledCleanup(controller, env));
  }
};
