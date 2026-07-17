# standup 组件（v2）设计说明 — 语音日报正式化

> 2026-07-17 · Luna · 状态：**已定稿**（Howard 2026-07-17 全部拍板，含下方修订）
> 前置结论：MVP 已验证形态可行（github.com/zylos-ai/voice-standup-poc）；旧 standup 组件已按指示卸载删除，/standup 路径已腾出。
>
> **拍板修订（覆盖正文相应条目）**：
> 1. `/voice/*` 旧路由**直接去掉、不做 301**（决策时链接尚未发同事，新链接上线后由 coco 分身逐个分发）— 覆盖 §4 的"301 保留两周"。
> 2. 音色 = **marin**（Howard 想要的 Sol 为 ChatGPT 专属、API 不开放）。
> 3. 组件名 `standup`、repo `zylos-ai/zylos-standup`（§6 问题 3 的答案）。
> 4. 首版范围 = MVP 对等 + 鉴权 + 新 UI（§6 问题 2 确认）。
> 5. 不做任何定时推送/截止/日历逻辑：日会 12:00 为口头约定，无人汇报的日期天然无报告。

## 1. 目标与范围

把语音日报 MVP 重写为正式 zylos 组件 `standup`，替换已删除的旧组件：

- **保留**（MVP 已验证）：浏览器 ↔ 服务器中继 ↔ OpenAI Realtime 架构；semantic VAD + 自适配采样率采集；function call 结构化落库；Member/Report 实体模型（成员×日期唯一）；成员专属链接免登录形态。
- **本次新增**：dashboard 式管理端登录鉴权；现代前端技术栈与语音 UI；组件化交付（安装/升级/卸载/配置全生命周期）。
- **明确不做**（等后续单独拍板）：提醒/催报渠道、日会时间联动、国产模型切换（中继层留接口）。

## 2. 鉴权设计（对齐 dashboard/pages 模式）

| 端 | 方案 | 说明 |
|----|------|------|
| 管理端（管理页/汇总页/历史页） | 密码登录 + session cookie | scrypt 哈希存 config.json；首次安装自动生成密码打印到控制台（同 dashboard）；登录页 + HttpOnly cookie，key 彻底退出 URL |
| 成员端（语音对话页） | 专属链接 token（维持现状） | 团队无账号体系，token 即身份；支持单人重置（链接泄露时换新）；token 只授权"对话+提交自己的日报"，看不到任何他人数据 |

安全细节：session 过期 7 天滑动；登录失败限速；所有管理路由服务端校验 session；成员 token 与管理 session 完全隔离。

## 3. 技术栈

| 层 | 选型 | 理由 |
|----|------|------|
| 后端 | Node 20+ ESM + `ws` + `node:sqlite`（沿用 MVP，重构为组件规范结构） | MVP 已验证稳定，无需引入新运行时 |
| 前端 | Vite + React + Tailwind + shadcn/ui | 你点名的"现成组件库"路线；表格/表单/对话框/统计卡全部用现成组件 |
| 语音 UI | 现成语音组件：实时波形/音量动画（如 wavesurfer.js 或 react 语音通话组件）+ 通话态状态机 UI | 替换 MVP 手写 CSS 圆球，对话页达到"语音产品"观感 |
| 构建产物 | 前端 build 成静态文件由组件服务直接托管 | 不引入独立前端服务，部署面不变 |

## 4. 路径与数据迁移

- 挂 `/standup/*`（SKILL.md http_routes 声明，Caddy 组件块管理，X-Forwarded-Prefix 规范实现）。
- MVP 数据库（15 名成员 + 已有日报）原样迁入组件 data dir，**成员 token 不变**。
- `/voice/*` 手工路由在切换完成后加一段 301 → `/standup/*` 保留两周（同事已收到的旧链接不失效），之后移除。

## 5. 交付路径（按组件流程）

1. 新 repo `zylos-ai/zylos-standup`（组件模板起步，不复用旧 standup 代码）
2. 开发完成后走 code review（PR），你验收
3. Release → `zylos add standup` 安装 → 数据迁移 → 切流量 → MVP 服务下线
4. MVP repo（voice-standup-poc）归档保留

## 6. 需要你确认的点

1. **本设计整体方向** —— 点头即开工
2. 首版范围是否同意"MVP 对等 + 鉴权 + 新 UI"（提醒渠道等后续迭代）
3. 组件名就叫 `standup`（沿用路径语义）还是想换名（如 `voice-standup`）
