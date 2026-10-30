/**
 * 反撤回镜像：把每条原始事件、每个流块、每段被遮蔽的原文，只追加地写进独立目录。
 *
 * 为什么需要它
 * ------------
 * DSH 的会话日志是事件溯源、只追加的。「撤回」「压缩」「修剪」都不删数据，
 * 只是在 surface 投影层追加一条 replace 事件把旧节点遮住。所以原文一直在磁盘上。
 *
 * 真正会丢东西的地方只有三处：
 *   1. persistence 的 repair() 把日志 truncate 到某个 offset（崩溃尾、坏尾）；
 *   2. 模型自己在回复里说「上面的回答作废」——它不是删，是覆盖，但你看到的是新版；
 *   3. UI 上点了撤回，界面里没了，而你又没留下副本。
 *
 * 本模块对三处都留副本：事件镜像（多帧 zstd）、流块明文、遮蔽前快照。
 *
 * 纪律
 * ----
 * 永不抛错。所有 IO 失败吞掉记一行。镜像丢了不影响聊天，镜像抛错会拖死宿主。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { log, warnOnce } from "./log.js";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const FLUSH_MS = 2000;
const INDEX_CAP = 512;
const BACKFILL_EVERY_MS = 60_000;
/** 补录只吃最近这么多个会话——别把几百个历史会话全解一遍。 */
const BACKFILL_MAX_SESSIONS = 40;
/** 单会话日志超过这个大小就不补录（解几万帧的代价远大于收益）。 */
const BACKFILL_MAX_BYTES = 24 * 1024 * 1024;

export function dshHome() {
  const fromEnv = (process.env.DSH_HOME || "").trim();
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), ".dsh");
}

/** 解一个多帧 zstd 缓冲；非 zstd 当明文。 */
export function decodeMultiFrame(buf, depth = 0) {
  if (!buf || buf.length === 0) return "";
  const head = buf.subarray(0, 4).toString("latin1");
  const isZstd = buf.length >= 4 && buf.subarray(0, 4).equals(MAGIC);
  if (!isZstd) return buf.toString("utf8");
  if (typeof zlib.zstdDecompressSync !== "function") {
    warnOnce("no-zstd", "当前 Node 没有 zlib.zstdDecompressSync（需 >= 22.15）；镜像只能写不能读。");
    return "";
  }
  const offsets = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    offsets.push(i);
    i += 4;
  }
  if (offsets.length === 0) return "";
  const parts = [];
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    if (end <= start) continue;
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)));
    } catch {
      /* 半帧：崩溃时最后一条，跳过 */
    }
  }
  void head;
  void depth;
  return Buffer.concat(parts).toString("utf8");
}

function readLog(file) {
  const buf = fs.readFileSync(file);
  if (!file.endsWith(".zstd")) return { text: buf.toString("utf8"), frames: 0 };
  let frames = 0;
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    frames += 1;
    i += 4;
  }
  return { text: decodeMultiFrame(buf), frames };
}

const SESSION_FILE_RE = /^session\.v\d+\.jsonl(\.zstd)?$/;

