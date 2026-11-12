import { z } from "zod";
import type { Action, Persona, Project, Run } from "./domain.js";
import type { LanguageModel } from "./providers.js";

export type NativePlatform = "instagram" | "google_reviews";
export const decisionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("CREATE_POST"),
      content: z.string().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      type: z.literal("CREATE_COMMENT"),
      targetId: z.string().min(1),
      content: z.string().min(1).max(2000),
    })
    .strict(),
  z
    .object({ type: z.literal("LIKE_POST"), targetId: z.string().min(1) })
    .strict(),
  z
    .object({
      type: z.literal("CREATE_REVIEW"),
      stars: z.number().int().min(1).max(5),
      content: z.string().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      type: z.literal("REPLY_REVIEW"),
      targetId: z.string().min(1),
      content: z.string().min(1).max(2000),
    })
    .strict(),
  z.object({ type: z.literal("WAIT") }).strict(),
]);
export type SocialDecision = z.infer<typeof decisionSchema>;

/** Apply server-side permissions and references; the model cannot mutate state. */
export function validateDecision(
  run: Run,
  platform: NativePlatform,
  agent: Persona,
  round: number,
  input: unknown,
  visible: Action[],
): Action | undefined {
  const decision = decisionSchema.parse(input);
  if (decision.type === "WAIT") return;
  const history = visible.filter((a) => a.platform === platform);
  const business = run.config.businessAgentId ?? 0;
  const target =
    "targetId" in decision
      ? history.find((a) => a.id === decision.targetId)
      : undefined;
  if (platform === "google_reviews") {
    if (decision.type === "CREATE_REVIEW") {
      if (
        agent.id === business ||
        history.some(
          (a) => a.type === "CREATE_REVIEW" && a.agentId === agent.id,
        )
      )
        throw new Error("Avaliação duplicada ou criada pela empresa");
    } else if (decision.type === "REPLY_REVIEW") {
      if (
        agent.id !== business ||
        target?.type !== "CREATE_REVIEW" ||
        history.some(
          (a) => a.type === "REPLY_REVIEW" && a.targetId === target.id,
        )
      )
        throw new Error("Resposta inválida à avaliação");
    } else throw new Error("Ação não permitida no ambiente de avaliações");
  } else {
    if (!["CREATE_POST", "CREATE_COMMENT", "LIKE_POST"].includes(decision.type))
      throw new Error("Ação não permitida no Instagram");
    if (decision.type === "CREATE_COMMENT" || decision.type === "LIKE_POST") {
      if (target?.type !== "CREATE_POST")
        throw new Error("Publicação alvo inexistente neste ambiente");
      if (
        decision.type === "LIKE_POST" &&
        history.some(
          (a) =>
            a.type === "LIKE_POST" &&
            a.agentId === agent.id &&
            a.targetId === target.id,
        )
      )
        throw new Error("Curtida duplicada");
    }
  }
  return {
    id: `${run.id}:${platform}:${round}:${agent.id}`,
    round,
    platform,
    agentId: agent.id,
    type: decision.type,
    content: "content" in decision ? decision.content : "Curtiu a publicação",
    ...("targetId" in decision ? { targetId: decision.targetId } : {}),
    ...("stars" in decision ? { stars: decision.stars } : {}),
    origin: "simulation_event",
  };
}

function demoDecision(
  run: Run,
  platform: NativePlatform,
  agent: Persona,
  round: number,
  visible: Action[],
): SocialDecision {
  const history = visible.filter((a) => a.platform === platform);
  const business = run.config.businessAgentId ?? 0;
  if (platform === "google_reviews") {
    if (agent.id === business) {
      const review = history.find(
        (a) =>
          a.type === "CREATE_REVIEW" &&
          !history.some(
            (r) => r.type === "REPLY_REVIEW" && r.targetId === a.id,
          ),
      );
      return review
        ? {
            type: "REPLY_REVIEW",
            targetId: review.id,
            content:
              "[DEMO] Obrigado pelo relato. Vamos esclarecer as condições e encaminhar sua dúvida ao atendimento.",
          }
        : { type: "WAIT" };
    }
    if (
      history.some((a) => a.type === "CREATE_REVIEW" && a.agentId === agent.id)
    )
      return { type: "WAIT" };
    const stars = 1 + ((agent.id + run.config.seed) % 5);
    return {
      type: "CREATE_REVIEW",
      stars,
      content: `[DEMO] Avaliação hipotética de ${agent.name}: ${stars}/5. A clareza das condições e o atendimento influenciam minha percepção. Não é relato de visita real.`,
    };
  }
  const post = history.filter((a) => a.type === "CREATE_POST").at(-1);
  if (!post) return { type: "WAIT" };
  if (agent.id === business)
    return round % 2
      ? {
          type: "CREATE_COMMENT",
          targetId: post.id,
          content:
            "[DEMO] Equipe da empresa: podemos esclarecer as condições nos comentários.",
        }
      : { type: "WAIT" };
  if (
    round % 2 &&
    !history.some(
      (a) =>
        a.type === "LIKE_POST" &&
        a.targetId === post.id &&
        a.agentId === agent.id,
    )
  )
    return { type: "LIKE_POST", targetId: post.id };
  return {
    type: "CREATE_COMMENT",
    targetId: post.id,
    content: `[DEMO] ${agent.name}: tenho dúvidas sobre as condições e gostaria de mais informações antes de decidir.`,
  };
}

