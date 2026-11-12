# ENS 正向解析

用户授权直接实现并在中断后要求继续。沿用 TypeScript、现有 Alchemy Transport 与证据/预算协议，不设额外问答关卡。

## 选择

使用官方 Ethereum Mainnet Universal Resolver 0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe 的 resolve(bytes,bytes) 查询ETH地址，支持其链上通配解析能力。相比逐级 Registry/Resolver 手写查找，减少请求与协议分支。使用 @adraffy/ens-normalize 1.11.1 进行 ENSIP-15 规范化，@noble/hashes 2.4.0 做 Keccak/namehash。只实现固定函数ABI编码/严格返回解码，依赖精确锁版本。

参考官方部署 https://docs.ens.domains/learn/deployments/ 、规范化 https://docs.ens.domains/resolution/names/ 、ENSIP10 https://docs.ens.domains/ensip/10/ 及部署ABI https://github.com/ensdomains/ens-contracts/blob/staging/deployments/mainnet/UniversalResolver.json 。

首版接受 .eth 及其子域，支持ENSIP15的大小写/Unicode名称。每轮至多4个名称，总长度及DNS标签字节受限。按空白分隔的完整token先规范化，失败后才尝试去除外围成对包装和句末标点，不截取内部合法标点后的子串。名称与中文指令用空格分隔；无法明确识别、非法名称或混用非法0x目标时澄清。名称本身从日期、余额、历史意图及直接地址识别文本中屏蔽。链下CCIP读取暂不访问网关，明确不支持/解析失败；不把未设置地址当零余额。

## 接入

新建独立 EnsResolution 类型及证据存储，不扩充三类链上QueryKind，避免余额/转账渲染把解析当交易。每条解析有 resolutionId、原始名称、规范化名称、地址或错误、网络、主网快照、resolver/universalResolver、时间和原始RPC证据。
查询前程序自动解析用户明确输入的名称，解析成功后将对应0x地址加入本轮允许目标；模型只能看到已验证映射，不能自行解析/猜地址。存在任何失败时整轮停止目标查询，不回退会话旧地址。
原始名称及目标地址都展示在最终回答。自然语言日期仍描述余额/历史数据范围；ENS映射是在本轮快照时的当前绑定，不承诺历史日期时的名称所有权/地址绑定。

解析使用与数据查询相同的主网快照。所有ENS RPC走既有供应商调度、取消、超时、32次HTTP预算，并作为受限只读操作计入12次工具预算。eth_call仅允许固定UniversalResolver、固定resolve方法、固定区块和合法调用结构；不提供模型任意eth_call工具。

## 持久化与恢复

SessionData新增可选已选名称列表及单独的直接地址列表。新输入直接地址清空已选名称；新输入名称以新目标替换旧选择；同时选择名称与直接地址时保留两者，无新目标的下一轮重新解析名称并保留直接地址。显式旧证据引用不重新解析，不把旧结果冒充新结果；同时提供新名称与旧证据且未说明刷新时先澄清。
Checkpoint新增可选ENS选择/解析引用，保存原始快照与成功映射。解析成功证据先落盘并哈希，再允许派生地址授权或数据请求。恢复复用成功映射，不追踪名称后来改绑；未完成解析可在原快照重做，计数累计。旧无ENS检查点保持兼容。
解析前也要有可恢复检查点，即使尚无地址；只允许存在有效待解析名称的这种空地址检查点。会话先保留新选择意图，只有本轮全部名称解析成功后才原子替换cp.addresses及已验证地址集，失败时不会授权旧地址。恢复子检查点在解析网络请求前激活，首次模型调用前真实进程退出也可恢复。
解析来源引用和文件哈希在恢复时校验；名称映射证据与其地址授权一致。会话保存选择名称与直接地址，不把跨轮映射缓存作为最新事实。

## 验收

独立已知namehash/ABI向量、大小写Unicode、非法/超长名称、边界提取、无地址、错误主网、恶意返回/CCIP错误、任意eth_call拒绝。
真实Pi测试：ENS余额、日期资金流、跨轮改绑重新解析、切换直接地址、解析失败不回退、模型不能查询其他地址、取消恢复固定映射、哈希损坏拒绝和累计预算。
全套/类型检查、真实公开vitalik.eth验收、独立审阅；不自动提交或推送本次新功能。
