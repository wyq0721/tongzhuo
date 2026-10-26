# 准备 Codex 云端环境

在 Codex 的环境创建入口选择 `wyq0721/tongzhuo`，使用 `main` 分支。

环境准备对话可以直接说明：

> 这个项目需要 Node.js 22.13 或以上，必须能导入 node:sqlite；还需要 Python 3。没有 npm 运行依赖，也没有需要 npm ci 的锁文件。请在仓库根目录运行 npm run check、npm test、npm run build。不要启动 npm run share、公网隧道或长期运行的网页服务，不要要求模型 API Key。

检查准备报告中的 Node.js、Python 版本和验证结果，再保存并发布环境。项目指引也写在根目录 `AGENTS.md`，供环境准备 Agent 读取。

准备成功仅证明这个仓库可以安装、检查与测试。房间群聊、文件原件及私有能力凭证保存在房主 Mac，仓库不包含这些内容。

之后在同桌网页中绑定该环境，并启动一次真实任务，继续验收：

1. 云端能够访问房主 Mac 当前的 HTTPS 入口。
2. 收到真实 `/agent/hello` 后网页才显示连接。
3. 同一云任务处理两轮请求。
4. 下载附件、核对 SHA256、回传报告原件。

若环境限制网络访问，需要允许实际使用的群聊 HTTPS 域名。发布仓库或通过本地协议测试，均不能代替这些验收。

官方环境创建入口说明：[Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments)。
