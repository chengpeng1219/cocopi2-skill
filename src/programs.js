import { randomUUID } from 'node:crypto';

const MAX_PROGRAM_NAME = 64;
const MAX_PROGRAM_COMMAND = 4_000;
const MAX_WORKING_DIR = 512;
const MAX_LOG_CHARS = 32 * 1024;
const DEFAULT_PROGRAM_LOG_LINES = 80;
const MAX_PROGRAM_LOG_LINES = 500;

export function validProgramName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('name is required');
  const value = name.trim();
  if (value.length > MAX_PROGRAM_NAME) throw new TypeError(`name must not exceed ${MAX_PROGRAM_NAME} characters`);
  if (value.includes('\0')) throw new TypeError('name must not contain null bytes');
  return value;
}

export function validProgramCommand(command) {
  if (typeof command !== 'string' || !command.trim()) throw new TypeError('command is required');
  if (command.length > MAX_PROGRAM_COMMAND) throw new TypeError(`command must not exceed ${MAX_PROGRAM_COMMAND} characters`);
  if (command.includes('\0')) throw new TypeError('command must not contain null bytes');
  return command.trim();
}

export function validWorkingDirectory(directory) {
  if (directory === undefined || directory === null || directory === '') return '';
  if (typeof directory !== 'string') throw new TypeError('workdir must be a string');
  const value = directory.trim();
  if (value.length > MAX_WORKING_DIR) throw new TypeError(`workdir must not exceed ${MAX_WORKING_DIR} characters`);
  if (value.includes('\0') || value.includes('%')) throw new TypeError('workdir must not contain null bytes or "%" (it is percent-encoded)');
  return value;
}

export function validProgramLogLines(lines) {
  if (lines === undefined) return DEFAULT_PROGRAM_LOG_LINES;
  if (!Number.isInteger(lines) || lines < 1 || lines > MAX_PROGRAM_LOG_LINES) {
    throw new TypeError(`lines must be an integer between 1 and ${MAX_PROGRAM_LOG_LINES}`);
  }
  return lines;
}

// 设备端启动/列表/停止都通过固定的 `/tmp` 目录与 PID 文件约定工作，路径不来自用户输入。
export function programIdentifier() {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

export function validProgramId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new TypeError('programId is invalid');
  return id;
}

// 设备端脚本目录：Wi-Fi 走 SSH 时目录归属正常；USB/ADB 时需放开权限供 root/shell 共用。
export const PROGRAMS_DIR = '/tmp/cocopi2-programs';

export function programsPreamble() {
  return `[ -d ${PROGRAMS_DIR} ] || mkdir -p ${PROGRAMS_DIR}; chmod 777 ${PROGRAMS_DIR} 2>/dev/null;`;
}

export function programListScript() {
  // 写成片段数组、最后用 '; ' 连接：`do;`/`continue;;` 这类双分号会让 shell 报语法错误。
  const list = [
    'for f in /tmp/cocopi2-programs/*.pid',
    'do [ -f "$f" ] || continue',
    'pid=$(cat "$f" 2>/dev/null)',
    'id=$(basename "$f" .pid)',
    'if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null',
    'then if [ -r "/proc/$pid/cmdline" ]; then cmd=$(tr \'\\0\' \' \' < "/proc/$pid/cmdline" | cut -c1-120); else cmd=""; fi',
    'echo "$id|running|$pid|$cmd"',
    'else echo "$id|stopped|$pid|"',
    'fi',
    'done',
  ].join('; ');
  return `${programsPreamble()} ${list}`;
}

export function programStartScript({ id, command, workdir }) {
  const log = `/tmp/cocopi2-programs/${id}.log`;
  const pid = `/tmp/cocopi2-programs/${id}.pid`;
  const inner = workdir ? `cd ${shellQuote(workdir)} || exit 97; ${command}` : command;
  // 把用户命令单独写成一个设备端脚本文件再执行：避免多层引号在 adb shell 里被反复解析而变形。
  const runFile = `${PROGRAMS_DIR}/${id}.run.sh`;
  // 用 shellQuote 包裹整段内部脚本；含单引号时按 POSIX 方式断开闭合。
  const quotedInner = shellQuote(inner);
  // nohup 与重定向必须用花括号成组：`a > log 2>&1 & echo $! > pid` 会被解析成 `b&echo` 重定向合并。
  return [
    programsPreamble(),
    `printf '%s' ${shellQuote(`${inner}\n`)} > ${runFile};`,
    `{ nohup sh ${runFile} < /dev/null > ${log} 2>&1 & } 2>/dev/null;`,
    `echo $! > ${pid};`,
    'sleep 1;',
    `if kill -0 "$(cat ${pid})" 2>/dev/null; then echo STARTED; else echo EXITED; fi`,
  ].join(' ');
}

export function programStopScript(id) {
  const pid = `/tmp/cocopi2-programs/${id}.pid`;
  return [
    `pid=$(cat ${pid} 2>/dev/null);`,
    `if [ -n "$pid" ] && [ "$pid" != "1" ] && kill -0 "$pid" 2>/dev/null; then`,
    `kill "$pid" 2>/dev/null; sleep 1;`,
    `if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null; sleep 1; fi;`,
    `if kill -0 "$pid" 2>/dev/null; then echo STOP_FAILED; else echo STOPPED; fi;`,
    `else echo NOT_RUNNING; fi`,
  ].join(' ');
}

export function programLogScript(id, lines) {
  return `tail -n ${lines} /tmp/cocopi2-programs/${id}.log 2>/dev/null`;
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function truncateLog(text) {
  const value = String(text ?? '');
  if (value.length <= MAX_LOG_CHARS) return { log: value, truncated: false };
  return { log: value.slice(value.length - MAX_LOG_CHARS), truncated: true };
}