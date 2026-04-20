// API 配置 - 生产使用
// 如需更改，请将域名替换为你的 Cloudflare Worker 地址
const API_BASE_URL = ""; // 自动匹配当前域名


// 短链接服务（已废弃，保留向后兼容）
const SHORT_LINK_API = "https://9lnk.io/create";

// 导出配置到全局（前端通过 window.API_CONFIG 使用）
window.API_CONFIG = {
  BASE_URL: API_BASE_URL,
  UPLOAD: `${API_BASE_URL}/api/upload`,
  PHOTOS: `${API_BASE_URL}/api/photos`,
  DELETE_PHOTOS: `${API_BASE_URL}/api/photos`,
  SHORT_LINK: SHORT_LINK_API,
};
