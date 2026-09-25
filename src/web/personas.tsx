import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { Persona } from "../shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { api, type LiveState } from "./live";
import { shortOf } from "./names";

const BLANK: Persona = {
  id: "",
  teamId: "",
  name: "",
  short: "",
  title: "",
  color: "#C98BDB",
  description: "",
  runtime: "claude",
  model: "",
  permissionMode: "acceptEdits",
  instructions: "",
  rules: [],
  canTalkTo: ["*"],
  canSpawn: false,
  orchestrator: false,
  entry: false,
  maxInstances: 2,
  skills: [],
};

const PERMISSIONS = [
  { id: "default", label: "Ask before edits and commands" },
  { id: "acceptEdits", label: "Edit files, ask for commands" },
  { id: "yolo", label: "YOLO: never ask" },
] as const;

function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("grid min-w-0 content-start gap-1.5", className)}>
      <Label className="text-xs font-bold">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-4 border-t border-foreground pt-2">
      <h3 className="text-sm font-bold">{title}</h3>
      {children}
    </section>
  );
}

export function PersonaEditor({ s, team }: { s: LiveState; team: string }) {
  const base = `/api/teams/${team}/personas`;
  const [selectedId, setSelectedId] = useState<string | null>(s.personas[0]?.id ?? null);
  const [draft, setDraft] = useState<Persona | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const saved = s.personas.find((p) => p.id === selectedId);
  useEffect(() => {
    if (!isNew) setDraft(saved ? structuredClone(saved) : null);
  }, [selectedId, isNew, saved && JSON.stringify(saved)]);

  const set = <K extends keyof Persona>(k: K, v: Persona[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const dirty = isNew || (!!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved));

  const save = async () => {
    if (!draft) return;
    setStatus(null);
    try {
      const clean = { ...draft, rules: draft.rules.map((r) => r.trim()).filter(Boolean) };
      if (isNew) {
        await api(base, "POST", clean);
        setIsNew(false);
        setSelectedId(clean.id);
      } else {
        await api(`${base}/${clean.id}`, "PUT", clean);
      }
      setStatus({ ok: true, text: "Saved. New sessions of this persona use these settings." });
    } catch (e) {
      setStatus({ ok: false, text: (e as Error).message });
    }
  };
  const remove = async () => {
    if (!draft || !confirm(`Delete ${draft.name}? Running sessions keep going until you stop them.`)) return;
    await api(`${base}/${draft.id}`, "DELETE");
    setSelectedId(s.personas.find((p) => p.id !== draft.id)?.id ?? null);
  };
  const reset = async () => {
    if (!confirm("Replace this team's personas with the six defaults? Its edits and custom personas will be lost. Other teams are not affected.")) return;
    await api(`${base}/reset`, "POST");
    setIsNew(false);
  };

  const others = s.personas.filter((p) => p.id !== draft?.id);
  const everyone = !!draft?.canTalkTo.includes("*");
  const toggleTalk = (id: string) => {
    if (!draft) return;
    const base = everyone ? others.map((o) => o.id) : draft.canTalkTo;
    set("canTalkTo", base.includes(id) ? base.filter((x) => x !== id) : [...base, id]);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-foreground px-6 pb-3" aria-label="Personas">
        {s.personas.map((p) => (
          <button
            key={p.id}
            aria-current={!isNew && p.id === selectedId}
            onClick={() => {
              setIsNew(false);
              setSelectedId(p.id);
              setStatus(null);
            }}
            className={cn("flex shrink-0 items-center gap-2 px-2.5 py-1.5 text-sm font-bold hover:bg-muted", !isNew && p.id === selectedId && "bg-foreground text-background hover:bg-foreground")}
          >
            <span className="size-2.5" style={{ background: p.color }} aria-hidden />
            {p.name}
          </button>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 border-foreground"
          onClick={() => {
            setIsNew(true);
            setDraft({ ...structuredClone(BLANK), teamId: team });
            setStatus(null);
          }}
        >
          <Plus /> New persona
        </Button>
      </nav>

      {draft ? (
        <form
          className="min-h-0 flex-1 overflow-y-auto px-6 pb-16"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="sticky top-0 z-10 flex items-center gap-3 bg-background py-4">
            <span className="grid size-9 shrink-0 place-items-center text-xs font-bold text-white" style={{ background: draft.color }} aria-hidden>
              {shortOf(draft) || "?"}
            </span>
            <h2 className="flex-1 truncate text-2xl font-bold tracking-tight">{draft.name || "New persona"}</h2>
            {!isNew && (
              <Button type="button" variant="ghost" onClick={remove}>
                Delete
              </Button>
            )}
            <Button type="submit" disabled={!dirty}>
              {isNew ? "Create persona" : "Save changes"}
            </Button>
          </div>
          {status && <p className={cn("mb-2 text-sm", status.ok ? "font-bold" : "text-destructive")}>{status.text}</p>}

          <div className="grid gap-8">
            <Section title="Identity">
              <div className="grid gap-4 sm:grid-cols-[1fr_1fr_90px_90px]">
                <Field label="Name">
                  <Input required value={draft.name} onChange={(e) => set("name", e.target.value)} />
                </Field>
                <Field label="Id" hint="Agents address this persona by id.">
                  <Input
                    required
                    disabled={!isNew}
                    pattern="[a-z0-9][a-z0-9\-]{1,40}"
                    value={draft.id}
                    onChange={(e) => set("id", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
                  />
                </Field>
                <Field label="Code" hint="Sidebar label">
                  <Input maxLength={3} value={draft.short ?? ""} onChange={(e) => set("short", e.target.value)} />
                </Field>
                <Field label="Color">
                  <input type="color" className="h-9 w-full cursor-pointer border border-input bg-transparent p-0.5" value={draft.color} onChange={(e) => set("color", e.target.value)} />
                </Field>
              </div>
              <Field label="Title">
                <Input value={draft.title} onChange={(e) => set("title", e.target.value)} />
              </Field>
              <Field label="Description" hint="Teammates read this when deciding who to ask. It is also the A2A agent card description.">
                <Input value={draft.description} onChange={(e) => set("description", e.target.value)} />
              </Field>
            </Section>

            <Section title="Coding agent">
              <div className="grid gap-4 sm:grid-cols-[1fr_1fr_1.5fr_100px]">
                <Field label="Runtime">
                  <Select value={draft.runtime} onValueChange={(v) => set("runtime", v as Persona["runtime"])}>
                    <SelectTrigger className="w-full min-w-0 [&>span]:truncate">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {s.runtimes.map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          {r.name}
                          {r.path ? "" : " (not installed)"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Model">
                  <Input placeholder="CLI default" value={draft.model} onChange={(e) => set("model", e.target.value)} />
                </Field>
                <Field label="Permissions">
                  <Select value={draft.permissionMode} onValueChange={(v) => set("permissionMode", v as Persona["permissionMode"])}>
                    <SelectTrigger className="w-full min-w-0 [&>span]:truncate">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PERMISSIONS.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Max sessions">
                  <Input type="number" min={1} max={10} value={draft.maxInstances} onChange={(e) => set("maxInstances", Math.max(1, Number(e.target.value)))} />
                </Field>
              </div>
            </Section>

            <Section title="Role">
              <Field label="Instructions" hint="Added to the agent's system prompt, together with the team list and the A2A protocol.">
                <Textarea rows={10} className="font-mono text-xs leading-relaxed" value={draft.instructions} onChange={(e) => set("instructions", e.target.value)} />
              </Field>
              <Field label="Rules, one per line">
                <Textarea rows={4} value={draft.rules.join("\n")} onChange={(e) => set("rules", e.target.value.split("\n"))} />
              </Field>
            </Section>

            <Section title="Team powers">
              <div className="flex flex-wrap gap-x-6 gap-y-3">
                {(
                  [
                    ["entry", "Takes requests from the request bar"],
                    ["orchestrator", "Orchestrator: sees every task on the team"],
                    ["canSpawn", "Can start and stop other agents' sessions"],
                  ] as const
                ).map(([k, label]) => (
                  <label key={k} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={draft[k]} onCheckedChange={(v) => set(k, v === true)} />
                    {label}
                  </label>
                ))}
              </div>
              <div className="grid gap-2">
                <p className="text-xs font-bold">Can open tasks with</p>
                <div className="flex flex-wrap gap-x-6 gap-y-3">
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={everyone} onCheckedChange={(v) => set("canTalkTo", v === true ? ["*"] : [])} />
                    Everyone
                  </label>
                  {others.map((o) => (
                    <label key={o.id} className={cn("flex items-center gap-2 text-sm", everyone && "text-muted-foreground")}>
                      <Checkbox checked={everyone || draft.canTalkTo.includes(o.id)} disabled={everyone} onCheckedChange={() => toggleTalk(o.id)} />
                      {o.name}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">Anyone can always reply on a task they were given, and message you.</p>
              </div>
            </Section>

            <Button type="button" variant="link" className="justify-self-start px-0 text-muted-foreground" onClick={reset}>
              Restore the default team
            </Button>
          </div>
        </form>
      ) : (
        <p className="p-6 text-muted-foreground">Pick a persona to edit.</p>
      )}
    </div>
  );
}
