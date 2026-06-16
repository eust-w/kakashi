import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, CheckCircle2, GitBranch, Play, RefreshCw, Search, ShieldCheck, SquareTerminal, XCircle } from "lucide-react";
import "./styles.css";

type RunStage =
  | "created"
  | "parsing"
  | "searching"
  | "analyzing"
  | "planning"
  | "waiting_for_selection"
  | "waiting_for_confirmation"
  | "materializing"
  | "executing"
  | "verifying"
  | "exporting"
  | "completed"
  | "failed"
  | "cancelled";

interface RepoCandidate {
  fullName: string;
  htmlUrl: string;
  description: string;
  stars: number;
  language: string | null;
  license: string | null;
  score: number;
}

interface Capability {
  id: string;
  name: string;
}

interface CapabilityGraph {
  capabilities: Capability[];
  edges: Array<{ capabilityId: string; repoFullName: string; confidence: number; evidence: string[] }>;
  gaps: Capability[];
}

interface RunState {
  runId: string;
  mode: "auto" | "interactive";
  stage: RunStage;
  requirementText: string;
  outputDir: string;
  candidates?: RepoCandidate[];
  graph?: CapabilityGraph;
  plan?: {
    main: { repo: RepoCandidate };
    auxiliaries: Array<{ repo: RepoCandidate }>;
    tasks: Array<{ title: string; successCriteria: string[] }>;
  };
  report?: { verification: { summary: string; ok: boolean } };
  error?: string;
}

interface RunEvent {
  id: string;
  timestamp: string;
  stage: RunStage;
  level: "info" | "warn" | "error";
  message: string;
}