function sessionLogs(root) {
  const out = [];
  let buckets = [];
  try {
    buckets = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    const bdir = path.join(root, bucket.name);
    let dirs = [];
    try {
      dirs = fs.readdirSync(bdir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const sdir = path.join(bdir, d.name);
      let files = [];
      try {
        files = fs.readdirSync(sdir);
      } catch {
        continue;
      }
      const hit = files.find((f) => SESSION_FILE_RE.test(f));
      if (hit) out.push({ id: d.name, file: path.join(sdir, hit) });
    }
  }
  return out;
}

function safeSid(id) {
  const s = String(id || "").trim();
  if (!s) return "";
  return s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
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

/** 事件 → Markdown 行。不是消息类返回 null。 */
function eventToMd(event) {
  const type = event?.type;
  const data = event?.data || {};
  if (type === "user/message") {
    const text = textOfContent(data.content);
    if (!text) return null;
    const kind = data?.source?.kind || "user";
    return `### [${event.seq}] user · ${kind}\n\n${text}\n`;
  }
  if (type === "assistant/message") {
    const msg = data.message || {};
    const text = textOfContent(msg.content);
    const toolCount = Array.isArray(msg.content)
      ? msg.content.filter((b) => b && b.type === "tool-call").length
      : 0;
    if (!text && toolCount === 0) return null;
    const note = toolCount > 0 ? `\n_(含 ${toolCount} 个 tool-call)_\n` : "";
    return `### [${event.seq}] assistant\n\n${text}${note}\n`;
  }
  if (type === "system/message") {
    const text = textOfContent(data?.message?.content);
    if (!text) return null;
    const short = text.length > 400 ? `${text.slice(0, 400)}…（共 ${text.length} 字符）` : text;
    return `### [${event.seq}] system\n\n> ${short.replace(/\n/g, "\n> ")}\n`;
  }
  return null;
}

export function createMirror(cfg, home = dshHome()) {
  const root = path.join(home, cfg.mirrorDir || "purge-flash-raw");
  const indexFile = path.join(root, "index.json");
  const sessionsRoot = path.join(home, "sessions");

  /** sid → { events: number, lastSeq: number } */
  let index = {};
  /** sid → 待刷事件 */
  let pending = new Map();
  let timer = null;
  let closed = false;
  let lastBackfill = 0;
  const streamFds = new Map();

  try {
    fs.mkdirSync(root, { recursive: true });
    const raw = JSON.parse(fs.readFileSync(indexFile, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) index = raw;
  } catch {
    index = {};
  }

  const dirOf = (sid) => path.join(root, sid);
  const eventsFile = (sid) => path.join(dirOf(sid), "events.jsonl.zstd");
  const streamFile = (sid, turn, step) => path.join(dirOf(sid), "stream", `${turn}-${step}.jsonl`);
  const shadowFile = (sid, seq) => path.join(dirOf(sid), `shadowed-${seq}.md`);
  const retractFile = (sid) => path.join(dirOf(sid), "retract.jsonl");

  function writeAtomic(file, text) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, text, "utf8");
      fs.renameSync(tmp, file);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  function saveIndex() {
    const entries = Object.entries(index);
    if (entries.length > INDEX_CAP) {
      entries.sort((a, b) => (b[1]?.lastSeen || 0) - (a[1]?.lastSeen || 0));
      index = Object.fromEntries(entries.slice(0, INDEX_CAP));
    }
    writeAtomic(indexFile, JSON.stringify(index));
  }

  function commit() {
    if (closed) return false;
    let wrote = false;
    try {
      for (const [sid, events] of pending) {
        if (events.length === 0) continue;
        const text = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
        const frame = zlib.zstdCompressSync(Buffer.from(text, "utf8"));
        try {
          fs.mkdirSync(dirOf(sid), { recursive: true });
          fs.appendFileSync(eventsFile(sid), frame);
          const slot = (index[sid] ??= { events: 0, lastSeq: -1, firstSeen: Date.now() });
          slot.events += events.length;
          slot.lastSeq = Math.max(slot.lastSeq, ...events.map((e) => Number(e?.seq) || 0));
          slot.lastSeen = Date.now();
          slot.bytes = (slot.bytes || 0) + frame.length;
          wrote = true;
        } catch (e) {
          log("mirror 写失败", sid, String(e?.message || e));
        }
      }
      pending = new Map();
      if (wrote) saveIndex();
    } catch (e) {
      log("mirror commit 失败", String(e?.message || e));
    }
    return wrote;
  }

  function schedule() {
    if (timer !== null || closed) return;
    timer = setTimeout(() => {
      timer = null;
      commit();
    }, FLUSH_MS);
    if (typeof timer.unref === "function") timer.unref();
  }

  function pushEvent(sid, event) {
    if (!sid || !event) return;
    const list = pending.get(sid);
    if (list === undefined) pending.set(sid, [event]);
    else list.push(event);
    schedule();
  }

  /**
   * 启动补录：磁盘上已有、但镜像里还没有的事件。
   *
   * 有上限，别把历史全吃进来。第一次装插件时 ~/.dsh/sessions 下可能有几百个
   * 旧会话（实测 469 个 / 106 MB），全量补录既慢又没必要——那些会话你早走完了，
   * 而且真要看原文，原日志还在。只补「最近的」和「正在进行的」。
   */
  function backfill(force = false) {
    const now = Date.now();
    if (!force && now - lastBackfill < 3000) return 0;
    lastBackfill = now;

    // 按 mtime 取最近的 BACKFILL_MAX_SESSIONS 个；再从大到小排，先补活跃的。
    let all = sessionLogs(sessionsRoot);
    if (all.length > BACKFILL_MAX_SESSIONS) {
      all = all
        .map((row) => {
          try {
            return { ...row, mtime: fs.statSync(row.file).mtimeMs };
          } catch {
            return { ...row, mtime: 0 };
          }
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, BACKFILL_MAX_SESSIONS);
    }

    let added = 0;
    for (const { id, file } of all) {
      let text;
      try {
        const size = (() => {
          try {
            return fs.statSync(file).size;
          } catch {
            return 0;
          }
        })();
        // 单个超大日志跳过：补录它要解几万帧，收益远小于开销。
        if (size > BACKFILL_MAX_BYTES) continue;
        text = readLog(file).text;
      } catch {
        continue;
      }
      const have = index[id]?.events ?? 0;
      const events = [];
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          /* 半行 */
        }
      }
      if (events.length <= have) continue;
      pushEvent(id, events.slice(have));
      added += events.length - have;
    }
    if (added > 0) commit();
    return added;
  }

  /** 遮蔽前快照：把即将被盖住的原文写出来。 */
  function snapshotShadowed(session, event) {
    if (!cfg.shadowSnapshot) return "";
    const op = event?.surfaceOp;
    if (!op || op.op !== "replace") return "";
    const sid = safeSid(session?.id);
    if (!sid) return "";
    const startSeq = Number(op.startSeq);
    const endSeq = Number(op.endSeq);
    if (!Number.isFinite(startSeq) || !Number.isFinite(endSeq)) return "";
    const seqs = Array.isArray(event?.sourceEventSeqs) && event.sourceEventSeqs.length > 0
      ? event.sourceEventSeqs.map(Number).filter((n) => Number.isFinite(n))
      : [];
    const span = [];
    for (let s = startSeq; s <= endSeq; s += 1) span.push(s);
    const all = [...new Set([...seqs, ...span])].sort((a, b) => a - b);
    const lines = [
      `<!-- 被遮蔽区间 ${startSeq}..${endSeq}，遮蔽事件 seq=${event.seq}，时间 ${new Date().toISOString()} -->`,
      "",
    ];
    let took = 0;
    for (const seq of all) {
      let orig;
      try {
        orig = typeof session?.eventAt === "function" ? session.eventAt(seq) : undefined;
      } catch {
        orig = undefined;
      }
      if (!orig) continue;
      const md = eventToMd(orig);
      if (!md) continue;
      lines.push(md);
      took += 1;
    }
    if (took === 0) return "";
    const file = shadowFile(sid, event.seq ?? startSeq);
    writeAtomic(file, lines.join("\n"));
    return file;
  }

  function recordRetraction(sid, info, text) {
    const safe = safeSid(sid);
    if (!safe || !info || info.hit !== true) return;
    const row = {
      at: info.at,
      when: new Date().toISOString(),
      around: String(text || "").slice(Math.max(0, info.at - 80), info.at + 160),
    };
    try {
      fs.mkdirSync(dirOf(safe), { recursive: true });
      fs.appendFileSync(retractFile(safe), `${JSON.stringify(row)}\n`);
    } catch (e) {
      log("retract 记录失败", String(e?.message || e));
    }
  }

  async function* teeStream(sid, turn, step, iterable) {
    const safe = safeSid(sid);
    if (!cfg.rawStream || !safe) {
      yield* iterable;
      return;
    }
    const file = streamFile(safe, String(turn ?? 0), String(step ?? 0));
    const key = `${safe}:${turn}:${step}`;
    let fd = -1;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fd = fs.openSync(file, "a");
      streamFds.set(key, fd);
    } catch (e) {
      log("stream 打开失败", String(e?.message || e));
      fd = -1;
    }
    try {
      for await (const chunk of iterable) {
        if (fd >= 0) {
          try {
            fs.writeSync(fd, `${JSON.stringify(chunk)}\n`);
          } catch (e) {
            log("stream 写失败", String(e?.message || e));
          }
        }
        yield chunk;
      }
    } finally {
      if (fd >= 0) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      streamFds.delete(key);
    }
  }

  function readStreamRaw(sid, turn, step) {
    const safe = safeSid(sid);
    if (!safe) return "";
    const file = streamFile(safe, String(turn ?? 0), String(step ?? 0));
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return "";
    }
  }

  function listSessions() {
    const out = [];
    let dirs = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const meta = index[d.name] || {};
      let bytes = 0;
      let shadows = 0;
      try {
        const files = fs.readdirSync(path.join(root, d.name));
        for (const f of files) {
          try {
            bytes += fs.statSync(path.join(root, d.name, f)).size;
          } catch {
            /* ignore */
          }
          if (f.startsWith("shadowed-")) shadows += 1;
        }
      } catch {
        /* ignore */
      }
      out.push({ id: d.name, bytes, events: meta.events || 0, shadows, lastSeen: meta.lastSeen || 0 });
    }
    out.sort((a, b) => b.lastSeen - a.lastSeen);
    return out;
  }

  function recover(sid) {
    const safe = safeSid(sid);
    if (!safe) return "";
    let text = "";
    try {
      text = decodeMultiFrame(fs.readFileSync(eventsFile(safe)));
    } catch {
      text = "";
    }
    const events = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* ignore */
      }
    }
    const shadows = new Map();
    try {
      for (const f of fs.readdirSync(dirOf(safe))) {
        const m = /^shadowed-(\d+)\.md$/.exec(f);
        if (m) shadows.set(Number(m[1]), fs.readFileSync(path.join(dirOf(safe), f), "utf8"));
      }
    } catch {
      /* ignore */
    }
    const retracts = [];
    try {
      for (const line of fs.readFileSync(retractFile(safe), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          retracts.push(JSON.parse(line));
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }

    // 三样都没有 = 这个会话不在镜像里。返回空串，让调用方明确报「没有」，
    // 而不是给一份只有标题的空转录、让人以为恢复成功了。
    if (events.length === 0 && shadows.size === 0 && retracts.length === 0) return "";

    const out = [
      `# 会话 ${safe} 完整转录`,
      "",
      `镜像事件 ${events.length} 条；遮蔽快照 ${shadows.size} 段；自我撤回标记 ${retracts.length} 处。`,
      "",
      "> ⚠️ 标记的段落是 UI 上已经看不见、但磁盘上还在的原文。",
      "",
    ];
    for (const event of events) {
      const md = eventToMd(event);
      if (md) out.push(md);
    }
    if (shadows.size > 0) {
      out.push("", "---", "", "## 被遮蔽的原文（UI 上已消失）", "");
      for (const seq of [...shadows.keys()].sort((a, b) => a - b)) {
        out.push(`> ⚠️ 遮蔽事件 seq=${seq}`, "", shadows.get(seq), "");
      }
    }
    if (retracts.length > 0) {
      out.push("", "---", "", "## 自我撤回标记", "");
      for (const r of retracts) out.push(`- ${r.when}（偏移 ${r.at}）：…${r.around}…`);
      out.push("");
    }
    return out.join("\n");
  }

  function verify(sid) {
    const safe = safeSid(sid);
    const result = { id: safe, events: 0, frames: 0, sourceEvents: 0, truncated: false, mirrored: fs.existsSync(eventsFile(safe)) };
    if (!safe) return result;
    try {
      const buf = fs.readFileSync(eventsFile(safe));
      let i = 0;
      while ((i = buf.indexOf(MAGIC, i)) !== -1) {
        result.frames += 1;
        i += 4;
      }
      const text = decodeMultiFrame(buf);
      result.events = text.split("\n").filter(Boolean).length;
    } catch {
      /* ignore */
    }
    for (const { id, file } of sessionLogs(sessionsRoot)) {
      if (id !== safe) continue;
      try {
        const { text } = readLog(file);
        result.sourceEvents = text.split("\n").filter(Boolean).length;
      } catch {
        /* ignore */
      }
    }
    result.truncated = result.events > 0 && result.sourceEvents > result.events;
    return result;
  }

  function stats() {
    const sessions = listSessions();
    return {
      root,
      sessions: sessions.length,
      bytes: sessions.reduce((a, b) => a + b.bytes, 0),
      events: sessions.reduce((a, b) => a + b.events, 0),
      shadows: sessions.reduce((a, b) => a + b.shadows, 0),
      pending: pending.size,
      openStreams: streamFds.size,
    };
  }

  const tick = setInterval(() => {
    if (closed) return;
    commit();
    const added = backfill();
    if (added > 0) log("补录", added, "条事件");
  }, 15_000);
  if (typeof tick.unref === "function") tick.unref();

  return {
    pushEvent,
    teeStream,
    readStreamRaw,
    snapshotShadowed,
    recordRetraction,
    recover,
    verify,
    list: listSessions,
    stats,
    backfill,
    flush: commit,
    dirOf,
    root,
    dispose() {
      closed = true;
      try {
        clearInterval(tick);
      } catch {
        /* ignore */
      }
      try {
        if (timer !== null) clearTimeout(timer);
      } catch {
        /* ignore */
      }
      for (const fd of streamFds.values()) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      streamFds.clear();
      commit();
    },
  };
}

export { BACKFILL_EVERY_MS };
