const $ = (id) => document.getElementById(id);
const platformNames = {
  instagram: "Instagram",
  google_reviews: "Avaliações Google",
  twitter: "Twitter",
  reddit: "Reddit",
};
const actionNames = {
  CREATE_POST: "Publicação",
  CREATE_COMMENT: "Comentário",
  LIKE_POST: "Curtida",
  CREATE_REVIEW: "Avaliação",
  REPLY_REVIEW: "Resposta da empresa",
  ANNOUNCEMENT: "Comunicado de contexto",
};
const platformSelect = document.querySelector('[name="platform"]');
platformSelect.onchange = () => {
  const messages = {
    instagram:
      "Instagram: publicações textuais, comentários e curtidas simulados. Não reproduz o algoritmo de alcance.",
    google_reviews:
      "Google: clientes avaliam com 1 a 5 estrelas; a empresa responde. Uma avaliação por cliente neste MVP. Comunicados dão contexto, sem alterar a nota.",
    brazil:
      "Dois ambientes independentes: interações no Instagram e reputação por estrelas no Google. Sem publicar nas plataformas reais.",
  };
  $("platform-help").textContent =
    messages[platformSelect.value] ||
    "Twitter e Reddit usam OASIS no modo live; no demo, textos fixos.";
};
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
      businessAgentId: Number(f.get("businessAgentId")),
      platforms:
        f.get("platform") === "brazil"
          ? ["instagram", "google_reviews"]
          : f.get("platform") === "both"
            ? ["twitter", "reddit"]
            : [f.get("platform")],
      events: f.get("event")
        ? [
            {
              round: 0,
              agentId: Number(f.get("businessAgentId")),
              content: f.get("event"),
            },
          ]
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
  $("close-session").hidden =
    run.mode !== "live" ||
    !run.config.platforms.some((p) => p === "twitter" || p === "reddit");
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
  const extra = [];
  if (run.config.platforms.includes("instagram") && run.metrics.instagram) {
    const m = run.metrics.instagram;
    extra.push(
      `Instagram simulado: ${m.posts} publicações, ${m.comments} comentários, ${m.likes} curtidas.`,
    );
  }
  if (
    run.config.platforms.includes("google_reviews") &&
    run.metrics.googleReviews
  ) {
    const m = run.metrics.googleReviews;
    extra.push(
      `Google simulado: ${m.count} avaliações; média ${m.averageStars === null ? "—" : m.averageStars.toLocaleString("pt-BR")}/5; ${m.answered} respondidas, ${m.unanswered} sem resposta. Distribuição: ${Object.entries(
        m.histogram,
      )
        .map(([stars, count]) => `${stars}★: ${count}`)
        .join(" · ")}. Essa não é a nota real da empresa.`,
    );
  }
  $("platform-metrics").textContent = extra.join("\n");
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
      const agent = run.personas.find((p) => p.id === a.agentId);
      small.textContent = `${platformNames[a.platform] || a.platform} · rodada ${a.round + 1} · ${agent?.name || `agente ${a.agentId}`} · ${actionNames[a.type] || a.type}`;
      const text = document.createElement("div");
      text.textContent = a.content;
      div.append(small);
      if (a.stars) {
        const stars = document.createElement("strong");
        stars.className = "stars";
        stars.textContent =
          "★".repeat(a.stars) + "☆".repeat(5 - a.stars) + ` (${a.stars}/5)`;
        div.append(stars);
      }
      div.append(text);
      if (a.targetId) {
        const reference = document.createElement("small");
        const target = run.actions.find((t) => t.id === a.targetId);
        reference.textContent = `Referência: ${target?.content.slice(0, 110) || a.targetId}`;
        div.append(reference);
      }
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
  const previousPlatform = $("interview-platform").value;
  $("interview-platform").replaceChildren(
    ...run.config.platforms.map((p) => new Option(platformNames[p] || p, p)),
  );
  if (run.config.platforms.includes(previousPlatform))
    $("interview-platform").value = previousPlatform;
  await loadRuns();
  if (["queued", "running"].includes(run.status))
    timer = setTimeout(() => void poll().catch((e) => notice(e.message)), 1500);
}
$("explore-form").onsubmit = (e) => {
  e.preventDefault();
  void action(e.submitter, async () => {
    const body = {
      question: new FormData(e.target).get("question"),
      platform: $("interview-platform").value,
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
