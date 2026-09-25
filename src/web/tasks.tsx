import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { A2ATask } from "../shared/types";
import { textOf } from "../shared/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { api, timeAgo, type LiveState } from "./live";
import { isOpen, needsUser, STATE, type Names } from "./names";

function StateLabel({ state }: { state: string }) {
  const red = state === "input-required" || state === "failed" || state === "rejected";
  const quiet = state === "submitted" || state === "canceled";
  return (
    <span className={cn("text-xs font-bold", red && "text-destructive", quiet && "text-muted-foreground")}>
      {state === "completed" && "✓ "}
      {STATE[state]}
    </span>
  );
}

function TaskDetail({ id, s, names, onBack }: { id: string; s: LiveState; names: Names; onBack: () => void }) {
  const [task, setTask] = useState<A2ATask | null>(null);
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string | null>(null);
  const live = s.tasks.find((t) => t.id === id);
  const msgCount = s.messages.filter((m) => m.taskId === id).length;
  useEffect(() => {
    api<A2ATask>(`/api/tasks/${id}`).then(setTask, (e) => setError(e.message));
  }, [id, live?.metadata.updatedAt, msgCount]);
  if (!task) return <p className="p-6 text-muted-foreground">{error ?? "Loading task"}</p>;

  const t = { ...task, ...(live ?? {}), history: task.history };
  const toUser = t.metadata.to === "user";
  const send = async () => {
    setError(null);
    try {
      await api(`/api/tasks/${id}/reply`, "POST", { text: reply, state: toUser ? "completed" : undefined });
      setReply("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <article className="flex flex-col gap-4 px-6 pb-10">
      <Button variant="link" className="self-start px-0 font-bold" onClick={onBack}>
        <ArrowLeft /> All tasks
      </Button>
      <div className="space-y-1">
        <StateLabel state={t.status.state} />
        <h3 className="text-xl font-bold leading-tight tracking-tight">{t.metadata.title}</h3>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">From</dt>
        <dd>{names.who(t.metadata.from)}</dd>
        <dt className="text-muted-foreground">To</dt>
        <dd>{names.who(t.metadata.to)}</dd>
        <dt className="text-muted-foreground">Task</dt>
        <dd className="break-all">{t.id}</dd>
        <dt className="text-muted-foreground">Context</dt>
        <dd className="break-all">{t.contextId}</dd>
      </dl>
      <ol>
        {(t.history ?? []).map((m) => (
          <li key={m.messageId} className="border-t py-3">
            <p className="flex items-baseline gap-2 font-bold">
              <span className="inline-block size-2.5 shrink-0" style={{ background: names.color(m.metadata?.from ?? "") }} aria-hidden />
              {names.who(m.metadata?.from ?? "")}
              <span className="text-xs font-normal text-muted-foreground">{timeAgo(m.metadata?.createdAt ?? 0)}</span>
            </p>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">{textOf(m.parts)}</p>
          </li>
        ))}
      </ol>
      {(t.artifacts ?? []).map((a) => (
        <section key={a.artifactId} className="border-t-2 border-foreground pt-2">
          <h4 className="mb-2 text-sm font-bold">Result: {a.name}</h4>
          <pre className="whitespace-pre-wrap break-words bg-muted p-3 font-mono text-xs">{textOf(a.parts)}</pre>
        </section>
      ))}
      {isOpen(t) && (
        <form
          className="grid gap-2 border-t-2 border-foreground pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (reply.trim()) send();
          }}
        >
          <Label htmlFor="reply" className="font-bold">
            {toUser ? `Answer ${names.who(t.metadata.from)}` : `Message ${names.who(t.metadata.to)} on this task`}
          </Label>
          <Textarea id="reply" rows={3} value={reply} onChange={(e) => setReply(e.target.value)} />
          <div className="flex items-center justify-end gap-2">
            {!toUser && (
              <Button type="button" variant="ghost" onClick={() => api(`/api/tasks/${id}/cancel`, "POST").catch((e) => setError(e.message))}>
                Cancel task
              </Button>
            )}
            <Button type="submit" disabled={!reply.trim()}>
              {toUser ? "Send answer" : "Send message"}
            </Button>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </form>
      )}
    </article>
  );
}

export function TasksPanel({ s, names, openTask, setOpenTask }: { s: LiveState; names: Names; openTask: string | null; setOpenTask: (id: string | null) => void }) {
  const mine = s.tasks.filter(needsUser);
  const open = s.tasks.filter(isOpen);
  const [filter, setFilter] = useState<"you" | "open" | "all">(mine.length ? "you" : open.length ? "open" : "all");
  if (openTask) return <TaskDetail id={openTask} s={s} names={names} onBack={() => setOpenTask(null)} />;

  const list = filter === "you" ? mine : filter === "open" ? open : s.tasks;
  const filters = [
    ["you", "Needs you", mine.length],
    ["open", "Open", open.length],
    ["all", "All", s.tasks.length],
  ] as const;
  return (
    <div className="flex flex-col px-6 pb-10">
      <div className="mb-2 flex gap-5" role="tablist" aria-label="Filter tasks">
        {filters.map(([k, label, n]) => (
          <button
            key={k}
            role="tab"
            aria-selected={filter === k}
            onClick={() => setFilter(k)}
            className={cn("pb-0.5 text-sm font-bold text-muted-foreground", filter === k && "text-foreground shadow-[inset_0_-2px_0_currentColor]")}
          >
            {label} <span className={cn("font-normal", k === "you" && n > 0 ? "text-destructive" : "text-muted-foreground")}>{n}</span>
          </button>
        ))}
      </div>
      {list.length === 0 ? (
        <p className="py-3 text-muted-foreground">
          {filter === "you" ? "Nothing is waiting on you." : filter === "open" ? "No open tasks." : "No tasks yet. Send a request to start."}
        </p>
      ) : (
        <ol>
          {list.map((t) => (
            <li key={t.id} className="border-t">
              <button className="group grid w-full gap-0.5 py-3 text-left" onClick={() => setOpenTask(t.id)}>
                <StateLabel state={t.status.state} />
                <span className="text-sm font-bold leading-snug group-hover:underline">{t.metadata.title}</span>
                <span className="text-xs text-muted-foreground">
                  {names.who(t.metadata.from)} to {names.who(t.metadata.to)}, {timeAgo(t.metadata.updatedAt)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
