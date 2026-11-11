# DeepSeek 本地 Token 计数

在已提交的上下文压缩上继续，用户授权自主推进。采用官方 deepseek-recipe 0.2.0 的 Python 绑定与对应 tokenizer，避免自行移植聊天模板；不更换模型和链上数据服务。

## 方案与边界

纯文本 tokenizer 无法覆盖工具模板；手写模板容易随模型更新失配；因此选官方整段对话编码器。Node 通过本地 Python worker 计数，worker不接收API密钥、不联网，只处理当前实际请求的消息和工具定义。Python依赖及两个tokenizer通过显式setup命令安装在忽略的.runtime目录；默认npm安装不下载模型资产。

- 固定官方仓库revision 935817c66f5d6e64838f419692545f06787e485f，tokenizer文件用官方记录的SHA256校验并保留许可证。deepseek-flash映射V4.1，deepseek-v4-pro映射V4；映射在日志中可见。
- Node复用一个有界worker，启动/计数超时5秒，支持AbortSignal；关闭CLI时清理进程。失败时回退现有保守估算，记录原因，不影响查询可用性。
- 请求计数与DeepSeek HTTP复用同一消息/工具wire转换，避免工具ID、JSON参数或空content产生差异。计数器只接收白名单数据字段，不接收Authorization。
- 上下文拟合、摘要触发、摘要源容量和替换前校验均使用同一异步计数接口，字节硬上限和输出预留不变。工具调用配对及摘要低权限边界不变。
- 本地结果标记local_tokenizer，附模型encoding与资产版本；只称官方离线模板计数，不承诺等于远端账单。实际usage继续单列。
- 缺少Python/资产时现有CLI照常工作。新setup命令可重复执行；下载或校验失败不激活不完整资产。Windows与Unix采用对应venv Python路径。

## 验收

离线测试覆盖异步容量与工具Schema、工具调用配对、worker超时/退出/取消/坏响应与降级、无密钥输入、wire一致性。可选真实本地tokenizer测试覆盖英文、中文、特殊token拼写和工具调用，不发模型API请求；执行全套测试与类型检查。
