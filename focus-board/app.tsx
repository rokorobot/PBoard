import { memo, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  useBbNavigate,
  useSdk,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";

// The only two hard-coded colors; everything else uses host theme tokens.
const PASSIVE_BORDER = "#f5a524";
const ACTIVE_BORDER = "#3b82f6";
const PANEL_PATH = "focus";
const HOMEPAGE_LIMIT = 8; // tiles per group on the homepage; the panel shows all

type Group = "passive" | "active";
type Tile = { thread: PluginSidebarThread; group: Group; since: number; project: string; cloud: boolean };

const BUSY = new Set<string>(["starting", "active", "stopping", "provisioning", "waiting-for-host"]);

function groupOf(t: PluginSidebarThread): Group {
  // Blocked on an approval or question counts as waiting on you, even mid-turn.
  if (t.hasPendingInteraction) return "passive";
  return BUSY.has(t.runtimeStatus) || BUSY.has(t.status) ? "active" : "passive";
}

// When each thread entered its current group. Shared by both slots and kept for the app session.
// First sighting has no transition time, so it falls back to the thread's own timestamps.
const sinceCache = new Map<string, { group: Group; at: number }>();
function sinceOf(t: PluginSidebarThread, group: Group): number {
  const prev = sinceCache.get(t.id);
  if (prev && prev.group === group) return prev.at;
  const at = prev ? Date.now() : group === "passive" ? t.latestAttentionAt || t.updatedAt : t.updatedAt;
  sinceCache.set(t.id, { group, at });
  return at;
}

// Hosts that are provisioned machines (not the user's own computer) count as Cloud.
type HostInfo = { machineProviderId: string | null; type: string; name: string };
let hostsPromise: Promise<Map<string, HostInfo>> | null = null;
function useHosts(): Map<string, HostInfo> {
  const sdk = useSdk();
  const [hosts, setHosts] = useState<Map<string, HostInfo>>(new Map());
  useEffect(() => {
    hostsPromise ??= sdk.hosts
      .list()
      .then((list) => new Map(list.map((h) => [h.id, h as HostInfo])))
      .catch(() => ((hostsPromise = null), new Map()));
    let live = true;
    void hostsPromise.then((m) => live && setHosts(m));
    return () => {
      live = false;
    };
  }, [sdk]);
  return hosts;
}

function isCloud(t: PluginSidebarThread, hosts: Map<string, HostInfo>): boolean {
  const h = t.host ? hosts.get(t.host.id) : undefined;
  if (h) return h.machineProviderId != null || h.type === "ephemeral" || /cloud/i.test(h.name);
  if (t.host) return /cloud/i.test(t.host.name);
  return t.environment?.providerId != null && /cloud|sandbox|vm|modal/i.test(t.environment.providerId);
}

function useTiles(): { status: string; passive: Tile[]; active: Tile[] } {
  const state = experimental_useSidebarThreads();
  const hosts = useHosts();
  return useMemo(() => {
    const names = new Map(state.projects.map((p) => [p.id, p.name]));
    const tiles = state.threads
      .filter((t) => !t.isArchived && !t.isHidden)
      .map((thread): Tile => {
        const group = groupOf(thread);
        return {
          thread,
          group,
          since: sinceOf(thread, group),
          project: names.get(thread.projectId) ?? "Unknown project",
          cloud: isCloud(thread, hosts),
        };
      });
    const passive = tiles.filter((t) => t.group === "passive").sort((a, b) => a.since - b.since);
    const active = tiles.filter((t) => t.group === "active").sort((a, b) => a.since - b.since);
    return { status: state.status, passive, active };
  }, [state, hosts]);
}

// Last agent output per thread, refetched when the thread's updatedAt or status changes.
// One cache entry per thread; concurrent tiles for the same thread share one request.
const outputCache = new Map<string, { key: string; text: Promise<string> }>();
function useLastMessage(t: PluginSidebarThread): string | undefined {
  const sdk = useSdk();
  const key = `${t.updatedAt}:${t.status}`;
  const [text, setText] = useState<string | undefined>(undefined);
  useEffect(() => {
    let entry = outputCache.get(t.id);
    if (!entry || entry.key !== key) {
      entry = {
        key,
        text: sdk.threads.output({ threadId: t.id }).then(
          (r) => oneLine(r.output),
          () => "",
        ),
      };
      outputCache.set(t.id, entry);
    }
    let live = true;
    void entry.text.then((v) => live && setText(v));
    return () => {
      live = false;
    };
  }, [sdk, key, t.id]);
  return text;
}

function oneLine(s: string | null): string {
  if (!s) return "";
  return s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_`>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function duration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function statusLabel(tile: Tile): string {
  const t = tile.thread;
  if (t.hasPendingInteraction) return "Needs reply";
  if (t.status === "error") return "Error";
  if (t.status === "pending") return "Not started";
  if (t.queuedWork === "failed") return "Queue failed";
  if (tile.group === "active") return "Running";
  return "Idle";
}

const TileCard = memo(function TileCard({ tile, now }: { tile: Tile; now: number }) {
  const navigate = useBbNavigate();
  const message = useLastMessage(tile.thread);
  const t = tile.thread;
  const verb = tile.group === "active" ? "running" : "waiting";
  return (
    <button
      type="button"
      onClick={() => navigate.toThread(t.id)}
      title={t.displayTitle}
      style={{ borderColor: tile.group === "active" ? ACTIVE_BORDER : PASSIVE_BORDER }}
      className="flex min-w-0 flex-col gap-1.5 rounded-lg border-2 bg-card p-3 text-left text-card-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="truncate text-sm font-medium text-foreground">
        {t.isUnread && <span className="mr-1.5 inline-block size-1.5 rounded-full bg-primary align-middle" />}
        {t.displayTitle}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className="truncate">{tile.project}</span>
        <span className="shrink-0 rounded border border-border px-1 leading-4">{tile.cloud ? "Cloud" : "Local"}</span>
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {message === undefined ? "…" : message || "No messages yet"}
      </div>
      <div className="mt-auto flex items-center justify-between gap-2 text-xs">
        <span className={t.status === "error" ? "text-destructive" : "text-foreground"}>{statusLabel(tile)}</span>
        <span className="tabular-nums text-muted-foreground">
          {verb} {duration(now - tile.since)}
        </span>
      </div>
    </button>
  );
});

function Section({ title, color, tiles, limit, now }: { title: string; color: string; tiles: Tile[]; limit?: number; now: number }) {
  const shown = limit ? tiles.slice(0, limit) : tiles;
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <span className="inline-block size-2 rounded-full" style={{ background: color }} />
        {title}
        <span className="text-muted-foreground">{tiles.length}</span>
      </h3>
      {shown.length ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {shown.map((tile) => (
            <TileCard key={tile.thread.id} tile={tile} now={now} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Nothing here.</p>
      )}
    </section>
  );
}

function Board({ limit }: { limit?: number }) {
  const { status, passive, active } = useTiles();
  const now = useNow(30_000);
  const navigate = useBbNavigate();
  if (status === "loading") return <p className="text-sm text-muted-foreground">Loading threads…</p>;
  if (status === "error") return <p className="text-sm text-destructive">Couldn't load threads.</p>;
  const clipped = limit && (passive.length > limit || active.length > limit);
  return (
    <div className="space-y-5">
      <Section title="Passive — waiting on you" color={PASSIVE_BORDER} tiles={passive} limit={limit} now={now} />
      <Section title="Active — agent working" color={ACTIVE_BORDER} tiles={active} limit={limit} now={now} />
      {clipped && (
        <button type="button" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onClick={() => navigate.toPluginPanel(PANEL_PATH)}>
          Show all {passive.length + active.length} threads
        </button>
      )}
    </div>
  );
}

function HomepageBoard() {
  return <Board limit={HOMEPAGE_LIMIT} />;
}

function PanelBoard() {
  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <Board />
    </div>
  );
}

function usePassiveBadge() {
  const { passive } = useTiles();
  return passive.length ? { count: passive.length, tone: "warning" as const, label: `${passive.length} threads waiting on you` } : null;
}

export default definePluginApp((app) => {
  app.slots.homepageSection({ id: "focus-board", title: "Focus Board", component: HomepageBoard });
  app.slots.navPanel({
    id: "focus",
    title: "Focus",
    icon: "LayoutGrid",
    path: PANEL_PATH,
    component: PanelBoard,
    experimental_useBadge: usePassiveBadge,
  });
});
