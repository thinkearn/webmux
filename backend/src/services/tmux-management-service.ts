import type { PaneSplit } from "../domain/config";
import type { TmuxGateway } from "../adapters/tmux";
import { sanitizeTmuxNameSegment } from "../adapters/tmux";

export interface TmuxLayoutWindow {
  name: string;
  paneCount: number;
  active: boolean;
}

export interface TmuxLayoutSnapshot {
  sessionName: string;
  currentWindow: string;
  windows: TmuxLayoutWindow[];
  panes: number[];
  activePane: number;
}

export interface TmuxManagementContext {
  sessionName: string;
  windowName: string;
  cwd: string;
}

export function readTmuxLayout(
  tmux: TmuxGateway,
  context: TmuxManagementContext,
): TmuxLayoutSnapshot {
  const windows = tmux
    .listWindows()
    .filter((window) => window.sessionName === context.sessionName)
    .map((window) => ({
      name: window.windowName,
      paneCount: window.paneCount,
      active: window.windowName === context.windowName,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const panes = tmux.listPanes(context.sessionName, context.windowName);
  const activePaneRaw = tmux.displayMessage(
    `${context.sessionName}:${context.windowName}`,
    "#{pane_index}",
  );
  const parsedActivePane = parseInt(activePaneRaw, 10);
  const activePane = panes.includes(parsedActivePane) ? parsedActivePane : panes[0] ?? 0;

  return {
    sessionName: context.sessionName,
    currentWindow: context.windowName,
    windows,
    panes,
    activePane,
  };
}

export function splitTmuxPane(
  tmux: TmuxGateway,
  context: TmuxManagementContext,
  split: PaneSplit,
  paneIndex?: number,
): void {
  const panes = tmux.listPanes(context.sessionName, context.windowName);
  const targetPane = paneIndex ?? panes[panes.length - 1] ?? 0;
  tmux.splitWindow({
    target: `${context.sessionName}:${context.windowName}.${targetPane}`,
    split,
    cwd: context.cwd,
  });
}

export function buildAdHocWindowName(existingNames: string[]): string {
  for (let index = 1; index <= 999; index += 1) {
    const candidate = sanitizeTmuxNameSegment(`wm-shell-${index}`, 32);
    if (!existingNames.includes(candidate)) return candidate;
  }
  return sanitizeTmuxNameSegment(`wm-shell-${Date.now()}`, 32);
}

export function createTmuxShellWindow(
  tmux: TmuxGateway,
  context: TmuxManagementContext,
  windowName?: string,
): string {
  tmux.ensureServer();
  tmux.ensureSession(context.sessionName, context.cwd);
  const existingNames = tmux
    .listWindows()
    .filter((window) => window.sessionName === context.sessionName)
    .map((window) => window.windowName);
  const nextWindowName = windowName?.trim()
    ? sanitizeTmuxNameSegment(windowName.trim(), 32)
    : buildAdHocWindowName(existingNames);
  tmux.createWindow({
    sessionName: context.sessionName,
    windowName: nextWindowName,
    cwd: context.cwd,
  });
  tmux.setWindowOption(context.sessionName, nextWindowName, "automatic-rename", "off");
  tmux.setWindowOption(context.sessionName, nextWindowName, "allow-rename", "off");
  return nextWindowName;
}

export function selectTmuxWindow(
  tmux: TmuxGateway,
  context: TmuxManagementContext,
  windowName: string,
): TmuxManagementContext {
  tmux.selectWindow(context.sessionName, windowName);
  return {
    ...context,
    windowName,
  };
}

export function selectTmuxPane(
  tmux: TmuxGateway,
  context: TmuxManagementContext,
  paneIndex: number,
): void {
  tmux.selectPane(`${context.sessionName}:${context.windowName}.${paneIndex}`);
}
