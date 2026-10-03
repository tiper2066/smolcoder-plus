// Embedded terminal for the web panel, without a PTY (that would need a native
// dependency). A persistent shell reads commands from a pipe: state such as
// cwd and env carries across commands, output streams back, and a sentinel
// after every command reports its exit code and the shell's cwd. No TTY means
// no colors from most tools and no full-screen programs — but line prompts
// (sudo -S, ssh, read) can be answered from the input box while a command
// runs, with an optional masked echo for passwords.

import { ChildProcess, spawn } from "child_process";
import { killTree, pickShell, ShellInfo } from "../tools/shell";

const RS = "\x1e"; // record separator — never appears in normal output
const SENTINEL = /\x1e(-?\d+)\x1e([^\x1e]*)\x1e\r?\n?/;
const BUFFER_CAP = 200_000;
const HOLD_CAP = 600; // a partial sentinel is held back at most this long
/** Masked echo for hidden input: fixed width, so even the length stays secret. */
const HIDDEN_ECHO = "••••••••";

export interface TerminalHooks {
  output: (text: string) => void;
  /** A command finished: its exit code and the shell's cwd afterwards. */
  done: (code: number, cwd: string) => void;
}

export class Terminal {
  cwd: string;
  /** Recent output for replay when a page (re)connects. */
  buffer = "";
  closed = false;
  readonly shell: ShellInfo;

  private proc: ChildProcess | null = null;
  private acc = "";
  private kind: "posix" | "powershell";
  private interrupting = false;
  private spawnedAt = 0;
  private quickExits = 0;
  /** A wrapped command was sent and its sentinel has not arrived yet. While
   * busy, input goes to the command's stdin (answering sudo -S and the
   * like); while idle it starts a new command. */
  private busy = false;
  constructor(
    readonly id: string,
    cwd: string,
    private hooks: TerminalHooks
  ) {
    this.cwd = cwd;
    this.shell = pickShell();
    this.kind = /powershell|pwsh/i.test(this.shell.exe) ? "powershell" : "posix";
    this.emit(`\x1b[2m${this.shell.label} · no TTY: full-screen programs will not work · input while a command runs goes to it (sudo needs -S, 🔒 masks it) · ctrl+c interrupts\x1b[0m\n`);
    this.spawn();
  }

