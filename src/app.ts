import Fastify from "fastify";
import multipart from "@fastify/multipart";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { PDFParse } from "pdf-parse";
import { Store } from "./store.js";
import { Pipeline } from "./pipeline.js";
import { Bridge, LanguageModel } from "./providers.js";
import { metrics, runConfig, type Project } from "./domain.js";

export interface Settings {
  mode: "demo" | "live";
  dataDir: string;
  apiKey?: string;
  openaiKey?: string;
  openaiURL?: string;
  model?: string;
  bridgeURL?: string;
  bridgeToken?: string;
  maxCalls?: number;
  staticDir?: string;
}
export async function createApp(settings: Settings) {
  if (
    settings.mode === "live" &&
    (!settings.openaiKey || !settings.bridgeToken)
  )
    throw new Error("MODE=live exige OPENAI_API_KEY e BRIDGE_TOKEN");
  mkdirSync(settings.dataDir, { recursive: true });
  const store = new Store(resolve(settings.dataDir, "lab.sqlite"));
  const bridge =
    settings.mode === "live"
      ? new Bridge(
          settings.bridgeURL ?? "http://127.0.0.1:8100",
          settings.bridgeToken!,
        )
      : undefined;
  const llm =
    settings.mode === "live"
      ? new LanguageModel(
          settings.model ?? "gpt-4o-mini",
          settings.openaiKey!,
          settings.openaiURL ?? "https://api.openai.com/v1",
          settings.maxCalls ?? 200,
        )
      : undefined;
  const pipeline = new Pipeline(store, settings.mode, llm, bridge);
  const app = Fastify({ bodyLimit: 1024 * 1024, logger: false });
  await app.register(helmet);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await app.register(multipart, {
    limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 3 },
  });
  app.addHook("onRequest", async (request, reply) => {
    if (!request.routeOptions.url?.startsWith("/api/") || !settings.apiKey)
      return;
    const header = request.headers.authorization ?? "";
    const expected = `Bearer ${settings.apiKey}`;
    if (
      Buffer.byteLength(header) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(header), Buffer.from(expected))
    )
      return reply.code(401).send({ error: "Chave de acesso inválida" });
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({
          error: "Dados inválidos",
          issues: error.issues.map((i) => ({
            path: i.path,
            message: i.message,
          })),
        });
    if (
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode < 500
    )
      return reply.code(error.statusCode).send({ error: error.message });
    return reply
      .code(500)
      .send({
        error: "Erro interno. Verifique a configuração e os serviços externos.",
      });
  });
  await app.register(staticFiles, {
    root: settings.staticDir ?? resolve("public"),
    prefix: "/",
  });
  app.get("/health", () => ({ status: "ok", mode: settings.mode }));
  app.get("/api/status", () => ({
    mode: settings.mode,
    liveConfigured: !!llm,
    features: {
      documents: true,
      ontology: true,
      graph: true,
      personas: true,
      scheduledEvents: true,
      simulation: true,
      memory: true,
      report: true,
      exploration: true,
    },
    storage: "sqlite-single-process",
  }));
  app.get("/api/projects", () =>
    store
      .projects()
      .map(({ documents, ...project }) => ({
        ...project,
        documents: documents.map(({ text, ...d }) => ({
          ...d,
          characters: text.length,
        })),
      })),
  );
  app.post("/api/projects", async (request, reply) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(120),
        scenario: z.string().trim().min(10).max(5000),
        text: z.string().trim().min(10).max(250_000),
      })
      .parse(request.body);
    const project: Project = {
      id: randomUUID(),
      name: body.name,
      scenario: body.scenario,
      documents: [{ id: randomUUID(), name: "contexto.txt", text: body.text }],
      createdAt: new Date().toISOString(),
    };
    store.saveProject(project);
    return reply.code(201).send(project);
  });
  app.post("/api/projects/:id/documents", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = store.project(id);
    if (!project)
      return reply.code(404).send({ error: "Projeto não encontrado" });
    if (project.documents.length >= 8)
      return reply.code(400).send({ error: "Limite de 8 documentos" });
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "Arquivo obrigatório" });
    const extension = file.filename.split(".").pop()?.toLowerCase();
    if (!["pdf", "txt", "md", "markdown"].includes(extension ?? "")) {
      await file.toBuffer();
      return reply.code(400).send({ error: "Use PDF, TXT ou Markdown" });
    }
    const buffer = await file.toBuffer();
    let text: string;
    if (extension === "pdf") {
      const parser = new PDFParse({ data: buffer });
      try {
        text = (await parser.getText()).text;
      } finally {
        await parser.destroy();
      }
    } else text = buffer.toString("utf8");
    if (text.trim().length < 10)
      return reply
        .code(400)
        .send({
          error: "Texto insuficiente; PDF escaneado pode exigir OCR externo",
        });
    if (
      project.documents.reduce((n, d) => n + d.text.length, 0) + text.length >
      250_000
    )
      return reply
        .code(400)
        .send({ error: "Limite de 250 mil caracteres por projeto" });
    project.documents.push({
      id: randomUUID(),
      name: file.filename.replace(/[\x00-\x1f]/g, "").slice(0, 180),
      text,
    });
    store.saveProject(project);
    return reply
      .code(201)
      .send({
        documents: project.documents.map(({ text, ...d }) => ({
          ...d,
          characters: text.length,
        })),
      });
  });
  app.post("/api/projects/:id/runs", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.project(id))
      return reply.code(404).send({ error: "Projeto não encontrado" });
    if (
      store
        .runs()
        .filter((r) => r.status === "running" || r.status === "queued")
        .length >= 5
    )
      return reply
        .code(429)
        .send({ error: "Fila cheia; aguarde uma execução terminar" });
    const config = runConfig.parse(request.body ?? {});
    if (
      settings.mode === "live" &&
      config.maxAgents * config.rounds * config.platforms.length > 400
    )
      return reply
        .code(400)
        .send({
          error:
            "Reduza agentes, rodadas ou plataformas: limite de 400 ativações potenciais",
        });
    const run = pipeline.create(id, config);
    return reply.code(202).send(run);
  });
  app.get("/api/runs", () =>
    store
      .runs()
      .map(({ actions, report, graph, ...run }) => ({
        ...run,
        metrics: metrics(actions),
      })),
  );
  app.get("/api/runs/:id", async (request, reply) => {
    const run = store.run((request.params as { id: string }).id);
    return run
      ? { ...run, metrics: metrics(run.actions) }
      : reply.code(404).send({ error: "Execução não encontrada" });
  });
  app.post("/api/runs/:id/explore", async (request, reply) => {
    const body = z
      .object({
        question: z.string().trim().min(3).max(2000),
        agentId: z.number().int().min(0).optional(),
      })
      .parse(request.body);
    const id = (request.params as { id: string }).id;
    if (!store.run(id))
      return reply.code(404).send({ error: "Execução não encontrada" });
    try {
      return await pipeline.explore(id, body.question, body.agentId);
    } catch {
      return reply
        .code(409)
        .send({
          error:
            "Consulta indisponível. Verifique conclusão, agente, limite LLM e sessão OASIS ativa.",
        });
    }
  });
  app.post("/api/runs/:id/close", async (request, reply) => {
    const run = store.run((request.params as { id: string }).id);
    if (!run) return reply.code(404).send({ error: "Execução não encontrada" });
    if (
      run.status !== "completed" &&
      run.status !== "failed" &&
      run.status !== "interrupted"
    )
      return reply.code(409).send({ error: "Aguarde a execução terminar" });
    if (run.mode === "live") await bridge!.close(run.id);
    return { closed: true };
  });
  app.addHook("onClose", async () => store.close());
  return { app, store, pipeline };
}
