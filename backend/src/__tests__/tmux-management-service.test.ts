import { describe, expect, test } from "bun:test";
import type { TmuxGateway } from "../adapters/tmux";
import {
  buildAdHocWindowName,
  createTmuxShellWindow,
  readTmuxLayout,
  splitTmuxPane,
} from "../services/tmux-management-service";

class FakeTmuxGateway implements TmuxGateway {
  windows = [{ sessionName: "wm-project", windowName: "wm-feature", paneCount: 2 }];
  panes = new Map<string, number[]>([["wm-project:wm-feature", [0, 1]]]);
  calls: string[] = [];

  ensureServer(): void {
    this.calls.push("ensureServer");
  }

  ensureSession(sessionName: string, cwd: string): void {
    this.calls.push(`ensureSession:${sessionName}:${cwd}`);
  }

  hasWindow(sessionName: string, windowName: string): boolean {
    return this.windows.some((window) => window.sessionName === sessionName && window.windowName === windowName);
  }

  killWindow(): void {}

  createWindow(opts: { sessionName: string; windowName: string; cwd: string; command?: string }): void {
    this.calls.push(`createWindow:${opts.windowName}`);
    this.windows.push({ sessionName: opts.sessionName, windowName: opts.windowName, paneCount: 1 });
    this.panes.set(`${opts.sessionName}:${opts.windowName}`, [0]);
  }

  splitWindow(opts: { target: string; split: "right" | "bottom"; cwd: string }): void {
    this.calls.push(`splitWindow:${opts.target}:${opts.split}`);
    const [sessionName, windowName] = opts.target.split(":");
    const key = `${sessionName}:${windowName}`;
    const next = [...(this.panes.get(key) ?? [0]), (this.panes.get(key)?.length ?? 1)];
    this.panes.set(key, next);
    const window = this.windows.find((entry) => entry.sessionName === sessionName && entry.windowName === windowName);
    if (window) window.paneCount = next.length;
  }

  setWindowOption(): void {}

  runCommand(): void {}

  selectPane(target: string): void {
    this.calls.push(`selectPane:${target}`);
  }

  selectWindow(sessionName: string, windowName: string): void {
    this.calls.push(`selectWindow:${sessionName}:${windowName}`);
  }

  listPanes(sessionName: string, windowName: string): number[] {
    return [...(this.panes.get(`${sessionName}:${windowName}`) ?? [0])];
  }

  displayMessage(_target: string, format: string): string {
    if (format.includes("pane_index")) return "1";
    return "";
  }

  listWindows() {
    return this.windows;
  }
}

describe("tmux-management-service", () => {
  test("buildAdHocWindowName skips existing shell windows", () => {
    expect(buildAdHocWindowName(["wm-shell-1"])).toBe("wm-shell-2");
  });

  test("readTmuxLayout returns windows and panes for the current context", () => {
    const tmux = new FakeTmuxGateway();
    const layout = readTmuxLayout(tmux, {
      sessionName: "wm-project",
      windowName: "wm-feature",
      cwd: "/repo",
    });
    expect(layout.windows).toHaveLength(1);
    expect(layout.panes).toEqual([0, 1]);
    expect(layout.activePane).toBe(1);
  });

  test("splitTmuxPane targets the active window pane", () => {
    const tmux = new FakeTmuxGateway();
    splitTmuxPane(tmux, {
      sessionName: "wm-project",
      windowName: "wm-feature",
      cwd: "/repo/feature",
    }, "right");
    expect(tmux.calls).toContain("splitWindow:wm-project:wm-feature.1:right");
  });

  test("createTmuxShellWindow adds a new window in the project session", () => {
    const tmux = new FakeTmuxGateway();
    const created = createTmuxShellWindow(tmux, {
      sessionName: "wm-project",
      windowName: "wm-feature",
      cwd: "/repo",
    });
    expect(created).toBe("wm-shell-1");
    expect(tmux.windows.some((window) => window.windowName === "wm-shell-1")).toBe(true);
  });
});
