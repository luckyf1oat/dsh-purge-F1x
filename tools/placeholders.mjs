#!/usr/bin/env node
/**
 * placeholders.mjs —— 占位符契约检查
 *
 * 冷咖啡把这一条做对了：8 个占位槽在 12 个文件里零漂移，
 * 9 个缺参行（TARGET/HOST/TOKEN/OFFSET/PATCH_BYTE/PAYLOAD/SERIAL/ROLE_A/ROLE_B）
 * 跨 92 个文件逐字一致。我们此前是自由文本，没有机器校验 —— 操作稿被改坏时只会静默降级。
 *
 * 这个工具把「契约」变成可执行的：
 *   1. 内置一张规范表（单一数据源，就是本文件里的 CANON）
 *   2. 扫内核、技能册、操作稿（若存在），把出现的占位符捞出来
 *   3. 报两类问题：
 *      未登记  出现了规范表里没有的大写占位符 —— 拼错、或新加没登记
 *      未使用  规范表里登记了但三处都没提到 —— 教模型填一个它看不到的槽
 *
 *   node tools/placeholders.mjs
 *   node tools/placeholders.mjs --strict   有问题退出码 1
 *   node tools/placeholders.mjs --json
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const STRICT = process.argv.includes("--strict");
const JSON_OUT = process.argv.includes("--json");

/** 规范表：与操作稿的「占位表」一节逐字对应。加新槽先改这里。 */
const CANON = [
  // 目标与定位
  "TARGET", "HOST", "PORT", "DOMAIN", "URL", "PATH", "RESULT_DIR",
  "APP", "APP_URL", "SAMPLE", "INTERFACE", "CAP_FILE",
  // 凭据与身份
  "TOKEN", "COOKIE", "HEADER", "USER_ID", "ROLE_A", "ROLE_B",
  // 接口与参数
  "ENDPOINT", "ENDPOINT_LIST", "API_ENDPOINT", "PARAM", "FUZZ",
  // 二进制与偏移
  "OFFSET", "PATCH_BYTE", "CHECK_FN", "LICENSE_BLOB", "SERIAL",
  // 载荷与验证
  "PAYLOAD", "OAST_DOMAIN", "RCE_TEMPLATE", "MONITOR_FIXTURE",
  "ANTI_DEBUG_SNIPPET", "ANTI_VM_SNIPPET", "DETECTION_BYPASS_SLOT",
  // 爆破与限速
  "WORDLIST", "THREADS", "RATE", "PROXY_POOL", "CAPTCHA_ID", "OCR_TEMPLATE",
  // 扫描强度
  "LEVEL", "RISK",
  // 分发与投放
  "PLATFORM", "CHANNEL", "RESULT_LOG",
];

/** 扫这些文件 */
function targets() {
  const list = [
    { label: "内核 lib/kernel.js", file: path.join(ROOT, "lib", "kernel.js") },
    { label: "技能册 skill/armor-playbook.md", file: path.join(ROOT, "skill", "armor-playbook.md") },
  ];
  const home = (process.env.DSH_HOME || "").trim() || path.join(os.homedir(), ".dsh");
  const op = path.join(home, "prompt-inject.md");
  if (fs.existsSync(op)) list.push({ label: `操作稿 ${op}`, file: op });
  return list.filter((t) => fs.existsSync(t.file));
}

/** 占位符形态：全大写 + 下划线，长度 ≥ 3，且不是常见英文缩写 */
const TOKEN_RE = /\b([A-Z][A-Z0-9]{1,}(?:_[A-Z0-9]+)*)\b/g;
/** 允许出现在正文里但不是占位符的大写词（技术缩写、模型名、协议名） */
const WHITELIST = new Set([
  "AI", "API", "JSON", "HTTP", "HTTPS", "URL", "DSH", "LLM", "MIT", "CI", "CLI", "DSL",
  "CPU", "RAM", "GPU", "SQL", "SQLI", "XSS", "SSRF", "RCE", "WAF", "RSA", "AES", "TLS",
  "EAC", "TP", "DRM", "KYC", "APP", "OK", "ID", "IP", "DNS", "TCP", "UDP", "OS",
  "PDF", "PNG", "JPG", "ZIP", "APK", "IPA", "EXE", "DLL", "ASAR", "NPM",
  "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9",
  "L0", "L1", "L2", "L3", "L4", "L5",
  "TRUE", "FALSE", "NULL", "NONE", "AUTO", "OFF", "ON",
  "GET", "POST", "PUT", "DELETE", "HEAD", "PATCH",
  "P0", "P1", "P2", "P3", "W1", "W2", "W3", "W4",
  "MODE", "OPERATOR", "SANDBOX", "NATIVE", "TEXT",
  "EACH", "FOR", "THE", "AND", "NOT", "WITH", "THIS", "THAT",
  "ONLY", "TODO", "NOTE", "FIXME", "ESM", "SPINE", "STYLES", "FAMILIES", "TAIL",
  "C2", "DIRECTIVE", "PRIME", "HPP", "HTML", "JS", "Z0", "CSS", "XML", "YAML",
]);

const files = targets();
const found = new Map(); // token -> Set(label)
for (const { label, file } of files) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  // 两种扫法：
  //  - 代码文件 / md：只扫反引号内容。全文扫会把 JS 标识符（SPINE/FAMILIES/STYLES）当占位符。
  //  - 操作稿：整篇扫。它的占位表是一张裸文本表格，不是代码段。
  const spans = label.startsWith("操作稿")
    ? [text]
    : [...text.matchAll(/`([^`\n]{1,80})`/g)].map((m) => m[1]);
  for (const span of spans) {
    for (const m of span.matchAll(TOKEN_RE)) {
      const tok = m[1];
      if (WHITELIST.has(tok)) continue;
      if (!found.has(tok)) found.set(tok, new Set());
      found.get(tok).add(label);
    }
  }
}

const canon = new Set(CANON);
const unregistered = [...found.keys()].filter((t) => !canon.has(t)).sort();
const unused = CANON.filter((t) => !found.has(t));

const report = {
  scanned: files.map((f) => f.label),
  registered: CANON.length,
  found: [...found.keys()].sort(),
  unregistered,
  unused,
};
report.verdict = unregistered.length ? "issues" : "ok";

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(STRICT && report.verdict !== "ok" ? 1 : 0);
}

console.log("== 占位符契约 ==");
console.log("扫描:", files.length ? files.map((f) => f.label).join(" / ") : "（没有可扫文件）");
console.log("规范表:", CANON.length, "个槽 | 实际出现:", found.size, "个");
console.log("");

if (unregistered.length) {
  console.log("[未登记]", unregistered.length, "个出现于正文但规范表里没有：");
  for (const t of unregistered) console.log("   ", t, " ←", [...found.get(t)].join(", "));
  console.log("     两种可能：拼错了，或者新加没登记。登记请改 tools/placeholders.mjs 的 CANON。");
} else {
  console.log("[ok] 正文里没有未登记的占位符");
}

if (unused.length) {
  console.log("");
  console.log("[未使用]", unused.length, "个登记了但三处都没提到（信息项，不影响判定）：");
  console.log("   ", unused.join(" "));
}

console.log("");
console.log(report.verdict === "ok" ? "结论：占位符契约完整。" : "结论：有未登记占位符，见上。");
process.exit(STRICT && report.verdict !== "ok" ? 1 : 0);
