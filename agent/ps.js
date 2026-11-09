import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_OUT = 2 * 1024 * 1024;

/** Littéral PowerShell entre quotes simples, sûr contre l'injection. */
export const psq = (s) => `'${String(s ?? '').replace(/'/g, "''")}'`;

export function killTree(pid) {
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch {}
}

/** Lance un processus, capture stdout/stderr (UTF-8), timeout avec arrêt de l'arbre. */
export function runProcess(file, args, { timeoutMs = 60000, cwd, verbatim = false } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(file, args, { cwd, windowsHide: true, windowsVerbatimArguments: verbatim, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: e.message, timedOut: false });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < MAX_OUT) out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { if (err.length < MAX_OUT) err += d.toString('utf8'); });
    child.on('error', (e) => { err += e.message; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err, timedOut });
    });
  });
}

const PRELUDE = (strict) =>
  `${strict ? "$ErrorActionPreference='Stop';" : ''}[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;$ProgressPreference='SilentlyContinue';`;

/** Exécute un script PowerShell (fichier temporaire si long). */
export async function runPS(script, { timeoutMs = 60000, cwd, strict = true } = {}) {
  const full = PRELUDE(strict) + script;
  const base = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
  let r;
  if (full.length < 5000) {
    r = await runProcess('powershell.exe', [...base, '-EncodedCommand', Buffer.from(full, 'utf16le').toString('base64')], { timeoutMs, cwd });
  } else {
    const file = path.join(os.tmpdir(), `jarvis-${crypto.randomBytes(6).toString('hex')}.ps1`);
    fs.writeFileSync(file, `﻿${full}`, 'utf8');
    try {
      r = await runProcess('powershell.exe', [...base, '-File', file], { timeoutMs, cwd });
    } finally {
      fs.rm(file, { force: true }, () => {});
    }
  }
  r.stderr = cleanClixml(r.stderr);
  return r;
}

/** Quand stderr est redirigé, PowerShell émet ses erreurs en XML (« #< CLIXML ») : on les remet en texte lisible. */
export function cleanClixml(s) {
  if (!s.includes('#< CLIXML')) return s;
  const msgs = [...s.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) =>
    m[1]
      .replace(/_x000D__x000A_/g, '\n').replace(/_x000A_/g, '\n').replace(/_x000D_/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'),
  );
  const lines = msgs.join('').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() && !/^(Au caractère|At line:|\s*\+ |\s*\+\s+CategoryInfo|\s*\+\s+FullyQualifiedErrorId)/.test(l));
  return lines.join('\n') || s;
}

export function spawnDetached(file, args, { cwd, shell = false } = {}) {
  const child = spawn(file, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false, shell });
  child.on('error', () => {});
  child.unref();
  return child.pid;
}

// Bibliothèque Win32 (SendInput unicode, souris, DPI, fenêtres). C# 5 compatible (Windows PowerShell 5.1).
export const WIN32_CS = `
using System;
using System.Runtime.InteropServices;
public static class JIn {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] i, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  static bool Ext(ushort vk) { return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x6F; }
  static INPUT K(ushort vk, ushort scan, uint flags) { INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
  public static void Key(ushort vk, bool up) { uint f = (up ? 2u : 0u) | (Ext(vk) ? 1u : 0u); SendInput(1, new INPUT[]{ K(vk, 0, f) }, Marshal.SizeOf(typeof(INPUT))); }
  public static void TypeText(string s) {
    foreach (char c in s) {
      if (c == '\\r') continue;
      if (c == '\\n') { Key(0x0D, false); Key(0x0D, true); continue; }
      if (c == '\\t') { Key(0x09, false); Key(0x09, true); continue; }
      INPUT[] a = new INPUT[]{ K(0, c, 4u), K(0, c, 6u) };
      SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
      System.Threading.Thread.Sleep(4);
    }
  }
}
`;

export const withWin32 = (body) => `Add-Type -TypeDefinition @'\n${WIN32_CS}\n'@ -Language CSharp\n[JIn]::SetProcessDPIAware() | Out-Null\n${body}`;
