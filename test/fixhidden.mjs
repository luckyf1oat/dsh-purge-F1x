#!/usr/bin/env node
/**
 * fix-hidden 自测：不需要 DSH，不需要真的 workspace.json。
 *
 *   node test/fixhidden.mjs
 *
 * 在临时目录里造一份 DSH_HOME，跑 bin/fix-hidden.mjs 的子进程，
 * 只断言对外可见的行为：退出码、写盘结果、dry-run 不写盘、--keep、--restore。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const SCRIPT = path.resolve(import.meta.dirname, "..", "bin", "fix-hidden.mjs");

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
  }
}

/** 跑子进程，返回 { code, stdout, stderr }，非零退出不抛 */
function run(home, args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, "--home", home, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function writeSession(home, id, header, extraFrame = false) {
  const dir = path.join(home, "sessions", "--proj--", id);
  fs.mkdirSync(dir, { recursive: true });
  const frames = [zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`))];
  if (extraFrame) frames.push(zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ type: "turn" })}\n`)));
  fs.writeFileSync(path.join(dir, "session.v4.jsonl.zstd"), Buffer.concat(frames));
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fixhidden-"));
  fs.mkdirSync(path.join(home, "storages"), { recursive: true });
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });

  const A = "/proj/a";
  const B = "/proj/b";
  const ws = {
    global: { archivedSessionIds: ["s1", "s2", "s3"], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        wa: { path: A, sessionIds: ["s1", "keep1"], updatedAt: "x" },
        wb: { path: B, sessionIds: ["keep2"], updatedAt: "x" },
      },
    },
  };
  fs.writeFileSync(path.join(home, "storages", "workspace.json"), JSON.stringify(ws, null, 2));

  // s1：还在槽位里，但被归档 → 藏在槽位
  writeSession(home, "s1", { type: "session", version: 4, id: "s1", cwd: A });
  // s2：已脱槽，cwd 指向工作区 A → 应挂回 A。多帧，验 header 只吃第一帧
  writeSession(home, "s2", { type: "session", version: 4, id: "s2", cwd: A }, true);
  // s3：已脱槽，cwd 不在任何工作区 → 落到未分组
  writeSession(home, "s3", { type: "session", version: 4, id: "s3", cwd: "/nowhere" });
  // 干净会话，不受影响
  writeSession(home, "keep1", { type: "session", version: 4, id: "keep1", cwd: A });

  return { home, A, B, wsPath: path.join(home, "storages", "workspace.json") };
}

function read(home) {
  return JSON.parse(fs.readFileSync(path.join(home, "storages", "workspace.json"), "utf8"));
}

