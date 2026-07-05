// Xero certification Checkpoint 3 (Connection) requires a page where users
// can, without support intervention:
//   - see the name of each connected Xero tenant
//   - see connection status, and be alerted + guided to reconnect if a
//     connection has been revoked from Xero's side
//   - disconnect a tenant, which calls the Xero API (not just a local
//     "hide" toggle)
//   - get to a "Connect" flow for adding another organisation
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { xero, type XeroConnectionInfo } from "@/lib/xero";
import { AppShell } from "@/components/AppShell";
import { Building2, Link2, Unplug, RefreshCw, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Xero Connections — FlowSync" },
      {
        name: "description",
        content: "Manage which Xero organisations are connected to FlowSync.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: () => (
    <AppShell>
      <SettingsPage />
    </AppShell>
  ),
});

// A failed refresh in getValidAccessToken (shared edge-function helper)
// means Xero revoked the connection -- distinct from simply having none
// connected yet, and worth a different, more alarming message.
function isRevokedConnectionError(message: string): boolean {
  return /revoked|reconnect/i.test(message);
}

function SettingsPage() {
  const [connections, setConnections] = useState<XeroConnectionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await xero.getConnections();
      setConnections(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load Xero connections.";
      // "No Xero organisation connected" just means an empty state, not an
      // error worth alarming the user about.
      if (/no xero organisation connected/i.test(message)) {
        setConnections([]);
      } else {
        setError(message);
        setConnections(null);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleDisconnect(connectionId: string, tenantName: string) {
    setDisconnectingId(connectionId);
    try {
      await xero.disconnectConnection(connectionId);
      toast.success(`Disconnected ${tenantName}.`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect.");
    } finally {
      setDisconnectingId(null);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Settings
      </div>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Xero Connections</h1>
      <p className="mt-2 max-w-xl text-sm text-muted-foreground">
        Manage which Xero organisations FlowSync has access to. Disconnecting removes FlowSync's
        access immediately on Xero's side.
      </p>

      {loading && <p className="mt-8 text-sm text-muted-foreground">Loading connections…</p>}

      {error && (
        <div className="mt-8 flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium text-destructive">
              {isRevokedConnectionError(error)
                ? "Your Xero connection needs to be renewed"
                : "Something went wrong"}
            </p>
            <p className="mt-1 text-muted-foreground">{error}</p>
            <Link
              to="/auth/connect"
              className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              <RefreshCw className="h-3 w-3" /> Reconnect Xero
            </Link>
          </div>
        </div>
      )}

      {!loading && !error && connections && connections.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-border p-8 text-center">
          <Building2 className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">No Xero organisations connected yet.</p>
          <Link
            to="/auth/connect"
            className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Link2 className="h-4 w-4" /> Connect Xero organisation
          </Link>
        </div>
      )}

      {!loading && !error && connections && connections.length > 0 && (
        <div className="mt-8 space-y-3">
          {connections.map((conn) => (
            <div
              key={conn.id}
              className="flex items-center justify-between rounded-xl border border-border bg-card p-5"
            >
              <div className="flex items-center gap-3">
                <div className="grid h-9 w-9 place-items-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                  <Building2 className="h-4 w-4" />
                </div>
                <div>
                  <div className="font-medium">{conn.tenantName}</div>
                  <div className="text-xs text-muted-foreground">{conn.tenantType} · Connected</div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleDisconnect(conn.id, conn.tenantName)}
                disabled={disconnectingId === conn.id}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-60"
              >
                <Unplug className="h-3 w-3" />
                {disconnectingId === conn.id ? "Disconnecting…" : "Disconnect"}
              </button>
            </div>
          ))}

          <Link
            to="/auth/connect"
            className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent"
          >
            <Link2 className="h-4 w-4" /> Connect another organisation
          </Link>
        </div>
      )}
    </main>
  );
}