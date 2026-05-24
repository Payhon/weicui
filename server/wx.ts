import { execa } from 'execa';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WxPreflight } from './types.js';

const wxConfigPath = path.join(os.homedir(), '.wx-cli', 'config.json');

export async function wxJson(args: string[], timeout = 60_000): Promise<unknown[]> {
  const finalArgs = args.includes('--json') ? args : [...args, '--json'];
  const { stdout } = await execa('wx', finalArgs, { timeout });
  return asArray(JSON.parse(stdout || '[]'));
}

export async function runWx(args: string[], timeout = 20_000) {
  return execa('wx', args, { timeout, reject: false });
}

export async function checkPreflight(): Promise<WxPreflight> {
  const instructions = [
    '确认桌面微信已启动并完成登录。',
    '如首次使用或微信更新过，请按本机部署说明完成消息服务授权。',
    '重启微信：killall WeChat && open /Applications/WeChat.app',
    '等待微信登录完成后，重新初始化消息服务；密钥失效时执行强制初始化。',
    '初始化成功后刷新本页面，或点击“重扫”。'
  ];

  const which = await execa('which', ['wx'], { reject: false });
  const wxFound = which.exitCode === 0;
  const configFound = fs.existsSync(wxConfigPath);

  let daemonOk = false;
  let daemonMessage = '';
  if (wxFound) {
    const daemon = await runWx(['daemon', 'status'], 20_000);
    const rawDaemonMessage = (daemon.stdout || daemon.stderr || '').trim();
    daemonOk = daemon.exitCode === 0 && !/未运行|失败|错误|timeout|超时/i.test(rawDaemonMessage);
    daemonMessage = daemonOk ? '后台服务运行中' : '后台服务未运行';
  }

  let sessionsOk = false;
  let sessionsMessage = '';
  if (wxFound && configFound) {
    const sessions = await runWx(['sessions', '-n', '1', '--json'], 45_000);
    sessionsOk = sessions.exitCode === 0 && looksLikeJson(sessions.stdout);
    sessionsMessage = sessionsOk ? '消息读取正常' : '消息读取不可用';
  } else if (!configFound) {
    sessionsMessage = '消息服务配置缺失';
  }

  return {
    ok: wxFound && configFound && sessionsOk,
    wxFound,
    configFound,
    daemonOk,
    sessionsOk,
    daemonMessage,
    sessionsMessage,
    instructions
  };
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['data', 'items', 'sessions', 'messages', 'records', 'contacts', 'members']) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return [];
}

function looksLikeJson(value: string) {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