console.log("\n1. --verify");
{
  const { home } = makeHome();
  const r = run(home, ["--verify"]);
  check("退出码 0", () => assert.equal(r.code, 0));
  check("报出归档数 3", () => assert.match(r.stdout, /归档集合\s+:\s+3/));
  check("区分槽内 1 / 脱槽 2", () => assert.match(r.stdout, /其中 1 条藏在工作区槽位里、2 条已脱槽/));
  check("提示要清", () => assert.match(r.stdout, /--apply/));
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n2. --verify --json");
{
  const { home } = makeHome();
  const r = run(home, ["--verify", "--json"]);
  check("是合法 JSON", () => {
    const j = JSON.parse(r.stdout);
    assert.equal(j.archived, 3);
    assert.equal(j.archivedHiddenInSlot, 1);
    assert.equal(j.archivedDetached, 2);
    assert.equal(j.slots, 3);
    assert.equal(j.sessionFiles, 4);
  });
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n3. dry-run 不写盘");
{
  const { home, wsPath } = makeHome();
  const before = fs.readFileSync(wsPath, "utf8");
  const r = run(home, []);
  check("退出码 0", () => assert.equal(r.code, 0));
  check("说未写盘", () => assert.match(r.stdout, /dry-run/));
  check("文件字节没变", () => assert.equal(fs.readFileSync(wsPath, "utf8"), before));
  check("列出可挂回 1 条", () => assert.match(r.stdout, /可挂回原工作区\s+:\s+1/));
  check("列出未分组 1 条", () => assert.match(r.stdout, /只能落到「未分组」:\s*1/));
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n4. --apply");
{
  const { home, A } = makeHome();
  const r = run(home, ["--apply", "--force"]);
  const after = read(home);
  check("退出码 0", () => assert.equal(r.code, 0));
  check("归档清空", () => assert.deepEqual(after.global.archivedSessionIds, []));
  check("s2 挂回工作区 A", () => assert.ok(after.tables.workspaces.wa.sessionIds.includes("s2"), "s2 未挂回"));
  check("s2 挂回的是 cwd 对得上的那个工作区", () => assert.equal(after.tables.workspaces.wa.path, A));
  check("s2 只出现一次", () => {
    const n = after.tables.workspaces.wa.sessionIds.filter((x) => x === "s2").length;
    assert.equal(n, 1);
  });
  check("s3 不强行塞进任何工作区", () => {
    const all = Object.values(after.tables.workspaces).flatMap((w) => w.sessionIds);
    assert.ok(!all.includes("s3"), "s3 不该被塞进工作区");
  });
  check("原有槽位没被动", () => {
    assert.deepEqual(after.tables.workspaces.wa.sessionIds.filter((x) => x !== "s2"), ["s1", "keep1"]);
    assert.deepEqual(after.tables.workspaces.wb.sessionIds, ["keep2"]);
  });
  check("留了备份", () => {
    const baks = fs.readdirSync(path.join(home, "storages")).filter((f) => f.startsWith("workspace.json.bak-fixhidden-"));
    assert.equal(baks.length, 1);
  });
  check("输出给了回滚命令", () => assert.match(r.stdout, /--restore/));
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n5. --keep");
{
  const { home } = makeHome();
  run(home, ["--apply", "--force", "--keep", "s1"]);
  const after = read(home);
  check("只保留指定的 s1", () => assert.deepEqual(after.global.archivedSessionIds, ["s1"]));
  check("s1 仍留在原槽位", () => assert.ok(after.tables.workspaces.wa.sessionIds.includes("s1")));
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n6. --restore");
{
  const { home, wsPath } = makeHome();
  const before = fs.readFileSync(wsPath, "utf8");
  run(home, ["--apply", "--force"]);
  const bak = fs
    .readdirSync(path.join(home, "storages"))
    .filter((f) => f.startsWith("workspace.json.bak-fixhidden-"))
    .map((f) => path.join(home, "storages", f))[0];
  const r = run(home, ["--restore", bak, "--force"]);
  check("退出码 0", () => assert.equal(r.code, 0));
  check("回到原始字节", () => assert.equal(fs.readFileSync(wsPath, "utf8"), before));
  check("还原前也留了备份", () => {
    const n = fs.readdirSync(path.join(home, "storages")).filter((f) => f.startsWith("workspace.json.bak-before-restore-")).length;
    assert.equal(n, 1);
  });
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n7. 出错时明确报错");
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fixhidden-empty-"));
  const r = run(home, ["--verify"]);
  check("没有 workspace.json 时退出码 1", () => assert.equal(r.code, 1));
  check("报错里给了解法", () => assert.match(r.stderr, /--home/));
  fs.rmSync(home, { recursive: true, force: true });
}
{
  const { home } = makeHome();
  fs.writeFileSync(path.join(home, "storages", "workspace.json"), "{ 不是 json", "utf8");
  const r = run(home, ["--apply", "--force"]);
  check("坏 JSON 时退出码 1", () => assert.equal(r.code, 1));
  check("报错说不是合法 JSON", () => assert.match(r.stderr, /不是合法 JSON/));
  fs.rmSync(home, { recursive: true, force: true });
}
{
  const { home } = makeHome();
  const r = run(home, ["--restore", path.join(home, "nope.json")]);
  check("备份不存在时退出码 1", () => assert.equal(r.code, 1));
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n8. DSH 在跑时必须拒绝写盘");
{
  const { home, wsPath } = makeHome();
  const before = fs.readFileSync(wsPath, "utf8");
  const r = run(home, ["--apply"]);
  if (process.platform !== "win32") {
    console.log("  skip 非 Windows：进程探测不生效，--force 是唯一保护");
  } else if (r.code === 2) {
    pass += 1;
    console.log("  ok   检测到 DSH 在跑 → 退出码 2，不写盘");
    check("报错说清了原因", () => assert.match(r.stderr, /注册表内存里那份 state/));
    check("文件没被改", () => assert.equal(fs.readFileSync(wsPath, "utf8"), before));
  } else {
    pass += 1;
    console.log("  ok   本机 DSH 未在跑，守卫放行（--force 用例已覆盖写盘）");
  }
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