export async function nativeRound(
  run: Run,
  project: Project,
  platform: NativePlatform,
  round: number,
  random: () => number,
  llm?: LanguageModel,
): Promise<Action[]> {
  const history = run.actions.filter((a) => a.platform === platform);
  const seeds: Action[] = run.config.events.flatMap((event, index) =>
    event.round !== round
      ? []
      : [
          {
            id: `${run.id}:${platform}:${round}:event:${index}`,
            round,
            platform,
            agentId: event.agentId,
            type:
              platform === "google_reviews" ? "ANNOUNCEMENT" : "CREATE_POST",
            content: event.content,
            origin: "simulation_event" as const,
          },
        ],
  );
  if (
    platform === "instagram" &&
    !history.some((a) => a.type === "CREATE_POST") &&
    !seeds.some((a) => a.type === "CREATE_POST")
  ) {
    seeds.push({
      id: `${run.id}:instagram:seed`,
      round,
      platform,
      agentId: run.config.businessAgentId ?? 0,
      type: "CREATE_POST",
      content: `[Cenário para discussão] ${project.scenario}`,
      origin: "simulation_event",
    });
  }
  // Agents see the same round-start state; earlier completions do not gain influence.
  const visible = [...history, ...seeds];
  const results = [...seeds];
  const hour = Math.floor((round * run.config.minutesPerRound) / 60) % 24;
  for (const agent of run.personas) {
    if (
      !agent.activeHours.includes(hour) ||
      random() > agent.activityProbability
    )
      continue;
    const context = {
      scenario: project.scenario,
      agent,
      businessAgentId: run.config.businessAgentId ?? 0,
      round,
      platform,
      visibleActions: visible.slice(-60),
    };
    const instruction =
      platform === "google_reviews"
        ? "Simulação de avaliações do Perfil da Empresa no Google. Não há feed de posts nem comentários entre clientes. Só clientes podem CREATE_REVIEW com stars inteiro de 1 a 5 e content, uma avaliação por agente. Só businessAgentId pode REPLY_REVIEW com targetId de uma avaliação sem resposta e content. ANNOUNCEMENT é contexto, não avaliação. Se não houver ação válida, WAIT. Nunca alegue uma experiência real."
        : "Simulação textual de Instagram. CREATE_POST exige content (legenda, sem imagem gerada). CREATE_COMMENT exige targetId de uma CREATE_POST visível e content. LIKE_POST exige targetId de publicação visível ainda não curtida por você. WAIT se preferir. Não simule alcance real nem o algoritmo proprietário.";
    const decision =
      run.mode === "demo"
        ? demoDecision(run, platform, agent, round, visible)
        : await llm!.structured(
            run,
            instruction +
              " Escolha uma única ação em JSON {type,...}. WAIT só contém type. Respeite seu papel e persona. Tudo aqui é hipotético, nunca publique em redes reais.",
            context,
            decisionSchema,
          );
    const action = validateDecision(
      run,
      platform,
      agent,
      round,
      decision,
      visible,
    );
    if (action) results.push(action);
  }
  return results;
}

export async function interviewNative(
  run: Run,
  platform: NativePlatform,
  agentId: number,
  question: string,
  llm: LanguageModel,
) {
  const agent = run.personas.find((p) => p.id === agentId);
  if (!agent) throw new Error("Agente inexistente");
  return {
    answer: await llm.text(
      run,
      "Responda como personagem sintético desta simulação, com base em sua persona e nas ações públicas disponíveis. Não alegue ser pessoa real nem ter visitado uma empresa. Não invente eventos ou experiência além deste contexto.",
      {
        question,
        agent,
        platform,
        businessAgentId: run.config.businessAgentId ?? 0,
        publicActions: run.actions
          .filter((a) => a.platform === platform)
          .slice(-60),
      },
    ),
  };
}
