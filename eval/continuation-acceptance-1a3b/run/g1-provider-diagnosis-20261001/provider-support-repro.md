# DeepSeek Flash API 生成停滞的复现材料

故障报告已提交到 DeepSeek 官方帮助与反馈工单。用户手动上传附件 download.jpeg 后，页面明确显示 Submitted；页面没有提供工单编号。用户已授权提交报告，并提供账号邮箱用于官方定位和回复。本文不保存账号邮箱、API key、生产内容或完整私有日志。提交回执见 feedback-receipt.json 和 feedback-submitted.png。此回执不代表 Provider 已恢复或 G1 发布验收通过。

时间：2026-10-01，约 19:40–20:30 UTC。最新同一 key 的余额接口返回 HTTP 200/is_available=true；模型列表返回 deepseek-flash/deepseek-v4-pro。

复现请求：POST https://api.deepseek.com/responses，Authorization: Bearer YOUR_API_KEY，Content-Type: application/json。

```json
{
  "model": "deepseek-flash",
  "input": [{"role": "user", "content": "Reply with OK."}],
  "instructions": "Be concise.",
  "reasoning": {"effort": "low"},
  "stream": true,
  "store": false,
  "max_output_tokens": 256
}
```

相同 key 和上述请求体，只替换 model 字段：

| model | 结果 |
| --- | --- |
| deepseek-flash | HTTP 200，45 秒只有 42 字节 keep-alive，无 data event，客户端超时 |
| deepseek-v4-flash | HTTP 200，45 秒只有 42 字节 keep-alive，无 data event，客户端超时 |
| deepseek-v4-pro | HTTP 200，6.222 秒 response.completed，返回 model=deepseek-v4-pro，input=11/output=20/reasoning=18 tokens |

Flash 去掉所有可选字段，仅保留 model/input/stream，普通 string input 与 typed input_text parts 均 65 秒无输出。Flash reasoning=none、100-token cap 请求 180 秒仍只有保活。Node 直接连接、Node 环境代理、curl 系统代理结果相同。独立 Vercel 托管环境使用同一最新 key，正常 Owner 合成输入的前两次模型 attempt 各 120 秒 timeout。不是仅本机生成失败。

目前没有 HTTP 401/402/429，也没有任何 Flash reasoning/output/completed 事件。最小请求不含工具、附件、私人信息或 JSON 输出模式。

官方更新日志表明，旧 deepseek-v4-flash 仍临时转到 V4.1 Flash；当前官方名 deepseek-flash 同样失败。官方 FAQ 表明持续 keep-alive 是尚未开始推理。单独一个 canonical Flash 请求的完整十分钟窗口结果将另附，不能将客户端提前 abort 写成服务端终止。

需要确认：该账号的 Flash 调度/容量是否异常；该模型服务路径是否受当前故障影响。若需账户或 Tracking ID，应由账号所有者在官方工单中提供，不应要求把 API key 粘贴到报告。

补充结果：一个独立 canonical Flash 请求等待 620016ms，HTTP200，714 字节保活，未出现任何 data event，最终由诊断客户端 TimeoutError 终止，未收到服务器具体错误。Anthropic 兼容接口也只有保活到45秒；Chat 加合成 user_id 调度隔离后也只有保活到65秒。均未发送私人内容。
