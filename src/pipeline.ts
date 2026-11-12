import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "./store.js";
import { Bridge, LanguageModel } from "./providers.js";
import { nativeRound, interviewNative } from "./native-social.js";
import {
  metrics,
  ontologySchema,
  personaSchema,
  rng,
  isNativePlatform,
  isOasisPlatform,
  type Action,
  type Project,
  type Run,
  type RunConfig,
  type Platform,
} from "./domain.js";

export class Pipeline {
  private queue: string[] = [];
  private active = false;
  private locks = new Set<string>();
  constructor(
    private store: Store,
    private mode: "demo" | "live",
    private llm?: LanguageModel,
    private bridge?: Bridge,
  ) {}
  create(projectId: string, config: RunConfig) {
    const now = new Date().toISOString();
    const run: Run = {
      id: randomUUID(),
      projectId,
      mode: this.mode,
      status: "queued",
      stage: "entrada",
      config,
      createdAt: now,
      updatedAt: now,
      log: [],
      personas: [],
      actions: [],
      llmCalls: 0,
      tokens: 0,
    };
    this.store.saveRun(run);
    this.queue.push(run.id);
    void this.drain();
    return run;
  }
  private async drain() {
    if (this.active) return;
    this.active = true;
    try {
      let id;
      while ((id = this.queue.shift())) await this.execute(id);
    } finally {
      this.active = false;
    }
  }
  private stage(run: Run, stage: Run["stage"], message: string) {
    run.stage = stage;
    run.log.push({ stage, message, at: new Date().toISOString() });
    this.store.saveRun(run);
  }
  async execute(id: string) {
    const run = this.store.run(id);
    if (!run || run.status !== "queued") return;
    let sessionStarted = false;
    try {
      const project = this.store.project(run.projectId)!;
      run.status = "running";
      this.stage(
        run,
        "entrada",
        `${project.documents.length} documento(s). Modo ${run.mode}.`,
      );
      this.stage(run, "ontologia", "Definindo tipos de entidades e relações");
      run.ontology =
        run.mode === "demo"
          ? {
              entityTypes: [
                {
                  name: "Stakeholder",
                  description: "Papel hipotético para demonstração",
                },
              ],
              relationTypes: [
                { name: "INTERACTS_WITH", description: "Interação simulada" },
              ],
            }
          : await this.llm!.structured(
              run,
              "Defina uma ontologia social. JSON: {entityTypes:[{name:PascalCase,description}],relationTypes:[{name:UPPER_SNAKE_CASE,description}]}. Máximo 10 tipos de cada.",
              { scenario: project.scenario, documents: project.documents },
              ontologySchema,
            );
      this.stage(
        run,
        "grafo",
        "Construindo conhecimento por execução; fontes preservadas",
      );
      run.graph =
        run.mode === "demo"
          ? {
              id: run.id,
              origin: "demo",
              nodes: (run.config.platforms.some(isNativePlatform)
                ? [
                    "Empresa",
                    "Cliente frequente",
                    "Cliente sensível ao preço",
                    "Cliente novo",
                  ]
                : ["Cliente", "Empresa", "Jornalista", "Especialista"]
              )
                .slice(0, run.config.maxAgents)
                .map((name, i) => ({
                  id: `demo-${i}`,
                  name: run.config.platforms.some(isNativePlatform)
                    ? i === (run.config.businessAgentId ?? 0)
                      ? "Empresa"
                      : name === "Empresa"
                        ? "Cliente"
                        : name
                    : name,
                  type: "Stakeholder",
                  summary: "Papel hipotético; não extraído dos documentos.",
                })),
              edges: [],
            }
          : await this.bridge!.graph(run.id, run.ontology, project.documents);
      this.stage(
        run,
        "personas",
        "Criando personas a partir dos nós disponíveis",
      );
      for (const node of run.graph.nodes.slice(0, run.config.maxAgents)) {
        const profile =
          run.mode === "demo"
            ? {
                bio: node.summary,
                persona: `Você representa ${node.name}. Perfil sintético demonstrativo.`,
                activityProbability: 0.8,
                activeHours: Array.from({ length: 24 }, (_, i) => i),
              }
            : await this.llm!.structured(
                run,
                "Crie persona hipotética sem inventar fatos biográficos como verdade. JSON: {bio,persona,activityProbability:0..1,activeHours:[0..23]}.",
                {
                  node,
                  scenario: project.scenario,
                  simulationRole: run.config.platforms.some(isNativePlatform)
                    ? run.personas.length === (run.config.businessAgentId ?? 0)
                      ? "Representante da empresa neste experimento hipotético"
                      : "Participante hipotético; não alegue experiência real como cliente"
                    : "Participante da simulação social",
                },
                personaSchema,
              );
        run.personas.push({
          id: run.personas.length,
          name: node.name,
          sourceNodeId: node.id,
          ...profile,
        });
      }
      if (!run.personas.length)
        throw new Error("Grafo sem entidades elegíveis para personas");
      if (run.config.events.some((e) => e.agentId >= run.personas.length))
        throw new Error("Evento referencia persona não criada");
      this.stage(
        run,
        "preparacao",
        "Validando rodadas, horários e eventos agendados",
      );
      if (
        run.config.platforms.some(isNativePlatform) &&
        (run.config.businessAgentId ?? 0) >= run.personas.length
      )
        throw new Error("Agente da empresa não foi criado");
      const oasisPlatforms = run.config.platforms.filter(isOasisPlatform);
      if (run.mode === "live" && oasisPlatforms.length) {
        await this.bridge!.start(run.id, run.personas, {
          ...run.config,
          platforms: oasisPlatforms,
        });
        sessionStarted = true;
      }
      this.stage(run, "simulacao", "Executando rodadas");
      const random = rng(run.config.seed);
      for (let round = 0; round < run.config.rounds; round++) {
        const actions =
          run.mode === "demo"
            ? this.demoRound(run, project, round, random)
            : oasisPlatforms.length
              ? (await this.bridge!.step(run.id, round)).actions
              : [];
        for (const action of actions)
          if (!run.actions.some((a) => a.id === action.id))
            run.actions.push(action);
        for (const platform of run.config.platforms.filter(isNativePlatform)) {
          const native = await nativeRound(
            run,
            project,
            platform,
            round,
            random,
            this.llm,
          );
          for (const action of native)
            if (!run.actions.some((a) => a.id === action.id))
              run.actions.push(action);
          actions.push(...native);
        }
        this.stage(
          run,
          "simulacao",
          `Rodada ${round + 1}/${run.config.rounds}: ${actions.length} ações`,
        );
      }
      this.stage(
        run,
        "memoria",
        run.config.memory
          ? "Registrando atividades simuladas com origem explícita"
          : "Atualização externa de memória desativada",
      );
      if (run.mode === "live" && run.config.memory)
        await this.bridge!.memory(run.graph.id, run.actions);
      this.stage(
        run,
        "relatorio",
        "Consultando resultados e entrevistando personagens",
      );
      const interview =
        run.mode === "live"
          ? isNativePlatform(run.config.platforms[0]!)
            ? await interviewNative(
                run,
                run.config.platforms[0]!,
                0,
                "Qual sua avaliação do cenário e o que influenciou sua reação?",
                this.llm!,
              )
            : await this.bridge!.interview(
                run.id,
                0,
                run.config.platforms[0]!,
                "Qual sua avaliação do cenário e o que influenciou sua reação?",
              )
          : {
              answer:
                "Entrevista demonstrativa: eu precisaria de mais informações para avaliar o cenário.",
            };
      const graphContext =
        run.mode === "live"
          ? await this.bridge!.search(
              run.graph.id,
              project.scenario.slice(0, 350),
            )
          : run.graph;
      run.report =
        run.mode === "demo"
          ? this.demoReport(run, project)
          : await this.llm!.text(
              run,
              "Escreva relatório Markdown com contexto, acontecimentos, diferentes perspectivas, limitações e referências [document:ID] e [action:ID]. Use somente referências existentes. Analise Instagram e avaliações Google separadamente, quando presentes. Use a média das estrelas e a taxa de respostas fornecidas como métricas simuladas, nunca como nota real do Google. Curtidas e comentários não são alcance. Entrevistas são sintéticas. Não invente métricas ou probabilidades. Cite que não é previsão calibrada.",
              {
                scenario: project.scenario,
                documents: project.documents,
                metrics: metrics(run.actions),
                actions: run.actions,
                graphContext,
                interview,
              },
            );
      if (run.mode === "demo") {
        const summary = metrics(run.actions);
        if (run.config.platforms.includes("instagram"))
          run.report += `\n\n## Instagram simulado\n${summary.instagram.posts} publicações, ${summary.instagram.comments} comentários e ${summary.instagram.likes} curtidas sintéticas. Sem previsão de alcance.`;
        if (run.config.platforms.includes("google_reviews"))
          run.report += `\n\n## Avaliações Google simuladas\n${summary.googleReviews.count} avaliações; média ${summary.googleReviews.averageStars ?? "sem avaliações"}/5; ${summary.googleReviews.answered} respondidas e ${summary.googleReviews.unanswered} sem resposta. Essa média pertence apenas à simulação, não ao perfil real da empresa.`;
      }
      run.status = "completed";
      this.stage(
        run,
        "exploracao",
        "Relatório disponível. Instagram/Google usam motor próprio em Node; entrevistas Twitter/Reddit exigem sessão OASIS ativa.",
      );
    } catch (error) {
      run.status = "failed";
      // Do not persist raw provider responses, headers or secrets.
      run.error =
        error instanceof z.ZodError
          ? "Resposta externa não respeitou o contrato de dados."
          : error instanceof Error &&
              /Limite|Evento|Grafo|Bridge|reiniciado/.test(error.message)
            ? error.message
            : "Falha no processamento. Verifique a configuração dos provedores e a disponibilidade da bridge.";
      this.store.saveRun(run);
      if (sessionStarted) await this.bridge!.close(run.id).catch(() => {});
    }
  }
  private demoRound(
    run: Run,
    project: Project,
    round: number,
    random: () => number,
  ) {
    const actions: Action[] = [];
    for (const platform of run.config.platforms) {
      if (isNativePlatform(platform)) continue;
      for (const [i, event] of run.config.events.entries())
        if (event.round === round)
          actions.push({
            id: `${run.id}:${platform}:${round}:event:${i}`,
            round,
            platform,
            agentId: event.agentId,
            type: "CREATE_POST",
            content: event.content,
            origin: "simulation_event",
          });
      for (const agent of run.personas) {
        const hour = Math.floor((round * run.config.minutesPerRound) / 60) % 24;
        if (
          !agent.activeHours.includes(hour) ||
          random() > agent.activityProbability
        )
          continue;
        actions.push({
          id: `${run.id}:${platform}:${round}:${agent.id}`,
          round,
          platform,
          agentId: agent.id,
          type: round % 2 ? "CREATE_COMMENT" : "CREATE_POST",
          content: `[DEMO] ${agent.name}: hipótese sobre “${project.scenario.slice(0, 120)}”. Rodada ${round + 1}; procure evidências reais antes de decidir.`,
          origin: "simulation_event",
        });
      }
    }
    return actions;
  }
  private demoReport(run: Run, project: Project) {
    return `# Relatório demonstrativo\n\nEste modo valida o fluxo do software. Não usa LLM, Zep ou OASIS e não interpreta os documentos.\n\n## Cenário\n${project.scenario}\n\n## Execução\n${run.personas.length} personas hipotéticas, ${run.config.rounds} rodadas e ${run.actions.length} ações sintéticas.\n\n## Fontes recebidas\n${project.documents.map((d) => `- ${d.name} [document:${d.id}]`).join("\n")}\n\n## Limitações\nOs textos são modelos fixos; não representam reações humanas ou previsão. Configure MODE=live para usar os provedores externos.\n\n## Eventos\n${run.actions
      .slice(0, 20)
      .map((a) => `- ${a.content} [action:${a.id}]`)
      .join("\n")}`;
  }
  async explore(
    id: string,
    question: string,
    agentId?: number,
    selectedPlatform?: Platform,
  ) {
    if (this.locks.has(id))
      throw new Error("Já existe uma consulta em andamento nesta execução");
    this.locks.add(id);
    let run: Run | undefined;
    try {
      run = this.store.run(id);
      if (!run || run.status !== "completed")
        throw new Error("Execução concluída necessária");
      if (agentId !== undefined && !run.personas.some((p) => p.id === agentId))
        throw new Error("Agente inexistente");
      const platform = selectedPlatform ?? run.config.platforms[0]!;
      if (!run.config.platforms.includes(platform))
        throw new Error("Ambiente não pertence à execução");
      if (run.mode === "demo")
        return {
          answer: `[DEMO] Consulta recebida${agentId === undefined ? "" : ` para ${run.personas[agentId]!.name}`}. O modo demonstrativo não gera respostas por IA.\n\n${run.report}`,
        };
      const answer =
        agentId === undefined
          ? await this.llm!.text(
              run,
              "Responda sobre o relatório e as evidências. Cite IDs. Explique incertezas.",
              {
                question,
                report: run.report,
                metrics: metrics(run.actions),
                evidence: await this.bridge!.search(
                  run.graph!.id,
                  question.slice(0, 350),
                ),
              },
            )
          : isNativePlatform(platform)
            ? (
                await interviewNative(
                  run,
                  platform,
                  agentId,
                  question,
                  this.llm!,
                )
              ).answer
            : (await this.bridge!.interview(id, agentId, platform, question))
                .answer;
      this.store.saveRun(run);
      return { answer };
    } finally {
      if (run) this.store.saveRun(run);
      this.locks.delete(id);
    }
  }
}
