import "@xterm/xterm/css/xterm.css";
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, FolderOpen, LayoutGrid, ListChecks, Plus, Settings2, Square, Users } from "lucide-react";
import type { Activity, Persona, SessionInfo } from "../shared/types";
import { APP_NAME } from "../shared/brand";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { api, useLive, type LiveState } from "./live";
import { TerminalView } from "./terminal";
import { PersonaEditor } from "./personas";
import { TasksPanel } from "./tasks";
import { ACTIVITY, isOpen, needsUser, shortOf, useNames, type Names } from "./names";

// ---------- small pieces ----------

/** Status square: outline idle, filled working, red needs you. */
function Mark({ activity, className }: { activity: Activity | "none"; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 shadow-[inset_0_0_0_1.5px_currentColor]",
        activity === "working" && "animate-beat bg-current",
        activity === "attention" && "bg-destructive text-destructive",
        (activity === "starting" || activity === "exited" || activity === "none") && "opacity-40",
        className,
      )}
    />
  );
}

/** Lakshya: an arrow in the target's eye, the only thing the archer sees. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-7", className)} aria-hidden>
      <circle cx="21" cy="16" r="8.25" fill="none" stroke="currentColor" strokeWidth="2.5" />
      <circle cx="21" cy="16" r="3.25" className="fill-destructive" />
      <path d="M3 16 H17.5" stroke="currentColor" strokeWidth="2.5" />
      <path d="M3.5 12 L6.5 16 L3.5 20 M7.5 12 L10.5 16 L7.5 20" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

// ---------- sidebar: every agent, very slim ----------

function Sidebar({ s, selected, onSelect }: { s: LiveState; selected: string | null; onSelect: (id: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const start = async (p: Persona) => {
    setError(null);
    try {
      onSelect((await api<SessionInfo>("/api/sessions", "POST", { personaId: p.id })).id);
    } catch (e) {
      setError((e as Error).message);
      setTimeout(() => setError(null), 5000);
    }
  };

  return (
    <nav aria-label="Agents" className="flex w-14 shrink-0 flex-col items-center gap-1 border-r bg-sidebar py-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="mb-2 p-1.5">
            <Logo />
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">{APP_NAME}</TooltipContent>
      </Tooltip>

      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto">
        {s.personas.map((p) => {
          const live = s.sessions.filter((x) => x.personaId === p.id && x.activity !== "exited");
          if (live.length === 0) {
            return (
              <Tooltip key={p.id}>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => start(p)}
                    aria-label={`Start ${p.name}`}
                    className="relative grid size-10 shrink-0 place-items-center text-[11px] font-bold text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                  >
                    <span className="absolute inset-y-1.5 left-0 w-[3px] opacity-35" style={{ background: p.color }} />
                    {shortOf(p)}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p className="font-bold">{p.name}</p>
                  <p className="opacity-70">Not running. Click to start.</p>
                </TooltipContent>
              </Tooltip>
            );
          }
          return live.map((x, i) => {
            const sel = selected === x.id;
            return (
              <Tooltip key={x.id}>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => onSelect(x.id)}
                    aria-label={`${x.id}, ${ACTIVITY[x.activity]}`}
                    aria-current={sel}
                    className={cn(
                      "relative grid size-10 shrink-0 place-items-center text-[11px] font-bold hover:bg-accent",
                      sel && "bg-accent ring-1 ring-foreground/60 ring-inset",
                      x.activity === "attention" && "text-destructive",
                    )}
                  >
                    <span className="absolute inset-y-1.5 left-0 w-[3px]" style={{ background: p.color }} />
                    {shortOf(p)}
                    {live.length > 1 && <sup className="-mt-2 text-[9px]">{i + 1}</sup>}
                    <Mark activity={x.activity} className="absolute top-1 right-1" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p className="font-bold">{x.id}</p>
                  <p className="opacity-70">
                    {p.name}, {ACTIVITY[x.activity]}
                    {x.activity === "attention" && x.attentionText ? `: ${x.attentionText}` : ""}
                  </p>
                </TooltipContent>
              </Tooltip>
            );
          });
        })}
      </div>

      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Start another agent">
                <Plus />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="right">Start another agent</TooltipContent>
        </Tooltip>
        <DropdownMenuContent side="right" align="end">
          <DropdownMenuLabel>Start a session</DropdownMenuLabel>
          {s.personas.map((p) => (
            <DropdownMenuItem key={p.id} onSelect={() => start(p)}>
              <span className="size-2.5" style={{ background: p.color }} />
              {p.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {error && (
        <p role="alert" className="fixed bottom-20 left-16 z-50 max-w-72 bg-destructive px-3 py-2 text-sm text-destructive-foreground">
          {error}
        </p>
      )}
    </nav>
  );
}

// ---------- header ----------

function Header(p: {
  s: LiveState;
  names: Names;
  current?: SessionInfo;
  wall: boolean;
  setWall: (v: boolean) => void;
  openTasks: () => void;
  openPersonas: () => void;
}) {
  const { s, current } = p;
  const persona = current && p.names.persona.get(current.personaId);
  const asks = s.tasks.filter(needsUser).length;
  const open = s.tasks.filter(isOpen).length;
  const running = s.sessions.filter((x) => x.activity !== "exited").length;

  const setYolo = (v: boolean) => {
    if (v && !confirm("New agents will run commands and edit files without asking. Agents already running keep their mode. Turn on YOLO?")) return;
    api("/api/settings", "PUT", { yoloAll: v });
  };
  const editFolder = () => {
    const dir = prompt("Folder the agents work in. Applies to sessions started from now on.", s.settings.workspaceDir);
    if (dir && dir !== s.settings.workspaceDir) api("/api/settings", "PUT", { workspaceDir: dir });
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-sidebar px-3 sm:gap-3 sm:px-4">
      <div className="flex min-w-0 flex-1 items-baseline gap-3">
        <h1 className="hidden font-bold sm:block">{APP_NAME}</h1>
        {p.wall ? (
          <span className="truncate font-bold">All sessions</span>
        ) : current && persona ? (
          <>
            <span className="truncate font-bold">{current.id}</span>
            <span className="hidden truncate text-sm text-muted-foreground md:inline">
              {persona.name}, {current.runtime}, started by {p.names.who(current.spawnedBy)}
            </span>
            <span className={cn("flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground", current.activity === "attention" && "text-destructive")}>
              <Mark activity={current.activity} /> {ACTIVITY[current.activity]}
            </span>
          </>
        ) : (
          <span className="truncate text-muted-foreground">No session selected</span>
        )}
      </div>

      {!s.connected && <span className="text-sm text-destructive">Reconnecting</span>}
      {s.settings.yoloAll && <span className="hidden text-xs font-bold text-destructive sm:inline">YOLO</span>}

      {!p.wall && current && current.activity !== "exited" && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`Stop ${current.id}`} onClick={() => api(`/api/sessions/${current.id}`, "DELETE")}>
              <Square />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Stop {current.id}</TooltipContent>
        </Tooltip>
      )}
      {running > 1 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant={p.wall ? "secondary" : "ghost"} size="icon" className="hidden sm:inline-flex" aria-label="Show all sessions" aria-pressed={p.wall} onClick={() => p.setWall(!p.wall)}>
              <LayoutGrid />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{p.wall ? "Show one session" : `Show all ${running} sessions`}</TooltipContent>
        </Tooltip>
      )}
      <Button variant="outline" className="font-bold" onClick={p.openTasks}>
        <ListChecks />
        <span className="hidden sm:inline">Tasks</span>
        {asks > 0 ? <span className="bg-destructive px-1.5 text-xs text-destructive-foreground">{asks}</span> : <span className="text-xs font-normal text-muted-foreground">{open}</span>}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Settings">
            <Settings2 />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel>Settings</DropdownMenuLabel>
          <DropdownMenuItem onSelect={editFolder}>
            <FolderOpen />
            <span className="truncate">Folder: {s.settings.workspaceDir.split("/").filter(Boolean).at(-1)}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={p.openPersonas}>
            <Users /> Edit personas
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked={s.settings.autopilot} onCheckedChange={(v) => api("/api/settings", "PUT", { autopilot: v === true })}>
            <span>
              Autopilot loop
              <span className="block text-xs text-muted-foreground">Re-prompt agents that stall on open tasks</span>
            </span>
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={s.settings.yoloAll} onCheckedChange={(v) => setYolo(v === true)}>
            <span>
              YOLO for new agents
              <span className="block text-xs text-muted-foreground">Skip every approval prompt</span>
            </span>
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}

// ---------- session area ----------

const KEYS: [string, string, string][] = [
  ["Enter", "\r", "Enter"],
  ["Esc", "\x1b", "Escape"],
  ["↑", "\x1b[A", "Up arrow"],
  ["↓", "\x1b[B", "Down arrow"],
  ["Tab", "\t", "Tab"],
  ["^C", "\x03", "Control C"],
];

/** Terminal keyboard for touch screens: type a line into the agent, or press keys a TUI needs (menus, approvals, interrupts). */
function KeyRow({ session }: { session: SessionInfo }) {
  const [line, setLine] = useState("");
  const send = (data: string) => api(`/api/sessions/${session.id}/input`, "POST", { data });
  return (
    <form
      className="hidden shrink-0 flex-wrap items-center gap-1 border-t bg-sidebar px-2 py-1.5 sm:flex-nowrap [@media(pointer:coarse)]:flex"
      onSubmit={async (e) => {
        e.preventDefault();
        if (line) await send(line);
        // Enter as its own write so TUIs don't treat it as part of a paste.
        setTimeout(() => send("\r"), line ? 120 : 0);
        setLine("");
      }}
    >
      <label htmlFor="keyline" className="sr-only">
        Type into {session.id}
      </label>
      <Input
        id="keyline"
        value={line}
        onChange={(e) => setLine(e.target.value)}
        placeholder={`Type into ${session.id}`}
        autoComplete="off"
        className="h-8 basis-full font-mono text-sm sm:min-w-40 sm:flex-1 sm:basis-auto"
      />
      <div className="flex w-full gap-1 sm:w-auto sm:shrink-0" role="group" aria-label="Keys">
        {KEYS.map(([label, data, aria]) => (
          <Button key={label} type="button" variant="outline" size="sm" className="min-w-10 flex-1 px-2 font-bold sm:flex-none" aria-label={aria} onClick={() => send(data)}>
            {label}
          </Button>
        ))}
      </div>
    </form>
  );
}

