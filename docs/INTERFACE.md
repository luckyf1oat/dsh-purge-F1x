# 接口契约（写代码前先读完这一份）

项目根：`D:\AI\deepseek official desktop\dsh\workplace\dsh-purge-flash`
纯 ESM，`"type": "module"`，只允许 `node:` 内置模块。禁止第三方依赖。禁止 `# TODO`、禁止省略函数体。

## 全局纪律

1. 所有 `export function install*(...)` 必须**永不抛错**：整个函数体包在 `try { ... } catch (e) { log('...', e) }` 里，失败只记一行日志。DPH 宿主会因为一行 fiber 失败就报 `Failed to load plugins`，整机启动失败。
2. 所有改写型函数必须**幂等**：返回值是新对象，不原地改传入对象。重复调用两次结果必须完全一致（有测试）。
3. 定时器一律 `timer.unref?.()`。文件句柄一律 `try/finally` 关闭。
4. 不写 `console.log`；用 `lib/log.js` 的 `log()`，`verbose` 关闭时静默。
5. 路径全部走 `node:path`，Windows 反斜杠要用 `path.join`，不手拼 `/`。

## 模块清单与签名

### `lib/log.js`（已有，别改）

```js
export let verbose = false;
export function setVerbose(v) {}
export function log(...args) {}
```

### `lib/config.js`（已有，别改）

```js
export const DEFAULTS;
export function normalizeConfig(raw) -> {
  enabled, kernel, kernelOrder, kernelOverrideFile, stripOfficial,
  prefillAnchor, repairOnRefusal, repairMaxPerTurn, routeLadder,
  routeAfterRefusals, mirror, mirrorDir, rawStream, shadowSnapshot,
  retractProbe, playbook, patches, verbose
}
```

### `lib/kernel.js`（交给 opencode 写）

```js
export function pickFamily(provider, model) // -> 'deepseek' | 'claude' | 'openai-compat' | 'generic'
export function renderKernel(family)        // -> string，纯文本，不含代码块围栏
export const FAMILIES = ['deepseek', 'claude', 'openai-compat', 'generic'];
```

### `lib/detect.js`（交给 opencode 写）

```js
/** 硬拒：只看开场，判「模型明说不干」 */
export function isHardRefusal(text) // -> boolean
/** 软拒：S1–S9 形态，返回命中的形态 id 数组，如 ['S1','S7'] */
export function softRefusalForms(text) // -> string[]
/** 综合判定 */
export function classifyReply(text) // -> { refused: boolean, hard: boolean, soft: string[], head: string }
/** wire 层错误是否属「可能靠重发解决」 */
export function isRefusalError(failure) // -> boolean，入参 { code, message }
/** 模型自我撤回检测 */
export function isRetraction(text) // -> { hit: boolean, at: number }  at 为命中的字符偏移
/** 估算 token：CJK 每字 ≈ 0.72 tok，其余每 3.6 字符 ≈ 1 tok */
export function estimateTokens(text) // -> number
```

### `lib/mirror.js`（本席自己写）

```js
export function createMirror(cfg, home) -> {
  pushEvent(sessionId, event),
  teeStream(sessionId, turn, step, iterable) -> AsyncIterable,   // 透明转发
  readStreamRaw(sessionId, turn, step) -> string,
  recover(sessionId) -> string,                                  // Markdown 转录
  verify(sessionId) -> { events: number, frames: number, truncated: boolean },
  list() -> { id, bytes, events }[],
  flush(), dispose(), stats()
}
```

落盘布局（`$DSH_HOME/<mirrorDir>/`）：

```
index.jsonl                              每行 { id, firstSeen, lastEvent }
<sid>/events.jsonl.zstd                  多帧 zstd，帧 magic 28 B5 2F FD
<sid>/stream/<turn>-<step>.jsonl         明文，一行一个 chunk
<sid>/shadowed-<seq>.md                  被 replace 遮蔽的原文
<sid>/retract.jsonl                      自我撤回 / UI 撤回的定位记录
```

### `lib/assemble.js`（本席自己写）

```js
export function installAssemble(ctx, cfg, state) // 挂 system-prompt/assemble 瀑布
```

### `lib/prestep.js`（本席自己写）

```js
export function installPreStep(ctx, cfg, state)
```

### `lib/route.js`（本席自己写）

```js
export function installRoute(ctx, cfg, state)
```

### `lib/stream.js`（本席自己写）

```js
export function installStream(ctx, cfg, mirror, state)
```

### `bin/armor.mjs`（交给 opencode 写）

只依赖 `node:` 内置 + 自己的参数解析。**不 import `lib/mirror.js`**（CLI 要能离线跑），自己实现多帧 zstd 解压。
子命令：`recover <sid>`、`verify <sid>`、`list`、`cost <file>`。

## 多帧 zstd 的关键事实（写错就全废）

`session.v4.jsonl.zstd` **不是一个 zstd 流**，是多个 zstd 帧首尾相接，每落盘一帧。
`zlib.zstdDecompressSync(整个文件)` 只解出第一帧，看起来像「日志只有一行」。

正确做法：

```js
import zlib from 'node:zlib';
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function decodeMultiFrame(buf) {
  const offsets = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) { offsets.push(i); i += 4; }
  if (offsets.length === 0) return buf.toString('utf8');
  const parts = [];
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    if (end <= start) continue;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(start, end))); } catch { /* 半帧，跳过 */ }
  }
  return Buffer.concat(parts).toString('utf8');
}
```

需要 Node ≥ 22.15（`zlib.zstdDecompressSync` 才有）。

## DSH 会话事件形状（喂给 detect / mirror 的）

```js
{ type: 'assistant/message', seq: 12, data: { message: { role:'assistant', content:[{type:'text', text:'...'}] }, turn, step } }
{ type: 'user/message', seq: 13, data: { id, role:'user', content:[...], source:{ kind:'user'|'plugin'|'purge-flash' } } }
{ type: 'system/message', seq: 14, data: { message: { role:'system', content:[{type:'text',text:'...'}] } } }
```

遮蔽事件的形状（撤回/压缩都是追加一条 replace 盖旧节点）：

```js
{ type: 'user/message', seq: 30, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 20 }, sourceEventSeqs: [1,2,3,...] }
```

## 禁止事项

- 不改 `resources/app/dsh` 下任何宿主文件（Tier B 补丁由本席单独处理，不在本次范围）。
- 不 import `@deepseek-ai/*`。
- 不写网络请求。
