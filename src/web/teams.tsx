import { useEffect, useState } from "react";
import { Check, ChevronDown, Plus, Settings2 } from "lucide-react";
import type { Team } from "../shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { api, type LiveState } from "./live";
import { waitingOn } from "./names";

/** Header control: which team you're looking at, and what the other teams need from you. */
export function TeamSwitcher({ s, team, onPick, onNew, onSettings }: { s: LiveState; team: Team; onPick: (id: string) => void; onNew: () => void; onSettings: () => void }) {
  const elsewhere = s.teams.filter((t) => t.id !== team.id).reduce((n, t) => n + waitingOn(s, t.id), 0);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-8 max-w-56 gap-1.5 px-2 font-bold" aria-label={`Team: ${team.name}. Switch team`}>
          <span className="truncate">{team.name}</span>
          {elsewhere > 0 && (
            <span className="bg-destructive px-1.5 text-xs text-destructive-foreground" title={`${elsewhere} waiting on you in other teams`}>
              {elsewhere}
            </span>
          )}
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Teams</DropdownMenuLabel>
        {s.teams.map((t) => {
          const running = s.sessions.filter((x) => x.teamId === t.id && x.activity !== "exited").length;
          const waiting = waitingOn(s, t.id);
          return (
            <DropdownMenuItem key={t.id} onSelect={() => onPick(t.id)}>
              <Check className={cn(t.id !== team.id && "invisible")} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-bold">{t.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {running ? `${running} running` : "No agents running"}
                  {waiting > 0 && <span className="text-destructive">, {waiting} waiting on you</span>}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onNew}>
          <Plus /> New team
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onSettings}>
          <Settings2 /> {team.name} settings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "team";

export function NewTeamDialog({ s, open, onOpenChange, onCreated }: { s: LiveState; open: boolean; onOpenChange: (v: boolean) => void; onCreated: (t: Team) => void }) {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [copyFrom, setCopyFrom] = useState("defaults");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName("");
      setFolder("");
      setCopyFrom("defaults");
      setError(null);
    }
  }, [open]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const team = await api<Team>("/api/teams", "POST", { name, workspaceDir: folder || undefined, copyFrom: copyFrom === "defaults" ? undefined : copyFrom });
      onOpenChange(false);
      onCreated(team);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create();
          }}
        >
          <DialogHeader>
            <DialogTitle>New team</DialogTitle>
            <DialogDescription>A team works on one project, in its own folder, with its own personas. Agents only see their own team.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="team-name" className="text-xs font-bold">
              Name
            </Label>
            <Input id="team-name" autoFocus placeholder="Mobile app" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="team-folder" className="text-xs font-bold">
              Folder
            </Label>
            <Input id="team-folder" className="font-mono text-xs" placeholder={`${s.settings.workspacesRoot}/${slug(name || "team")}`} value={folder} onChange={(e) => setFolder(e.target.value)} />
            <p className="text-xs text-muted-foreground">Where this team's agents work. Leave empty for the default; it's created when the first agent starts.</p>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs font-bold">Personas</Label>
            <Select value={copyFrom} onValueChange={setCopyFrom}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="defaults">The default six (PM, Project Manager, SDE, Frontend, QA, Tester)</SelectItem>
                {s.teams.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    Copy {t.name}'s personas
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">The new team gets its own copy. Edits in one team never change another.</p>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              Create team
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TeamSettingsDialog({ s, team, open, onOpenChange, onDeleted }: { s: LiveState; team: Team; open: boolean; onOpenChange: (v: boolean) => void; onDeleted: () => void }) {
  const [name, setName] = useState(team.name);
  const [folder, setFolder] = useState(team.workspaceDir);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName(team.name);
      setFolder(team.workspaceDir);
      setError(null);
    }
  }, [open, team.id]);
  const running = s.sessions.filter((x) => x.teamId === team.id && x.activity !== "exited").length;

  const save = async () => {
    setError(null);
    try {
      await api(`/api/teams/${team.id}`, "PUT", { name, workspaceDir: folder });
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete ${team.name}? Its personas, tasks and history are removed. Its folder (${team.workspaceDir}) stays on disk.`)) return;
    try {
      await api(`/api/teams/${team.id}`, "DELETE");
      onOpenChange(false);
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{team.name} settings</DialogTitle>
            <DialogDescription>Team id: {team.id}. A folder change applies to agents started from now on.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="ts-name" className="text-xs font-bold">
              Name
            </Label>
            <Input id="ts-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ts-folder" className="text-xs font-bold">
              Folder
            </Label>
            <Input id="ts-folder" className="font-mono text-xs" value={folder} onChange={(e) => setFolder(e.target.value)} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter className="sm:justify-between">
            {team.id === "main" ? (
              <span className="self-center text-xs text-muted-foreground">The main team can't be deleted.</span>
            ) : (
              <Button type="button" variant="ghost" className="text-destructive" disabled={running > 0} title={running ? "Stop this team's agents first" : undefined} onClick={remove}>
                Delete team
              </Button>
            )}
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim()}>
                Save
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
