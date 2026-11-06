# ImaLocalHub

**让 ima 知识库使用你自己的大模型（本机 / 局域网）—— 一键安装，永久地址，自动维护。**

```
ima/腾讯后端 ──HTTPS──▶ 公网入口 ──▶ ImaLocalHub 代理(鉴权/协议翻译/工具调用) ──▶ Ollama / 局域网模型
```

## 它解决什么问题

ima 的「自定义模型」接口地址由**腾讯服务器**调用，本机 `127.0.0.1` / 局域网地址它够不着。
ImaLocalHub 把你的模型通过安全隧道发布到公网，并处理好 ima 的全部协议细节：

- ✅ **校验探测秒回**——绕开保存模型时的 30 秒超时
- ✅ **OpenAI ↔ Ollama 协议翻译**（含 function calling 工具调用双向转换、关闭思考模式提速）
- ✅ **知识库问答可用**——ima 的 `mcp_knowledge_search` 等工具调用原样透传
- ✅ **SSE 流式保活**——长预填充不再被中间层掐断
- ✅ **公网入口二选一/双开**：Tailscale Funnel（地址永久不变，推荐）+ Cloudflare 隧道（备用）
- ✅ **自动维护**：入口健康巡检、进程自动拉起、Cloudflare 地址变更自动检测+提醒
- ✅ **安全**：全链路出站连接（不开任何入站端口）、公网入口强制 API Key、4MB 请求上限

## 安装（Windows）

**前提**：已登录 [Tailscale](https://tailscale.com)（免费账号）；本机跑着 Ollama 并拉好了模型。

1. 把整个 `ImaLocalHub` 文件夹拷到目标机器（任意位置）
2. 右键 `scripts\install.ps1` →「使用 PowerShell 运行」（免管理员，自动装 Node 若缺失）
3. 浏览器自动打开管理页 → 确认检测/勾选 → 点 **一键安装**
4. 按页面上的配置卡，把 地址/Key/模型名 粘贴进 ima（唯一的手动步骤，ima 的配置存在腾讯云端）
5. 点「我已填好，开始验证」→ 去 ima 随便问一句 → 页面自动打绿勾 ✅

**卸载**：运行 `scripts\uninstall.ps1`。

## 安装（macOS，beta）

```bash
bash scripts/install-mac.sh
```

## 日常使用

- 管理页：`http://127.0.0.1:18080`（安装后常驻，开机自启）
- 换模型/加局域网模型：管理页「重新安装/更新」或高级区添加远程后端（OpenAI 兼容，填 `http://192.168.x.x:端口`）
- Cloudflare 临时地址变更：顶部会自动弹提醒，复制新地址去 ima 改一次即可；用 Tailscale 入口则永远不用改
- 轮换 Key：高级区一键轮换（轮换后需同步改 ima）

## 架构与端口

| 组件 | 地址 |
|---|---|
| 管理页 | `127.0.0.1:18080`（仅本机） |
| 模型代理 | `127.0.0.1:18081`（隧道指向它） |
| 公网入口 | `https://<机器名>.<尾网>.ts.net:8443`（Funnel）+ 可选 Cloudflare 隧道 |
| 安装目录 | `%LOCALAPPDATA%\Programs\ImaLocalHub`（Win）/ `~/Applications/ImaLocalHub`（Mac） |
| 配置/日志 | `%ProgramData%\ImaLocalHub`（Win）/ `~/Library/Application Support/ImaLocalHub`（Mac） |

## 测试

```bash
node test/run-all.js        # 单元测试（协议翻译全量断言，秒级）
node test/run-all.js --e2e  # 附加真实环境 E2E（需 hub 运行中 + Ollama + Tailscale）
```

## 已知边界（诚实说明）

- ima 的模型配置存于腾讯云端，最后一步粘贴无法自动化（已压缩到 3 次复制）
- 走此链路时对话内容会经过腾讯服务器与隧道（你的 Key 只发给你自己的代理）
- 纯 CPU 跑大模型依然慢（这是硬件问题）；建议 8B 级或局域网 GPU 后端
- macOS 版为 beta（代码跨平台，未在实机全量验证）
- 若 ts.net 从腾讯机房不可达，勾选 Cloudflare 隧道作为备用入口即可
