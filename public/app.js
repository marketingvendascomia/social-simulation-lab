const $ = (id) => document.getElementById(id);
let selectedRun, currentRun, timer;
$("key").value = sessionStorage.getItem("lab-key") || "";
async function api(path, options = {}) {
  const headers = {
    ...(options.body instanceof FormData
      ? {}
      : { "content-type": "application/json" }),
    ...(options.headers || {}),
  };
  if ($("key").value) headers.authorization = `Bearer ${$("key").value}`;
  const response = await fetch(`/api${path}`, { ...options, headers });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Falha na requisição");
  return data;
}
function notice(message) {
  $("notice").textContent = message;
}
async function action(button, fn) {
  button.disabled = true;
  notice("");
  try {
    await fn();
  } catch (e) {
    notice(e.message);
  } finally {
    button.disabled = false;
  }
}
async function refresh() {
  const status = await api("/status");
  $("mode").textContent =
    status.mode === "demo"
      ? "DEMO · dados sintéticos"
      : "LIVE · serviços externos";
  const projects = await api("/projects");
  const value = $("project").value;
  $("project").replaceChildren(
    new Option("Selecione um projeto", ""),
    ...projects.map((p) => new Option(p.name, p.id)),
  );
  $("project").value = value;
  await loadRuns();
}
async function loadRuns() {
  const runs = await api("/runs");
  $("runs").replaceChildren(
    ...runs.slice(0, 15).map((run) => {
      const b = document.createElement("button");
      b.className = "secondary";
      b.textContent = `${run.id.slice(0, 8)} · ${run.status}`;
      b.onclick = () => {
        selectedRun = run.id;
        void poll().catch((e) => notice(e.message));
      };
      return b;
    }),
  );
}
$("connect").onclick = () =>
  action($("connect"), async () => {
    sessionStorage.setItem("lab-key", $("key").value);
    await refresh();
  });
$("project-form").onsubmit = (e) => {
  e.preventDefault();
  void action(e.submitter, async () => {
    const body = Object.fromEntries(new FormData(e.target));
    const project = await api("/projects", {
      method: "POST",
      body: JSON.stringify(body),
    });
    await refresh();
    $("project").value = project.id;
    notice("Projeto criado. Você pode adicionar documentos ou executar.");
  });
};
$("upload-button").onclick = () =>
  action($("upload-button"), async () => {
    if (!$("project").value) throw new Error("Selecione um projeto");
    const file = $("upload").files[0];
    if (!file) throw new Error("Selecione um documento");
    const form = new FormData();
    form.append("file", file);
    await api(`/projects/${$("project").value}/documents`, {
      method: "POST",
      body: form,
    });
    notice("Documento adicionado.");
  });
$("run-form").onsubmit = (e) => {
  e.preventDefault();
  void action(e.submitter, async () => {
    if (!$("project").value) throw new Error("Selecione um projeto");
    const f = new FormData(e.target);
    const body = {
      rounds: Number(f.get("rounds")),
      maxAgents: Number(f.get("maxAgents")),
      platforms:
        f.get("platform") === "both"
          ? ["twitter", "reddit"]
          : [f.get("platform")],
      events: f.get("event")
        ? [{ round: 0, agentId: 0, content: f.get("event") }]
        : [],
    };
    const run = await api(`/projects/${$("project").value}/runs`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    selectedRun = run.id;
    await poll();
  });
};
async function poll() {
  clearTimeout(timer);
  if (!selectedRun) return;
  const run = await api(`/runs/${selectedRun}`);
  currentRun = run;
  $("empty").hidden = true;
  $("result").hidden = false;
  $("run-status").textContent =
    `${run.mode.toUpperCase()} · ${run.status} · ${run.stage}${run.error ? " · " + run.error : ""}`;
  $("stages").replaceChildren(
    ...run.log.map((log) => {
      const li = document.createElement("li");
      li.textContent = `${log.stage}: ${log.message}`;
      return li;
    }),
  );
  $("metrics").textContent =
    `${run.personas.length} agentes · ${run.actions.length} ações · ${run.llmCalls} chamadas Node · ${run.tokens} tokens Node`;
  $("graph").textContent = JSON.stringify(
    { graph: run.graph, personas: run.personas },
    null,
    2,
  );
  $("timeline").replaceChildren(
    ...run.actions.slice(-100).map((a) => {
      const div = document.createElement("div");
      div.className = "action";
      const small = document.createElement("small");
      small.textContent = `${a.platform} · rodada ${a.round + 1} · agente ${a.agentId} · ${a.type}`;
      const text = document.createElement("div");
      text.textContent = a.content;
      div.append(small, text);
      return div;
    }),
  );
  $("report").textContent = run.report || "Aguardando relatório…";
  const agentValue = $("agent").value;
  $("agent").replaceChildren(
    new Option("Agente do relatório", ""),
    ...run.personas.map((p) => new Option(p.name, String(p.id))),
  );
  $("agent").value = agentValue;
  await loadRuns();
  if (["queued", "running"].includes(run.status))
    timer = setTimeout(() => void poll().catch((e) => notice(e.message)), 1500);
}
$("explore-form").onsubmit = (e) => {
  e.preventDefault();
  void action(e.submitter, async () => {
    const body = {
      question: new FormData(e.target).get("question"),
      ...($("agent").value !== "" ? { agentId: Number($("agent").value) } : {}),
    };
    const answer = await api(`/runs/${selectedRun}/explore`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    $("answer").textContent = answer.answer;
  });
};
$("download").onclick = () => {
  if (!currentRun?.report) return;
  const url = URL.createObjectURL(
    new Blob([currentRun.report], { type: "text/markdown;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `relatorio-${currentRun.id}.md`;
  a.click();
  URL.revokeObjectURL(url);
};
$("close-session").onclick = () =>
  action($("close-session"), async () => {
    await api(`/runs/${selectedRun}/close`, { method: "POST", body: "{}" });
    notice("Ambiente encerrado. Novas entrevistas exigem uma nova execução.");
  });
void refresh().catch((e) => notice(e.message));
