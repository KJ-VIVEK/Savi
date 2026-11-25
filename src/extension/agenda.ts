import * as vscode from "vscode";
import type { CalendarEvent, Kind, Priority, Task } from "../core/calendar.ts";
import { addDays, isDateOnly, parseLocal, toDate } from "../core/time.ts";
import type { Client } from "./client.ts";

export type Node =
  | { kind: "group"; label: string; children: Node[] }
  | { kind: "event"; event: CalendarEvent; day: string }
  | { kind: "task"; task: Task };

const ICONS: Record<Kind, string> = { event: "calendar", reminder: "bell", birthday: "gift" };
const COLORS: Record<Priority, string> = { high: "charts.red", medium: "charts.yellow", low: "charts.green" };
const icon = (id: string, p?: Priority) => new vscode.ThemeIcon(id, p && new vscode.ThemeColor(COLORS[p]));
const priorityText = (p?: Priority) => p && `Priority: ${p}`;

const time = (s: string) => parseLocal(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export class Agenda implements vscode.TreeDataProvider<Node> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private client: Client;

  constructor(client: Client) { this.client = client; }

  refresh() { this.changed.fire(); }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === "group") return new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Expanded);
    const item = new vscode.TreeItem(n.kind === "event" ? n.event.title : n.task.title);
    item.contextValue = n.kind;
    if (n.kind === "event") {
      const { event: e } = n;
      item.iconPath = icon(ICONS[e.kind], e.priority);
      item.description = isDateOnly(e.start) ? "All day"
        : e.start.slice(0, 10) === n.day ? `${time(e.start)} – ${time(e.end)}` : `Until ${time(e.end)}`;
      item.tooltip = [e.title, priorityText(e.priority), e.location, e.description].filter(Boolean).join("\n");
    } else {
      item.iconPath = icon("circle-large-outline", n.task.priority);
      item.description = n.task.due && (n.task.due < toDate(new Date()) ? `Overdue, ${n.task.due}` : n.task.due);
      item.tooltip = [n.task.title, priorityText(n.task.priority), n.task.notes].filter(Boolean).join("\n");
    }
    return item;
  }

  async getChildren(n?: Node): Promise<Node[]> {
    if (n) return n.kind === "group" ? n.children : [];
    const days = vscode.workspace.getConfiguration("savi").get<number>("agendaDays", 7);
    const today = toDate(new Date());
    try {
      const { connected, events, tasks } = await this.client.call("agenda", { days });
      await vscode.commands.executeCommand("setContext", "savi.signedIn", connected);
      const groups: Node[] = [];
      const byDay = new Map<string, Node[]>();
      for (const event of events) {
        // Ongoing events that began earlier appear under today.
        const start = event.start.slice(0, 10);
        const day = start < today ? today : start;
        byDay.set(day, [...(byDay.get(day) ?? []), { kind: "event", event, day }]);
      }
      for (const [day, children] of [...byDay].sort(([a], [b]) => a.localeCompare(b)))
        groups.push({ kind: "group", label: this.label(day, today), children });
      if (tasks.length) groups.push({ kind: "group", label: "Tasks", children: tasks.map((task) => ({ kind: "task", task })) });
      return groups;
    } catch (e) {
      void vscode.window.showErrorMessage(`Savi: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  private label(day: string, today: string) {
    if (day === today) return "Today";
    if (day === addDays(today, 1)) return "Tomorrow";
    return parseLocal(day).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  }
}
