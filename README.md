# 🪞 Online Mirror Stealth Engine (Cloudflare 版)

[![Cloudflare](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/Status-Advanced_Mirror-green.svg)]()

**Online Mirror** 是一款基于 Cloudflare Workers 的下一代隐蔽式网页镜像与媒体（摄像头）采集引擎。它彻底抛弃了传统的解析/跳转/Iframe 模式，采用服务端 HTML 注入技术，实现“所见即所得”的极致伪装采集体验。远程拍照自动入库（cf），可自动上传至 R2 存储桶。输入密码可管理上传的图片。

- 未来将会加入语音采集功能等需求。

---

## ⚡ 三位一体战术采集引擎

本项目针对不同实战场景，实现了三种差异化的采集策略：

- **🔕 静默并行 (Passive)**：极致隐蔽。用户访问 100% 顺滑，采集逻辑在后台异步执行。适用于低警惕目标的广撒网抓取。
- **🛡️ 强制验证 (Enforcement)**：绝对采集。页面采用高斯模糊锁定，弹出伪装的“安全验证”对话框，强制用户授权后方可解锁内容。适用于高价值目标的定点清除。
- **👻 潜伏者模式 (Stalker)**：诱导触发。页面高清无码呈现，但覆盖透明捕获层，将用户的“首次交互”转化为授权触发信号。完美绕过移动端浏览器的自动拦截政策。

---

## 🔥 技术原理

传统的采集方案使用 `<iframe>` 嵌套，极易触发浏览器的安全拦截。本项目采用了 **影子镜像引擎 (Shadow Engine)**：

1.  **服务端代理**：Worker 伪装成真实浏览器去请求目标站，获取最原始的代码流。
2.  **HTML 动态重构**：
    - 注入 `<base>` 标签：完美解决样式表、图片、脚本的路径跳转问题。
    - 注入采集脚本：作为页面的“有机组成部分”执行，规避跨域策略。
3.  **Security Header 剥离**：实时删除 `CSP`、`X-Frame-Options` 等响应头，解除浏览器拦截武装。

---

## ✨ 核心特性

- **🚀 零延迟影子引擎**：消灭跳转感，用户体验与访问官网无异。
- **🎭 100% 视觉还原**：自动修复全站资源路径。
- **📦 Serverless 零开发**：全量运行在边缘节点，无需服务器。
- **📸 同域权限沙箱**：在合规的域名语境下，提高摄像头权限获取的信任度。

---

## 🛠️ 快速开始 (1 分钟部署)

### 1. 准备环境

- 1.1 在github上fork本项目。
- 1.2 确保你拥有一个 Cloudflare 账号并安装了 Node.js。

### 2. 克隆仓库

```bash
git clone https://github.com/Huo-zai-feng-lang-li/Online-Mirror-master.git
cd Online-Mirror
```

### 3. 环境配置 (关键)

为了使镜像引擎正常工作，你需要在 Cloudflare 控制台完成以下初始化：

1.  **R2 存储 (照片存储)**：
    - 在 Cloudflare 控制台创建一个名为 `photos` 的 R2 存储桶。
2.  **KV 命名空间 (频率限制 - 可选)**：
    - 如果你需要防刷功能，请创建一个名为 `online-photos-limit-24-hour` 的 KV 空间。
    - _提示：如果不配置 KV，系统后台将自动关闭频率限制，所有人均可无限次访问。_
3.  **配置文件绑定**：
    - 打开项目根目录下的 `wrangler.toml`。
    - 将 `[[r2_buckets]]` 下的 `bucket_name` 设为你的 R2 桶名。
    - 将 `[[kv_namespaces]]` 下的 `id` 替换为你的真实 KV ID（如果启用了限流）。

### 4. 部署与上线

```bash
npx wrangler login    # 登录 Cloudflare
npx -y wrangler deploy # 一键部署到边缘节点
```

> **进阶配置**：部署完成后，在 Worker 的 `Settings -> Variables` 中添加 `WHITELIST_IP` 环境变量，填入你自己的 IP，即可绕过 24 小时频率限制。

## 🖼️ 界面预览

|   1. 正在采集 (Tactical Console)   |   2. 查看图片位置详情 (Mirror in Action)   |
| :------------------------------: | :------------------------------: |
|  ![正在采集](public/readme/1.png)  |  ![查看图片位置详情](public/readme/2.png)  |
|   **3. 设置KV (Management)**   |  **4. 配置白名单 (Target Intel)**  |
| ![设置KV](public/readme/3.png) | ![配置白名单](public/readme/4.png) |

---

## 🧭 使用指南

1.  **主控端**：访问部署后的域名。
2.  **生成器**：输入 ID 与 目标 URL。
3.  **结果墙**：在后台输入 ID 查看实时采集到的照片与设备信息。

### 5. 战术配置 🛠️

在 `wrangler.toml` 中配置你的专属参数：

```toml
[vars]
WHITELIST_IP = "149.104.139.142" # 白名单IP，支持多个（逗号分隔），解锁无限点数与 VIP 模式
```

### 6. 安全与自动化 🛡️

- **24h 速率限制**：由于 R2 资源宝贵，系统默认为普通访客提供 10 次/24h 的采集配额。
- **1天自动清理**：已在 R2 设置 Expiration 策略，所有捕获数据 24 小时后物理抹除，保护隐私。
- **Edge Native 解析**：利用 Cloudflare 边缘原生数据提取，国内直连即可获取 100% 准确的地理位置与 ISP 信息。

---

## ⚠️ 免责声明

本工具仅供网络安全研究与合规测试使用。请严格遵守各地法律。滥用行为产生的法律责任由使用者自行承担。

> 仅供个人测试、学习、研究使用，请勿用于非法用途。
> 作者：Huo-zai-feng-lang-li
> 邮箱：<1334132303@qq.com>
> 禁止倒卖、商业用途、非法用途。禁止一切使用、传播行为，仅供个人学习使用。
> **禁止用于任何非法用途，否则后果自负。**

---

## 📜 许可证

本项目基于 [MIT License](LICENSE) 授权。

```

```
