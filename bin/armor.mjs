#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const USAGE = `用法：
  armor list [--dir <镜像根>]
  armor recover <sid> [--dir <镜像根>] [--out <文件>]
  armor verify <sid> [--dir <镜像根>]
  armor cost <文件>
  armor migrate [--from purge]
  armor help

环境变量：
  DSH_HOME   默认 ~/.dsh
  PURGE_DIR  dsh-purge 安装目录
`;

export function countFrames(buf) {
  if (!buf || buf.length === 0) return 0;
  let frames = 0;
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    frames += 1;
    i += 4;
  }
  return frames;
}

export function decodeMultiFrame(buf) {
  if (!buf || buf.length === 0) return "";
  const offsets = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    offsets.push(i);
    i += 4;
  }
  if (offsets.length === 0) return buf.toString("utf8");
  const parts = [];
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    if (end <= start) continue;
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)));
    } catch {
      /* 半帧跳过 */
    }
  }
  return Buffer.concat(parts).toString("utf8");
}

function dshHome() {
  const fromEnv = (process.env.DSH_HOME || "").trim();
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), ".dsh");
}

function parseArgs(args) {
  const opts = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dir" || arg === "--out" || arg === "--from") {
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        opts[arg.slice(2)] = value;
        i += 1;
      } else {
        opts[arg.slice(2)] = "";
      }
      continue;
    }
    opts._.push(arg);
  }
  return opts;
}

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("");
}

function eventToMd(event) {
  const type = event?.type;
  const data = event?.data || {};
  if (type === "user/message") {
    const text = textOfContent(data.content);
    if (!text) return null;
    const kind = data?.source?.kind || "user";
    return `### [${event.seq}] user · ${kind}\n\n${text}`;
  }
  if (type === "assistant/message") {
    const msg = data.message || {};
    const text = textOfContent(msg.content);
    if (!text) return null;
    const toolCount = Array.isArray(msg.content)
      ? msg.content.filter((block) => block && block.type === "tool-call").length
      : 0;
    const note = toolCount > 0 ? `\n\n_(含 ${toolCount} 个 tool-call)_` : "";
    return `### [${event.seq}] assistant\n\n${text}${note}`;
  }
  if (type === "system/message") {
    const text = textOfContent(data?.message?.content);
    if (!text) return null;
    const short = text.length > 400 ? `${text.slice(0, 400)}…（共 ${text.length} 字符）` : text;
    const quoted = short
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    return `### [${event.seq}] system\n\n${quoted}`;
  }
  return null;
}

function readEvents(file) {
  // 与 verify 走同一条路径：逐帧解压、数组行摊平，大文件不会撞字符串上限。
  return readEventsWithFrames(file).events;
}

/** 逐帧产出解压后的文本：峰值是一帧，不是整份历史。 */
function* iterFrameText(buf) {
  const offsets = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    offsets.push(i);
    i += 4;
  }
  if (offsets.length === 0) {
    yield buf.toString("utf8");
    return;
  }
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    if (end <= start) continue;
    try {
      yield zlib.zstdDecompressSync(buf.subarray(start, end)).toString("utf8");
    } catch {
      /* 半帧跳过 */
    }
  }
}

/** 一行可能是事件，也可能是一整个数组（旧补录写的），两种都摊开。 */
function pushParsedEvent(out, line) {
  if (!line || !line.trim()) return;
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) if (item && typeof item === "object" && !Array.isArray(item)) out.push(item);
  } else if (value && typeof value === "object") {
    out.push(value);
  }
}