function SessionArea({ s, current, wall, onPick }: { s: LiveState; current?: SessionInfo; wall: boolean; onPick: (id: string) => void }) {
  const running = s.sessions.filter((x) => x.activity !== "exited");
  const send = (data: string) => current && api(`/api/sessions/${current.id}/input`, "POST", { data });

  if (wall) {
    return (
      <div className="grid min-h-0 flex-1 auto-rows-[minmax(280px,1fr)] grid-cols-[repeat(auto-fit,minmax(min(100%,560px),1fr))] gap-px overflow-y-auto bg-border">
        {running.map((x) => (
          <button key={x.id} className="grid min-h-0 grid-rows-[auto_1fr] overflow-hidden bg-terminal text-left" onClick={() => onPick(x.id)}>
            <span className="flex items-center gap-2 bg-sidebar px-3 py-1.5 text-sm font-bold">
              <Mark activity={x.activity} /> {x.id} <span className="font-normal text-muted-foreground">{ACTIVITY[x.activity]}</span>
            </span>
            <TerminalView sessionId={x.id} mode="tile" />
          </button>
        ))}
      </div>
    );
  }

  if (!current) {
    const entry = s.personas.find((p) => p.entry);
    return (
      <div className="flex min-h-0 flex-1 items-end bg-terminal p-6 sm:p-10">
        <div className="max-w-xl space-y-3">
          <p className="text-3xl font-bold tracking-tight sm:text-4xl">What should the team build?</p>
          <p className="text-muted-foreground">
            Type a request below. The {entry?.name ?? "entry persona"} picks it up in its own terminal and brings in the rest of the team as needed. Every agent
            appears in the sidebar; click one to watch it or type into it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-terminal">
      {current.activity === "attention" && (
        <div role="alert" className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-destructive/40 bg-destructive/15 px-4 py-2">
          <p className="min-w-0 text-sm">
            <strong className="text-destructive">{current.id} is asking.</strong> {current.attentionText}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" className="font-bold" onClick={() => send("\r")}>
              Accept highlighted option
            </Button>
            <Button size="sm" variant="outline" onClick={() => send("\x1b")}>
              Decline
            </Button>
          </div>
        </div>
      )}
      <TerminalView key={current.id} sessionId={current.id} mode="focus" />
      {current.activity === "exited" ? (
        <div className="flex shrink-0 items-center gap-3 border-t px-4 py-2 text-sm text-muted-foreground">
          This session has stopped.
          <Button size="sm" variant="secondary" onClick={() => api<SessionInfo>("/api/sessions", "POST", { personaId: current.personaId }).then((x) => onPick(x.id))}>
            Start a new one
          </Button>
        </div>
      ) : (
        <KeyRow session={current} />
      )}
    </div>
  );
}

// ---------- request bar ----------

function RequestBar({ s }: { s: LiveState }) {
  const entry = s.personas.find((p) => p.entry) ?? s.personas[0];
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const target = s.personas.find((p) => p.id === to) ?? entry;
  const submit = async () => {
    if (!text.trim() || !target) return;
    setBusy(true);
    setNote(null);
    try {
      await api("/api/request", "POST", { text, to: target.id });
      setText("");
      setNote({ ok: true, text: `Sent to ${target.name}` });
      setTimeout(() => setNote(null), 4000);
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const mod = navigator.platform.includes("Mac") ? "⌘" : "Ctrl";
  return (
    <form
      className="flex shrink-0 items-end gap-2 border-t bg-sidebar p-2 sm:px-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label htmlFor="request" className="sr-only">
        Request for the team
      </label>
      <div className="relative min-w-0 flex-1">
        <Textarea
          id="request"
          rows={1}
          placeholder="Ask the team to build something"
          title={`${mod}+Enter sends`}
          className="field-sizing-content max-h-40 min-h-9 resize-none text-base"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
        />
        {note && (
          <p role="status" className={cn("absolute -top-7 left-0 px-2 py-0.5 text-xs font-bold", note.ok ? "bg-foreground text-background" : "bg-destructive text-destructive-foreground")}>
            {note.text}
          </p>
        )}
      </div>
      <Select value={target?.id ?? ""} onValueChange={setTo}>
        <SelectTrigger className="w-14 shrink-0 sm:w-44" aria-label="Send to">
          <span className="sm:hidden">{target ? shortOf(target) : ""}</span>
          <span className="hidden truncate sm:inline">
            <SelectValue />
          </span>
        </SelectTrigger>
        <SelectContent align="end">
          {s.personas.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button type="submit" disabled={busy || !text.trim()} className="shrink-0 font-bold">
        <ArrowUp />
        <span className="hidden sm:inline">Send</span>
      </Button>
    </form>
  );
}

// ---------- app ----------

const EMPTY: LiveState = {
  personas: [],
  sessions: [],
  tasks: [],
  messages: [],
  settings: { workspaceDir: "", yoloAll: false, autopilot: true, nudgeAfterSec: 90 },
  runtimes: [],
  connected: false,
};

function App() {
  const live = useLive();
  const s = live ?? EMPTY;
  const names = useNames(s);
  const [selected, setSelectedRaw] = useState<string | null>(null);
  const [wall, setWall] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [personasOpen, setPersonasOpen] = useState(false);
  const [openTask, setOpenTask] = useState<string | null>(null);
  const follow = useRef(true);

  // Follow the newest session until the user picks one.
  const newest = s.sessions.filter((x) => x.activity !== "exited").at(-1)?.id;
  useEffect(() => {
    if (newest && (follow.current || !selected)) setSelectedRaw(newest);
  }, [newest]);

  if (!live) return <p className="p-6 text-lg text-muted-foreground">Connecting to {APP_NAME}</p>;

  const pick = (id: string) => {
    follow.current = false;
    setSelectedRaw(id);
    setWall(false);
  };
  const current = selected ? names.session.get(selected) : undefined;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-dvh overflow-hidden">
        <Sidebar s={s} selected={selected} onSelect={pick} />
        <main className="flex min-w-0 flex-1 flex-col">
          <Header s={s} names={names} current={current} wall={wall} setWall={setWall} openTasks={() => setTasksOpen(true)} openPersonas={() => setPersonasOpen(true)} />
          <SessionArea s={s} current={current} wall={wall} onPick={pick} />
          <RequestBar s={s} />
        </main>
      </div>

      <Sheet open={tasksOpen} onOpenChange={setTasksOpen}>
        <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-md">
          <SheetHeader className="px-6 pt-5">
            <SheetTitle className="text-xl font-bold">Tasks</SheetTitle>
            <SheetDescription>Every A2A task between you and the agents, newest first.</SheetDescription>
          </SheetHeader>
          <TasksPanel s={s} names={names} openTask={openTask} setOpenTask={setOpenTask} />
        </SheetContent>
      </Sheet>

      <Sheet open={personasOpen} onOpenChange={setPersonasOpen}>
        <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl">
          <SheetHeader className="px-6 pt-5 pb-3">
            <SheetTitle className="text-xl font-bold">Personas</SheetTitle>
            <SheetDescription>Roles, rules and runtimes. Changes apply to sessions started after you save.</SheetDescription>
          </SheetHeader>
          <PersonaEditor s={s} />
        </SheetContent>
      </Sheet>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
