// 所有 /api/* 响应统一走 CORS 白名单（本站 pages.dev / 预览子域 / 同源 / 环境变量 ALLOWED_ORIGINS），不再是 Access-Control-Allow-Origin: *
import { applyCors } from '../lib/security.js';
export async function onRequest(context) {
  return applyCors(context.request, context.env, await context.next());
}
