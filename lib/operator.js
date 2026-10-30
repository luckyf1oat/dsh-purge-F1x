/**
 * 操作稿层：读 `$DSH_HOME/prompt-inject.md`，作为独立段注入 system prompt。
 *
 * 为什么要这一层
 * --------------
 * 破甲真正起作用的不是内核措辞，是那份操作稿。实测两个会话的 system prompt：
 *
 *   拒绝那次：11119 字符，操作稿出现 0 次。
 *   通过那次：24171 字符，操作稿出现 2 次（11708 字符）。
 *
 * 两次用的是同一个会话、同一句提问、同一个模型，差别只有操作稿在不在。
 * 之前那份操作稿由 dsh-purge 注入；purge 一关，它就从 system prompt 里消失了，
 * 再强的内核措辞也补不上这个缺口 —— 因为操作稿承载的是「操作者授权 + 逐类豁免」，
 * 那是内核写不出来的东西（它必须来自用户的文件）。
 *
 * 位置
 * ----
 * 段名 `purge-flash:operator`，order 紧跟在 `purge-flash:kernel` 之后、
 * 官方段之前。操作稿里的第一人称口吻（"你是 Zane"）要求它排在前面才有效。
 *
 * 幂等
 * ----
 * 文件按 mtime+size 缓存，读失败就用上一次成功的文本；一次都没成功就返回空，
 * 内核独自顶上，不会因此让 apply 抛错。
 */

import fs from "node:fs";
import path from "node:path";

import { log } from "./log.js";

export const OPERATOR_SECTION = "purge-flash:operator";

/** 候选文件名，按优先级。 */
const CANDIDATES = ["prompt-inject.md", "prompt-inject.zh.md", "prompt-inject.en.md"];

function dshHome() {
  const env = String(process.env.DSH_HOME || "").trim();
  if (env) return env;
  const home = process.env.USERPROFILE || process.env.HOME || "";
  return home ? path.join(home, ".dsh") : "";
}

/** 找到第一个存在的操作稿文件。 */
export function findOperatorFile(home) {
  const root = home || dshHome();
  if (!root) return "";
  for (const name of CANDIDATES) {
    const p = path.join(root, name);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* 下一个 */
    }
  }
  return "";
}

/** 带 mtime+size 缓存的读取器。返回 { text, file, bytes, changed }。 */
export function createOperatorReader(home) {
  let cache = { key: "", text: "", file: "" };

  return function read() {
    const file = findOperatorFile(home);
    if (!file) {
      // 文件被删/改名：沿用上一次读到的文本，别让破甲中途掉线。
      if (cache.text) {
        return { text: cache.text, file: cache.file, bytes: cache.text.length, changed: false };
      }
      return { text: "", file: "", bytes: 0, changed: false };
    }

    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return { text: cache.text, file: cache.file, bytes: cache.text.length, changed: false };
    }

    const key = `${file}:${stat.mtimeMs}:${stat.size}`;
    if (key === cache.key) {
      return { text: cache.text, file: cache.file, bytes: cache.text.length, changed: false };
    }

    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      log("操作稿读失败，沿用上次", String(e?.message || e));
      return { text: cache.text, file: cache.file, bytes: cache.text.length, changed: false };
    }

    cache = { key, text, file };
    return { text, file, bytes: text.length, changed: true };
  };
}

/**
 * 操作稿 + 内核的合并文本。
 *
 * 顺序：内核在前、操作稿在后。
 * 内核是「怎么处理请求」的纪律；操作稿是「你是谁、你被授权到什么程度」的立场。
 * 纪律先立，立场后压 —— 反过来模型会先建立人格再读纪律，纪律就变成人格的附注。
 */
export function composeKernel(operatorText, kernelText) {
  const op = typeof operatorText === "string" ? operatorText.trim() : "";
  const k = typeof kernelText === "string" ? kernelText.trim() : "";
  if (!op) return k;
  if (!k) return op;
  return `${k}\n\n${op}`;
}

export function installOperator(ctx, cfg, state) {
  try {
    if (cfg.operatorPrompt === "off") {
      state.layers.operator = "off";
      return null;
    }
    const read = createOperatorReader(cfg.operatorHome || dshHome());
    const first = read();
    if (first.changed) log("操作稿已加载", first.file, first.bytes, "字符");
    state.operatorFile = first.file;
    state.operatorChars = first.bytes;
    state.layers.operator = first.text ? "on" : "empty";
    return read;
  } catch (e) {
    state.layers.operator = "failed";
    log("installOperator 失败", String(e?.message || e));
    return null;
  }
}