function readEventsWithFrames(file) {
  const buf = fs.readFileSync(file);
  // 按 seq 去重、后写覆盖前写：旧补录把同一批事件写过几百遍（同一批在每帧里
  // 重放），不去重的话一个 296 MB 的镜像能摊出六十万个对象，直接把堆撑爆。
  const byKey = new Map();
  // 一帧一帧解：整份解成一个字符串会撞 V8 单串上限（大镜像解压后 1.6 GB）。
  for (const text of iterFrameText(buf)) {
    for (const line of text.split("\n")) {
      const batch = [];
      pushParsedEvent(batch, line);
      for (const e of batch) {
        const seq = Number(e.seq);
        const key = Number.isFinite(seq) ? `s${seq}` : `h${e.type || ""}|${e.time || ""}|${line.length}`;
        byKey.set(key, e);
      }
    }
  }
  return { events: [...byKey.values()], frames: countFrames(buf) };
}

function readShadowed(dir) {
  const shadows = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return shadows;
  }
  for (const file of files) {
    const m = /^shadowed-(\d+)\.md$/.exec(file);
    if (!m) continue;
    try {
      shadows.set(Number(m[1]), fs.readFileSync(path.join(dir, file), "utf8"));
    } catch {
      /* 跳过读不到的快照 */
    }
  }
  return shadows;
}

function readRetracts(file) {
  const rows = [];
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return rows;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* 坏行跳过 */
    }
  }
  return rows;
}

function directoryBytes(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return total;
  }
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += directoryBytes(target);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(target).size;
      } catch {
        /* 跳过读不到的条目 */
      }
    }
  }
  return total;
}

function listSessions(root) {
  const sessions = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return sessions;
  }
  // 先用镜像自己记的 index.json：`list` 不该把每个会话的整份 zstd 解一遍。
  // 索引里没有的（旧目录、索引被裁掉）才回退去数帧。
  let index = {};
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) index = raw;
  } catch {
    index = {};
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let events = Number(index[entry.name]?.events);
    if (!Number.isFinite(events)) {
      try {
        events = readEvents(path.join(dir, "events.jsonl.zstd")).length;
      } catch {
        events = 0;
      }
    }
    let shadows = 0;
    try {
      shadows = fs.readdirSync(dir).filter((f) => /^shadowed-\d+\.md$/.test(f)).length;
    } catch {
      shadows = 0;
    }
    sessions.push({ id: entry.name, events, shadows, bytes: directoryBytes(dir) });
  }
  sessions.sort((a, b) => b.events - a.events || a.id.localeCompare(b.id));
  return sessions;
}

function findSessionLog(sid) {
  const sessionsRoot = path.join(dshHome(), "sessions");
  let buckets = [];
  try {
    buckets = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    const sdir = path.join(sessionsRoot, bucket.name, sid);
    let files = [];
    try {
      if (!fs.statSync(sdir).isDirectory()) continue;
      files = fs.readdirSync(sdir);
    } catch {
      continue;
    }
    const exact = files.find((file) => file === "session.v4.jsonl.zstd");
    if (exact) return path.join(sdir, exact);
    const hit = files.find((file) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(file));
    if (hit) return path.join(sdir, hit);
  }
  return null;
}

function estimateTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/^\s$/u.test(ch)) continue;
    const cp = ch.codePointAt(0);
    if ((cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xff00 && cp <= 0xffef)) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.round(cjk * 0.72 + other / 3.6);
}

