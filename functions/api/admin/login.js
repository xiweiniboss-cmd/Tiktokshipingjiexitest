// 管理员登录：POST /api/admin/login {key} → HttpOnly; Secure; SameSite=Strict Cookie（12 小时）
import { handleAdminLogin } from '../../../lib/security.js';
export async function onRequest(context) {
  return handleAdminLogin(context.request, context.env);
}
