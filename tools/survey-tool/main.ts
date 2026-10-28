#!/usr/bin/env bun
/**
 * survey-tool 的统一入口：一个可执行文件，两种用法。
 *
 * - 不带参数（或只给 --port / --open）→ 起本地 Web 界面
 * - 带任何其它参数           → 走命令行，行为与旧版完全一致
 *
 * 为什么要一个文件而不是编译两个：用户拿到的是「一个程序」，双击它就是界面，
 * 需要脚本化时再带参数。分两个二进制意味着用户要先记住哪个是哪个——而这一整
 * 轮改造的起点，就是「命令行太不方便」。
 */

const argv = process.argv.slice(2);

/** 只属于 Web 模式的开关。出现任何一个，且没有其它参数，就当 Web 启动。 */
function isWebInvocation(args: string[]): boolean {
  if (args.length === 0) return true;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--open") continue;
    if (token === "--port" || token === "-p") {
      index += 1; // 跳过端口值
      continue;
    }
    return false;
  }
  return true;
}

if (isWebInvocation(argv)) {
  await import("./server");
} else {
  await import("./index");
}
