#!/usr/bin/env node
/**
 * 装配烟测：把插件真的挂进一个最小的 cordis 运行时，验证它能被系统当成插件加载。
 *
 *   node test/smoke-cordis.mjs
 *
 * 和 test/harness.mjs 的区别：
 *   harness 用假 ctx 测行为（快，可断言返回值）；
 *   smoketest 用真 cordis（宿主自己那份 4.0.5）测「能不能装进去」——
 *   验证 inject{}/apply{}/event 监听在真实 EventService 上都能正常注册。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/**
 * 找宿主的 cordis。smoke 测试要真 cordis 才有意义（验证能被当插件加载）。
 *
 * 顺序：
 *   1. CORDIS_PATH 环境变量（指向 cordis/lib/index.js）
 *   2. 从本仓库向上找 node_modules/@deepseek-ai/cordis（别人 clone 下来先 npm i 也能跑）
 *   3. DSH 桌面安装目录（本机）
 * 找不到就跳过（退出码 2），不算失败——smoke 是可选测试。
 */
function findCordis() {
  const cands = [];
  if (process.env.CORDIS_PATH) cands.push(process.env.CORDIS_PATH);
  // 向上找仓库内的 node_modules
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    cands.push(path.join(dir, "node_modules", "@deepseek-ai", "cordis", "lib", "index.js"));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // DSH 桌面安装目录：常见位置 + DSH_INSTALL + 从 DSH_HOME 反推
  const roots = [];
  if (process.env.DSH_INSTALL) roots.push(process.env.DSH_INSTALL);
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, "Programs", "deepseek official desktop"));
  if (process.env.ProgramFiles) roots.push(path.join(process.env.ProgramFiles, "deepseek official desktop"));
  roots.push("D:/AI/deepseek official desktop", "C:/Program Files/deepseek official desktop");
  for (const root of roots) {
    if (!root) continue;
    cands.push(
      path.join(root, "dsh", "resources", "app", "dsh", "node_modules", "@deepseek-ai", "cordis", "lib", "index.js"),
      path.join(root, "resources", "app", "dsh", "node_modules", "@deepseek-ai", "cordis", "lib", "index.js"),
    );
  }
  for (const c of cands) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return "";
}

const CORDIS_FILE = findCordis();
if (!CORDIS_FILE) {
  console.error("找不到宿主 cordis —— smoke 测试跳过（这是可选的，不算失败）");
  console.error("要跑就设 CORDIS_PATH=<cordis/lib/index.js>");
  process.exit(2);
}
const CORDIS = pathToFileURL(CORDIS_FILE).href;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pf-smoke-"));
process.env.DSH_HOME = tmp;

const { Context } = await import(CORDIS);
if (typeof Context !== "function") {
  console.error("拿不到 cordis Context 导出，smoke 跳过");
  process.exit(2);
}

const root = new Context();
let failures = 0;

function ok(name) {
  console.log(`  ok   ${name}`);
}
function bad(name, detail) {
  failures += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
}

console.log("1. 真 cordis 装配");

const plugin = await import("../lib/index.js");
let fiber;
try {
  fiber = root.plugin(plugin, {
    enabled: true,
    mirror: true,
    mirrorDir: "smoke-raw",
    rawStream: true,
    shadowSnapshot: true,
    prefillAnchor: true,
    repairOnRefusal: true,
    playbook: true,
  });
  await fiber;
  ok("root.plugin() 加载完成，没有抛错");
} catch (e) {
  bad("root.plugin() 抛错", String(e?.message || e));
}

// 从 fiber 里把 state 捞出来：apply 返回 state，cordis 把它存在 fiber 上不一定能读到，
// 所以换成经 /armor 命令来验证各层状态——这更接近真实使用路径。
console.log("\n2. 服务缺席时的行为（真 cordis 里没 systemPrompt / skills / commands）");
try {
  const ctx = root.ctx ?? root;
  const prompt = (() => {
    try {
      return ctx.get?.("systemPrompt");
    } catch {
      return undefined;
    }
  })();
  if (prompt === undefined) {
    ok("没有 systemPrompt 服务 —— 这是预期（我们没挂 dsh-system-prompt），插件不应因此抛错");
  } else {
    ok("意外拿到了 systemPrompt 服务（说明 root 里有别的东西），跳过该断言");
  }
} catch (e) {
  bad("读取服务抛错", String(e?.message || e));
}

console.log("\n3. 卸载不抛错");
try {
  if (fiber && typeof fiber.dispose === "function") {
    fiber.dispose();
    ok("fiber.dispose() 干净退出");
  } else if (fiber && typeof fiber[Symbol.dispose] === "function") {
    fiber[Symbol.dispose]();
    ok("fiber[Symbol.dispose]() 干净退出");
  } else {
    ok("fiber 没有 dispose 入口，跳过（cordis 会随 root 回收）");
  }
} catch (e) {
  bad("dispose 抛错", String(e?.message || e));
}

console.log("\n4. 镜像目录");
const mirrorRoot = path.join(tmp, "smoke-raw");
if (fs.existsSync(mirrorRoot)) {
  const rows = fs.readdirSync(mirrorRoot);
  ok(`镜像目录已建：${rows.length} 项`);
} else {
  // 没事件、没补录，目录可能还没建——不算失败，但要如实说。
  ok("镜像目录未建（本进程内没有任何会话事件，属预期）");
}

console.log(`\n${failures === 0 ? "smoke 通过" : "smoke 有失败"}：${failures} 处失败`);
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* ignore */
}
process.exit(failures === 0 ? 0 : 1);
