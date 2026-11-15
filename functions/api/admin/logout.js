// 管理员退出：POST /api/admin/logout → 清除 Cookie
import { handleAdminLogout } from '../../../lib/security.js';
export async function onRequest(context) {
  return handleAdminLogout(context.request);
}