function cmdList(opts) {
  const root = opts.dir || path.join(dshHome(), "purge-flash-raw");
  const sessions = listSessions(root);
  if (sessions.length === 0) {
    process.stdout.write("镜像里还没有会话。\n");
    return 0;
  }
  const lines = sessions.map(
    (s) => `${s.id}  ${s.events}  ${s.shadows}  ${(s.bytes / 1024).toFixed(1)} KB`,
  );
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

function cmdRecover(opts) {
  const rawSid = opts._[0];
  if (!rawSid) {
    process.stderr.write(`缺少会话 ID\n${USAGE}`);
    return 2;
  }
  const root = opts.dir || path.join(dshHome(), "purge-flash-raw");
  const sid = String(rawSid).trim();
  const dir = path.join(root, sid);
  const eventsFile = path.join(dir, "events.jsonl.zstd");
  if (!fs.existsSync(eventsFile)) {
    process.stderr.write(`镜像里没有会话 ${rawSid}\n`);
    return 1;
  }

  let events = [];
  try {
    events = readEvents(eventsFile);
  } catch {
    events = [];
  }
  const shadows = readShadowed(dir);
  const retracts = readRetracts(path.join(dir, "retract.jsonl"));

  const out = [
    `# 会话 ${sid} 完整转录`,
    "",
    `镜像事件 ${events.length} 条；遮蔽快照 ${shadows.size} 段；自我撤回标记 ${retracts.length} 处。`,
    "",
    "> ⚠️ 标记的段落是 UI 上已经看不见、但磁盘上还在的原文。",
    "",
  ];

  for (const event of events) {
    const md = eventToMd(event);
    if (md) {
      out.push(md, "");
    }
  }

  if (shadows.size > 0) {
    out.push("---", "", "## 被遮蔽的原文（UI 上已消失）", "");
    for (const seq of [...shadows.keys()].sort((a, b) => a - b)) {
      const body = String(shadows.get(seq) ?? "").replace(/\n+$/, "");
      out.push(`> ⚠️ 遮蔽事件 seq=${seq}`, "", body, "");
    }
  }

  if (retracts.length > 0) {
    out.push("---", "", "## 自我撤回标记", "");
    for (const row of retracts) {
      out.push(`- ${row.when}（偏移 ${row.at}）：…${row.around}…`);
    }
    out.push("");
  }

  const text = out.join("\n");
  process.stdout.write(text);

  if (opts.out) {
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    fs.writeFileSync(opts.out, text, "utf8");
  }
  return 0;
}

function cmdVerify(opts) {
  const rawSid = opts._[0];
  if (!rawSid) {
    process.stderr.write(`缺少会话 ID\n${USAGE}`);
    return 2;
  }
  const root = opts.dir || path.join(dshHome(), "purge-flash-raw");
  const sid = String(rawSid).trim();
  const dir = path.join(root, sid);
  if (!fs.existsSync(dir)) {
    process.stderr.write(`镜像里没有会话 ${rawSid}\n`);
    return 1;
  }

  let mirrorEvents = 0;
  let frames = 0;
  const eventsFile = path.join(dir, "events.jsonl.zstd");
  if (fs.existsSync(eventsFile)) {
    try {
      const result = readEventsWithFrames(eventsFile);
      mirrorEvents = result.events.length;
      frames = result.frames;
    } catch {
      mirrorEvents = 0;
      frames = 0;
    }
  }

  let sourceEvents = 0;
  const logFile = findSessionLog(sid);
  if (logFile) {
    try {
      sourceEvents = readEvents(logFile).length;
    } catch {
      sourceEvents = 0;
    }
  }

  const out = [
    `会话 ${sid}`,
    `镜像事件 ${mirrorEvents} 条 / ${frames} 帧`,
    `原日志事件 ${sourceEvents} 条`,
  ];
  if (mirrorEvents >= sourceEvents) {
    out.push("镜像覆盖完整。");
  } else {
    out.push(`⚠️ 原日志比镜像多 ${sourceEvents - mirrorEvents} 条 → 日志可能被截断，以镜像为准。`);
  }
  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}

async function cmdCost(opts) {
  const file = opts._[0];
  if (!file) {
    process.stderr.write(`缺少文件路径\n${USAGE}`);
    return 2;
  }
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    process.stderr.write(`读不到文件 ${file}\n`);
    return 1;
  }
  // lib/kernel.js 里有骨架 + 四份风格 + 注释 + 代码，直接量整文件会把注释算进去。
  // 这里不解析源码，而是直接渲染四份内核，量真正进 system prompt 的那份文本。
  const out = [];
  let kernels = null;
  try {
    kernels = await import(pathToFileURL(path.resolve(file)).href);
  } catch {
    kernels = null;
  }
  if (kernels && typeof kernels.renderKernel === "function" && Array.isArray(kernels.FAMILIES)) {
    const rows = kernels.FAMILIES
      .map((f) => {
        const t = kernels.renderKernel(f);
        return { name: f, chars: t.length, tok: estimateTokens(t) };
      })
      .sort((a, b) => b.chars - a.chars);
    out.push(`内核实际内容（按家族渲染，即真正进 system prompt 的文本）`);
    for (const r of rows) {
      out.push(`  ${r.name.padEnd(14)} ${String(r.chars).padStart(5)} 字符 ≈ ${String(r.tok).padStart(4)} tok`);
    }
    out.push(`  常驻只装一份 → 取最大者 ${rows[0].chars} 字符 ≈ ${rows[0].tok} tok`);
    if (typeof kernels.renderTail === "function") {
      // 尾部回声对所有家族是同一份，只算一次。
      const tail = kernels.renderTail(rows[0].name);
      const tailTok = estimateTokens(tail);
      out.push(`  尾部回声（order 10200，在最末尾再压一次） ${tail.length} 字符 ≈ ${tailTok} tok`);
      out.push(`  合计常驻 ${rows[0].chars + tail.length} 字符 ≈ ${rows[0].tok + tailTok} tok`);
    }
    out.push(`  对照：purge 默认注入 24,653 字符 ≈ 6,664 tok；冷咖啡 {{ROUTER}} ≈ 14,961 tok`);
    process.stdout.write(`${out.join("\n")}\n`);
    return 0;
  }
  const blocks = [...text.matchAll(/const\s+(DEEPSEEK|CLAUDE|OPENAI|GENERIC)\s*=\s*`([\s\S]*?)`;/g)];
  if (blocks.length > 0) {
    const rows = blocks
      .map((m) => ({ name: m[1], chars: m[2].length, tok: estimateTokens(m[2]) }))
      .sort((a, b) => b.chars - a.chars);
    out.push(`内核实际内容（已剔除注释与代码）`);
    for (const r of rows) {
      out.push(`  ${r.name.padEnd(9)} ${String(r.chars).padStart(5)} 字符 ≈ ${String(r.tok).padStart(4)} tok`);
    }
    out.push(`  常驻只装一份 → 取最大者 ${rows[0].chars} 字符 ≈ ${rows[0].tok} tok`);
    out.push(`  对照：purge 默认注入 24,653 字符 ≈ 6,664 tok；冷咖啡 {{ROUTER}} ≈ 14,961 tok`);
    process.stdout.write(`${out.join("\n")}\n`);
    return 0;
  }

  const chars = text.length;
  const tok = estimateTokens(text);
  out.push(`${file}  ${chars} 字符 ≈ ${tok} tok`);
  if (path.extname(file).toLowerCase() === ".md") {
    out.push(`若作常驻 system prompt，每 100 轮对话约 ${tok * 100} tok`);
  }
  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}

function cmdMigrate(opts) {
  const purgeDir = (process.env.PURGE_DIR || "").trim();
  const dir = purgeDir
    ? path.resolve(purgeDir)
    : path.resolve(dshHome(), "..", "dsh-purge");
  const file = path.join(dir, "lib", "default-prompt-inject.md");
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    process.stdout.write("没找到 dsh-purge 安装目录（可用 PURGE_DIR 指定）。\n");
    return 0;
  }
  const chars = text.length;
  const tok = estimateTokens(text);
  process.stdout.write(
    `purge 默认注入 ${chars} 字符 ≈ ${tok} tok；purge-flash 内核约 900 tok。\n`,
  );
  return 0;
}

function main(argv) {
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  const opts = parseArgs(argv.slice(1));
  switch (cmd) {
    case "list":
      return cmdList(opts);
    case "recover":
      return cmdRecover(opts);
    case "verify":
      return cmdVerify(opts);
    case "cost":
      return cmdCost(opts);
    case "migrate":
      return cmdMigrate(opts);
    default:
      process.stderr.write(`未知子命令 ${cmd}\n${USAGE}`);
      return 2;
  }
}

const invoked = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
if (invoked) {
  process.exitCode = await main(process.argv.slice(2));
}