function App() {
  const [runs, setRuns] = useState<RunState[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [active, setActive] = useState<RunState | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [requirement, setRequirement] = useState("");
  const [outputDir, setOutputDir] = useState("kakashi-output");
  const [mode, setMode] = useState<"auto" | "interactive">("auto");
  const [maxRepos, setMaxRepos] = useState(12);
  const [maxIterations, setMaxIterations] = useState(3);
  const [allowCopyleft, setAllowCopyleft] = useState(false);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedRepositories, setSelectedRepositories] = useState<string[]>([]);
  const [selectionSnapshotKey, setSelectionSnapshotKey] = useState("");
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);

  useEffect(() => {
    void refreshRuns();
  }, []);

  useEffect(() => {
    if (!activeId) return;
    let closed = false;
    const source = new EventSource(`/api/runs/${activeId}/events`);
    source.onmessage = (message) => {
      if (closed) return;
      const event = JSON.parse(message.data) as RunEvent;
      setEvents((current) => [...current, event]);
      void loadRun(activeId);
    };
    source.onerror = () => {
      source.close();
    };
    void loadRun(activeId);
    return () => {
      closed = true;
      source.close();
    };
  }, [activeId]);

  const groupedEdges = useMemo(() => {
    const graph = active?.graph;
    if (!graph) return [];
    return graph.capabilities.map((capability) => ({
      capability,
      edges: graph.edges.filter((edge) => edge.capabilityId === capability.id).slice(0, 3)
    }));
  }, [active]);

  const plannedRepositories = useMemo(() => (active ? getPlannedRepositories(active) : []), [active]);
  const selectedRepositorySet = useMemo(() => new Set(selectedRepositories), [selectedRepositories]);
  const canSelectRepositories = active?.mode === "interactive" && active.stage === "waiting_for_confirmation";
  const hasCandidateSelection = canSelectRepositories && (active?.candidates?.length ?? 0) > 0;
  const selectionDirty = hasCandidateSelection && !sameRepositorySelection(selectedRepositories, plannedRepositories);
  const executeDisabled = hasCandidateSelection && (selectedRepositories.length === 0 || selectionDirty || selectionBusy);

  useEffect(() => {
    if (!active) {
      setSelectedRepositories([]);
      setSelectionSnapshotKey("");
      setSelectionError(null);
      return;
    }
    const candidates = active.candidates ?? [];
    if (candidates.length === 0) {
      setSelectedRepositories([]);
      setSelectionSnapshotKey(`${active.runId}:empty`);
      setSelectionError(null);
      return;
    }
    const planned = getPlannedRepositories(active);
    const nextSelection = planned.length > 0 ? planned : candidates.map((repo) => repo.fullName);
    const nextKey = `${active.runId}:${candidates.map((repo) => repo.fullName).join("|")}:${planned.join("|")}`;
    if (nextKey === selectionSnapshotKey) return;
    setSelectedRepositories(nextSelection);
    setSelectionSnapshotKey(nextKey);
    setSelectionError(null);
  }, [active, selectionSnapshotKey]);

  async function refreshRuns() {
    const response = await fetch("/api/runs");
    const data = (await response.json()) as RunState[];
    setRuns(data);
    if (!activeId && data[0]) setActiveId(data[0].runId);
  }

  async function loadRun(runId: string) {
    const response = await fetch(`/api/runs/${runId}`);
    if (!response.ok) return;
    const data = (await response.json()) as RunState;
    setActive(data);
    await refreshRuns();
  }

  async function createRun(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        requirement,
        outputDir,
        options: { maxRepos, maxIterations, allowCopyleft, force }
      })
    });
    setBusy(false);
    if (!response.ok) {
      alert((await response.json()).error);
      return;
    }
    const state = (await response.json()) as RunState;
    setEvents([]);
    setActiveId(state.runId);
    setRequirement("");
    await refreshRuns();
  }

  async function confirmPlan(confirmed: boolean) {
    if (!active) return;
    await fetch(`/api/runs/${active.runId}/confirm-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed })
    });
    await loadRun(active.runId);
  }

  async function updateSelectedRepositories() {
    if (!active || selectedRepositories.length === 0) return;
    setSelectionBusy(true);
    setSelectionError(null);
    const response = await fetch(`/api/runs/${active.runId}/select-repositories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedRepositories })
    });
    setSelectionBusy(false);
    const body = (await response.json()) as RunState | { error?: string };
    if (!response.ok) {
      setSelectionError("error" in body && body.error ? body.error : "Could not update the fusion plan.");
      return;
    }
    setActive(body as RunState);
    await refreshRuns();
  }

  function toggleRepository(fullName: string, checked: boolean) {
    setSelectedRepositories((current) => {
      if (checked) return Array.from(new Set([...current, fullName]));
      return current.filter((repo) => repo !== fullName);
    });
  }

  async function cancelRun() {
    if (!active || isTerminalStage(active.stage)) return;
    await fetch(`/api/runs/${active.runId}/cancel`, { method: "POST" });
    await loadRun(active.runId);
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">K</div>
          <div>
            <h1>Kakashi</h1>
            <p>Codex capability fusion</p>
          </div>
        </div>

        <form className="new-run" onSubmit={createRun}>
          <label>
            Requirement
            <textarea
              value={requirement}
              onChange={(event) => setRequirement(event.target.value)}
              required
              rows={5}
              placeholder="Describe the software you want to build"
            />
          </label>
          <label>
            Output directory
            <input value={outputDir} onChange={(event) => setOutputDir(event.target.value)} required />
          </label>
          <div className="number-grid">
            <label>
              Max repositories
              <input
                type="number"
                min={1}
                max={50}
                value={maxRepos}
                onChange={(event) => setMaxRepos(Number(event.target.value))}
                required
              />
            </label>
            <label>
              Repair iterations
              <input
                type="number"
                min={1}
                max={10}
                value={maxIterations}
                onChange={(event) => setMaxIterations(Number(event.target.value))}
                required
              />
            </label>
          </div>
          <div className="checkbox-grid">
            <label>
              <input type="checkbox" checked={allowCopyleft} onChange={(event) => setAllowCopyleft(event.target.checked)} />
              Allow copyleft
            </label>
            <label>
              <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />
              Overwrite output
            </label>
          </div>
          <div className="segmented">
            <button type="button" className={mode === "auto" ? "selected" : ""} onClick={() => setMode("auto")}>
              <Play size={15} /> Auto
            </button>
            <button type="button" className={mode === "interactive" ? "selected" : ""} onClick={() => setMode("interactive")}>
              <SquareTerminal size={15} /> Interactive
            </button>
          </div>
          <button className="primary" disabled={busy || !requirement.trim()}>
            {busy ? <RefreshCw size={16} className="spin" /> : <Search size={16} />}
            Start run
          </button>
        </form>

        <section className="run-list">
          <h2>Runs</h2>
          {runs.map((run) => (
            <button key={run.runId} className={run.runId === activeId ? "run selected" : "run"} onClick={() => setActiveId(run.runId)}>
              <span>{run.requirementText}</span>
              <small>{run.stage}</small>
            </button>
          ))}
        </section>
      </aside>

      <section className="workspace">
        {!active ? (
          <EmptyState />
        ) : (
          <>
            <header className="workspace-header">
              <div>
                <p className="run-id">{active.runId}</p>
                <h2>{active.requirementText}</h2>
                <p>{active.outputDir}</p>
              </div>
              <div className="header-actions">
                {!isTerminalStage(active.stage) && (
                  <button className="secondary danger" onClick={() => void cancelRun()}>
                    <XCircle size={16} />
                    Cancel
                  </button>
                )}
                <Status stage={active.stage} />
              </div>
            </header>

            <section className="panel-grid">
              <Panel title="Candidate Repositories" icon={<GitBranch size={18} />}>
                {hasCandidateSelection && (
                  <div className="selection-toolbar">
                    <span>
                      {selectedRepositories.length}/{active.candidates?.length ?? 0} selected
                    </span>
                    <button
                      className="secondary"
                      onClick={() => void updateSelectedRepositories()}
                      disabled={!selectionDirty || selectedRepositories.length === 0 || selectionBusy}
                    >
                      {selectionBusy ? <RefreshCw size={15} className="spin" /> : <RefreshCw size={15} />}
                      Update plan
                    </button>
                  </div>
                )}
                {selectionError && <p className="error-text">{selectionError}</p>}
                <div className="table">
                  {(active.candidates ?? []).map((repo) => (
                    <div className={canSelectRepositories ? "repo-row selectable" : "repo-row"} key={repo.fullName}>
                      {canSelectRepositories && (
                        <input
                          aria-label={`Use ${repo.fullName}`}
                          type="checkbox"
                          checked={selectedRepositorySet.has(repo.fullName)}
                          onChange={(event) => toggleRepository(repo.fullName, event.target.checked)}
                        />
                      )}
                      <a href={repo.htmlUrl} target="_blank" rel="noreferrer">
                        <strong>{repo.fullName}</strong>
                      </a>
                      <span>{repo.language ?? "unknown"}</span>
                      <span>{repo.license ?? "no license"}</span>
                      <span>{repo.stars} stars</span>
                    </div>
                  ))}
                  {(active.candidates ?? []).length === 0 && <p className="muted">Candidates will appear after GitHub search completes.</p>}
                </div>
              </Panel>

              <Panel title="Capability Graph" icon={<Activity size={18} />}>
                <div className="graph">
                  {groupedEdges.map(({ capability, edges }) => (
                    <div className="capability" key={capability.id}>
                      <strong>{capability.name}</strong>
                      {edges.length === 0 ? (
                        <span className="gap">gap</span>
                      ) : (
                        edges.map((edge) => (
                          <span key={`${capability.id}-${edge.repoFullName}`}>
                            {edge.repoFullName} · {Math.round(edge.confidence * 100)}%
                          </span>
                        ))
                      )}
                    </div>
                  ))}
                  {groupedEdges.length === 0 && <p className="muted">Capability graph is built from real repository analysis.</p>}
                </div>
              </Panel>
            </section>

            <section className="panel-grid">
              <Panel title="Fusion Plan" icon={<ShieldCheck size={18} />}>
                {active.plan ? (
                  <div className="plan">
                    <p>
                      Main: <strong>{active.plan.main.repo.fullName}</strong>
                    </p>
                    <p>Auxiliary: {active.plan.auxiliaries.map((source) => source.repo.fullName).join(", ") || "none"}</p>
                    <ol>
                      {active.plan.tasks.map((task) => (
                        <li key={task.title}>{task.title}</li>
                      ))}
                    </ol>
                    {active.stage === "waiting_for_confirmation" && (
                      <div className="actions">
                        <button className="primary" disabled={executeDisabled} onClick={() => void confirmPlan(true)}>
                          Execute
                        </button>
                        <button onClick={() => void confirmPlan(false)}>Cancel</button>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="muted">Plan appears after repository analysis.</p>
                )}
              </Panel>

              <Panel title="Live Events" icon={<SquareTerminal size={18} />}>
                <div className="events">
                  {events.map((event) => (
                    <div className={`event ${event.level}`} key={event.id}>
                      <span>{event.stage}</span>
                      <p>{event.message}</p>
                    </div>
                  ))}
                  {events.length === 0 && <p className="muted">Run events stream here as SSE messages.</p>}
                </div>
              </Panel>
            </section>
          </>
        )}
      </section>
    </main>
  );
}

function Status({ stage }: { stage: RunStage }) {
  const done = stage === "completed";
  const failed = stage === "failed" || stage === "cancelled";
  return (
    <div className={failed ? "status failed" : done ? "status done" : "status active"}>
      {done ? <CheckCircle2 size={18} /> : <Activity size={18} />}
      {stage}
    </div>
  );
}

function isTerminalStage(stage: RunStage): boolean {
  return stage === "completed" || stage === "failed" || stage === "cancelled";
}

function getPlannedRepositories(run: RunState): string[] {
  if (!run.plan) return [];
  return [run.plan.main.repo.fullName, ...run.plan.auxiliaries.map((source) => source.repo.fullName)];
}

function sameRepositorySelection(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function Panel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="panel">
      <header>
        {icon}
        <h3>{title}</h3>
      </header>
      {children}
    </section>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <h2>Create a Kakashi run</h2>
      <p>Use the form to start real GitHub search, repository analysis, Codex execution, and verification.</p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