  private spawn(): void {
    // posix shells get two extra pipes: commands go in on fd 3, completion
    // reports (exit code + cwd) come back on fd 4, and fd 0 stays a plain
    // interactive stdin inherited by every command. That split is what makes
    // prompts answerable: an in-band sentinel on stdout would be eaten as
    // input by the first command that reads stdin (sudo, read, ssh), while
    // fd 4 never is. PowerShell keeps the single-pipe design.
    const loop =
      "while IFS= read -r __smol_cmd <&3; do" +
      " eval \"$__smol_cmd\"; __smol_code=$?;" +
      " printf '\\036%s\\036%s\\036\\n' \"$__smol_code\" \"$PWD\" >&4; done";
    const args = this.kind === "posix" ? ["-l", "-c", loop] : ["-NoProfile", "-NonInteractive", "-Command", "-"];
    this.spawnedAt = Date.now();
    let proc: ChildProcess;
    try {
      proc = spawn(this.shell.exe, args, {
        cwd: this.cwd,
        env: { ...process.env, TERM: "dumb" },
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: this.kind === "posix" ? ["pipe", "pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      });
    } catch (err: any) {
      this.emit(`[could not start ${this.shell.label}: ${err?.message ?? err}]\n`);
      return;
    }
    this.proc = proc;
    proc.stdout?.on("data", (d: Buffer) => this.ingest(d.toString("utf8")));
    proc.stderr?.on("data", (d: Buffer) => this.ingest(d.toString("utf8")));
    if (this.kind === "posix") {
      const results = proc.stdio[4] as unknown as NodeJS.ReadableStream | null;
      results?.on("data", (d: Buffer) => this.ingest(d.toString("utf8")));
    }
    proc.on("error", (err) => this.emit(`[could not start ${this.shell.label}: ${err.message}]\n`));
    proc.on("close", (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.acc) {
        this.emit(this.acc);
        this.acc = "";
      }
      if (this.closed) return;
      if (this.interrupting) {
        this.interrupting = false;
        this.emit("\n\x1b[33m[interrupted]\x1b[0m\n");
        this.spawn();
        return;
      }
      // A shell that dies instantly, twice, is not going to work — stop.
      const quick = Date.now() - this.spawnedAt < 1500;
      this.quickExits = quick ? this.quickExits + 1 : 0;
      if (this.quickExits >= 2) {
        this.emit(`\n\x1b[31m[${this.shell.label} keeps exiting (code ${code}) — close this tab and open a new terminal]\x1b[0m\n`);
        return;
      }
      this.emit(`\n\x1b[2m[shell exited with code ${code} — starting a new one]\x1b[0m\n`);
      this.spawn();
    });
  }

  /** Run one line. Echoed into the stream first, so every connected page (and
   * the replay) shows the command with its output. */
  write(line: string): void {
    if (this.closed) return;
    const cmd = line.replace(/\r?\n$/, "");
    this.emit(`\x1b[36m❯\x1b[0m ${cmd}\n`);
    if (!this.proc) {
      this.emit("\x1b[31m[no shell running]\x1b[0m\n");
      return;
    }
    try {
      if (this.kind === "posix") {
        // Down the command pipe; the shell loop evals it with stdin on the
        // interactive pipe, then reports code+cwd on fd 4.
        (this.proc.stdio[3] as unknown as NodeJS.WritableStream).write(cmd + "\n");
      } else {
        if (!this.proc.stdin?.writable) {
          this.emit("\x1b[31m[no shell running]\x1b[0m\n");
          return;
        }
        this.proc.stdin.write(
          `${cmd}\nWrite-Output ([string][char]0x1e + $(if ($?) {0} else {1}) + [char]0x1e + (Get-Location).Path + [char]0x1e)\n`
        );
      }
      this.busy = true;
    } catch (err: any) {
      this.emit(`[could not write to the shell: ${err?.message ?? err}]\n`);
    }
  }

  /** One line from the input box. While a command runs it is answered to
   * directly (raw stdin, no wrapping); while idle it starts a new command.
   * `hidden` masks the echo with bullets — for passwords. Masking covers the
   * echo only: a command that prints its input back (or an error naming it)
   * can still reveal it, so this is a screen-privacy aid, not a vault. */
  input(line: string, hidden = false): void {
    if (this.closed) return;
    if (!this.busy) {
      this.write(line);
      return;
    }
    // The pipe has no echo of its own, so the server echoes. Masked input
    // shows a fixed-width bullet row in the stream, the replay buffer and
    // every connected page — the real text only ever goes to stdin.
    this.emit(`\x1b[36m❯\x1b[0m ${hidden ? HIDDEN_ECHO : line.replace(/\r?\n$/, "")}\n`);
    if (!this.proc?.stdin?.writable) {
      this.emit("\x1b[31m[no shell running]\x1b[0m\n");
      return;
    }
    try {
      this.proc.stdin.write(line.replace(/\r?\n$/, "") + "\n");
    } catch (err: any) {
      this.emit(`[could not write to the shell: ${err?.message ?? err}]\n`);
    }
  }

  /** ctrl+c: kill the shell (and whatever it is running), start a fresh one
   * in the last known cwd. */
  interrupt(): void {
    if (this.closed) return;
    this.busy = false;
    if (!this.proc) {
      this.spawn();
      return;
    }
    this.interrupting = true;
    if (this.proc.pid) killTree(this.proc.pid);
  }

  close(): void {
    this.closed = true;
    this.busy = false;
    if (this.proc?.pid) killTree(this.proc.pid);
    this.proc = null;
  }

  private ingest(text: string): void {
    this.acc += text;
    for (;;) {
      const m = SENTINEL.exec(this.acc);
      if (!m) break;
      const before = this.acc.slice(0, m.index);
      if (before) this.emit(before);
      this.acc = this.acc.slice(m.index + m[0].length);
      const cwd = toOsPath(m[2].trim()) || this.cwd;
      this.cwd = cwd;
      this.busy = false;
      this.hooks.done(Number(m[1]), cwd);
    }
    // Hold back a partial sentinel that may complete with the next chunk,
    // but never for long — a stray RS in real output must not stall the view.
    const i = this.acc.indexOf(RS);
    if (i < 0) {
      if (this.acc) this.emit(this.acc);
      this.acc = "";
    } else {
      if (i > 0) this.emit(this.acc.slice(0, i));
      this.acc = this.acc.slice(i);
      if (this.acc.length > HOLD_CAP) {
        this.emit(this.acc);
        this.acc = "";
      }
    }
  }

  private emit(text: string): void {
    text = stripControl(text);
    if (!text) return;
    this.buffer += text;
    if (this.buffer.length > BUFFER_CAP) this.buffer = this.buffer.slice(-Math.floor(BUFFER_CAP * 0.8));
    this.hooks.output(text);
  }
}

/** Git Bash reports /c/x for C:\x; spawn() needs the Windows form. */
export function toOsPath(p: string): string {
  if (process.platform === "win32") {
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
    if (m) return `${m[1].toUpperCase()}:${(m[2] ?? "/").replace(/\//g, "\\")}`;
  }
  return p;
}

/** Keep SGR color codes (the page renders them) and \r (progress bars), drop
 * every other escape sequence: cursor moves, screen clears, OSC titles. */
export function stripControl(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-ln-~]/g, "")
    .replace(/\x1b[^[\]]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f]/g, "");
}
