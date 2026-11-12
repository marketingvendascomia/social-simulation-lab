# Social Simulation Lab

Laboratório de cenários sociais com **Node.js + TypeScript**, painel em português, ambientes próprios de **Instagram e avaliações Google** e adaptador Python para **Zep Cloud + OASIS (Twitter/Reddit)**. O objetivo é explorar hipóteses e reações possíveis, com rastreabilidade entre documentos e eventos sintéticos.

> **MVP experimental.** O modo demo funciona sem chaves. O caminho live está implementado, mas ainda não foi validado ponta a ponta com Zep Cloud, OASIS e um provedor LLM reais. Não é uma ferramenta de previsão calibrada ou coleta de redes sociais reais.

## Início rápido — sem chaves

Requisito: **Node.js 24+**. Execute os comandos na raiz do projeto:

```sh
npm ci
npm run build
npm start
```

Abra **http://127.0.0.1:3100**. Crie um projeto com material de referência e execute um cenário. O padrão é `MODE=demo`: personas hipotéticas, textos fixos e seleção reproduzível por seed. Nenhum documento é enviado a serviços externos nesse modo. O demo verifica o fluxo do software e não interpreta o conteúdo dos documentos.

Para desenvolvimento: `npm run dev`. Para verificar: `npm run check`.

**PowerShell no Windows:** use `npm.cmd` no lugar de `npm`, caso scripts `.ps1` estejam bloqueados. Antes de reinstalar dependências com `npm.cmd ci`, encerre o servidor com **Ctrl+C** para liberar bibliotecas nativas carregadas pelo processo.

## Instagram e avaliações do Google

No painel, escolha **Instagram simulado**, **Avaliações do Google simuladas** ou **Instagram + avaliações do Google**. Para começar, use quatro agentes, cinco rodadas e ID da empresa **0**. Twitter e Reddit continuam disponíveis.

| Ambiente                    | Ações e regras                                                                                                        | Métricas simuladas                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Instagram                   | Publicações textuais, comentários vinculados a posts e uma curtida por agente/post                                    | Quantidades de posts, comentários e curtidas                            |
| Perfil da Empresa no Google | Clientes dão de 1 a 5 estrelas; uma avaliação por cliente no MVP; somente a empresa responde uma vez a cada avaliação | Média das estrelas, distribuição, avaliações respondidas e sem resposta |

Os novos ambientes usam **um motor próprio em TypeScript, não OASIS**. No demo as decisões seguem regras e textos fixos; no live o LLM escolhe ações em JSON e o servidor valida permissões, referências e duplicatas. Cada agente decide a partir de um estado comum no início da rodada, após os eventos agendados. Atividade e horários continuam sendo respeitados. Todas as ações são locais à execução.

- O ID da empresa é configurável. Confira os nomes em **Grafo e personas**; nos novos ambientes demo o agente configurado é identificado como Empresa.
- Instagram recebe uma publicação inicial com o cenário quando não há post ou evento inicial. Um evento agendado vira publicação no Instagram e **comunicado de contexto**, sem estrelas, no ambiente Google.
- Avaliações Google não são comentários em feed: clientes não respondem uns aos outros nem a empresa avalia a si própria. A média considera somente avaliações sintéticas, excluindo respostas e comunicados. Não inclui avaliações históricas reais.
- A timeline mostra as estrelas e a referência de comentários, curtidas e respostas. O relatório separa as métricas das plataformas.
- Na exploração, selecione o **ambiente da entrevista**. Entrevistas Instagram/Google usam persona e histórico público salvo, sem depender de uma sessão OASIS. O live continua exigindo a bridge para o grafo Zep.
- Não há conexão às contas reais, coleta de avaliações, publicação no Google/Instagram, imagens, vídeos, Reels ou reprodução dos algoritmos proprietários. Essas métricas não são previsões de alcance, vendas ou da nota real de uma empresa.

Exemplo de API:

```json
{
  "rounds": 5,
  "maxAgents": 4,
  "platforms": ["instagram", "google_reviews"],
  "businessAgentId": 0,
  "seed": 42,
  "events": [
    {
      "round": 0,
      "agentId": 0,
      "content": "A empresa esclarece as condições da nova oferta."
    }
  ]
}
```

## Fluxo implementado

| Etapa      | Demo                                        | Live                                                       |
| ---------- | ------------------------------------------- | ---------------------------------------------------------- |
| Entrada    | Texto e upload PDF/TXT/Markdown             | Mesma extração local                                       |
| Ontologia  | Tipos fixos identificados como demonstração | LLM gera JSON validado                                     |
| Grafo      | Nós hipotéticos locais                      | Bridge aplica ontologia e ingere documentos no Zep         |
| Personas   | Papéis sintéticos fixos                     | LLM gera personas a partir dos nós retornados pelo Zep     |
| Preparação | Limites, horários e eventos                 | Mesmos contratos enviados ao OASIS                         |
| Simulação  | Textos fixos e regras por ambiente          | Motor Node Instagram/Google ou OASIS Twitter/Reddit        |
| Memória    | Eventos persistidos no SQLite               | Atividades enviadas ao Zep, se habilitado                  |
| Relatório  | Resumo demonstrativo                        | Consulta do grafo, entrevista do agente e síntese pelo LLM |
| Exploração | Resposta explicitamente demonstrativa       | Perguntas sobre relatório ou entrevistas com agentes       |

Cada execução recebe um grafo separado. Documentos têm origem `source_document`; atividades têm origem `simulation_event`. Personas são hipóteses, mesmo quando baseadas em uma entidade real. O grafo exibido no painel é o inventário inicial; a timeline contém as ações subsequentes.

## Arquitetura

```text
Painel HTML/JS (mesma origem; sem HTML gerado por IA)
                    |
             Fastify / TypeScript
              |        |        |
           SQLite     LLM    HTTP bridge autenticada
                                 |
                          Python / FastAPI
                            |           |
                        Zep Cloud    CAMEL OASIS
```

- API Node: coordenação, extração PDF, validação, fila serial, persistência, geração e exploração de relatórios.
- Motor Node (`src/native-social.ts`): ações, referências e permissões de Instagram/avaliações Google. O LLM propõe decisões; validação e cálculo das métricas são feitos pelo servidor.
- SQLite: projetos, configurações, etapas, métricas e resultados; sem Redis/PostgreSQL neste MVP.
- Bridge Python: ontologia/ingestão/paginação do Zep, ambientes OASIS e entrevistas.
- OASIS: cada rodada respeita probabilidade/horário de atividade e publica eventos agendados antes das decisões. Os dois ambientes são processados sequencialmente, sem sincronização de conteúdo entre plataformas.
- O relatório usa uma sequência explícita de busca + entrevista + síntese; não há ainda um planejador autônomo de ferramentas.

## Modo live

Requisitos adicionais: **Python 3.11 ou 3.12**, acesso ao Zep Cloud e um endpoint LLM compatível com Chat Completions e JSON mode. A compatibilidade de outros provedores com CAMEL/OASIS precisa ser verificada.

Copie `.env.example` para `.env` e configure:

```dotenv
MODE=live
API_KEY=defina-um-segredo-longo
OPENAI_API_KEY=sua-chave
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
ZEP_API_KEY=sua-chave-zep
BRIDGE_TOKEN=outro-segredo-longo-igual-nos-dois-processos
BRIDGE_URL=http://127.0.0.1:8100
```

Não publique o `.env`. Ele já está no `.gitignore`.

Instale a bridge na raiz do projeto:

```sh
python -m venv .venv
# Linux/macOS:
.venv/bin/python -m pip install -r bridge/requirements.txt
.venv/bin/python -m uvicorn bridge.app:app --host 127.0.0.1 --port 8100 --workers 1
```

No Windows, use `.venv\Scripts\python.exe` no lugar de `.venv/bin/python`. Em outro terminal:

```sh
npm run build
npm start
```

Informe `API_KEY` em **Chave de acesso** no painel. O Node usa `BRIDGE_TOKEN` para falar com a bridge; não exponha esse segredo no navegador.

### Ciclo de vida e custos

- O Node processa uma execução por vez, com até cinco pendentes. A bridge mantém no máximo três ambientes; encerre os antigos pelo painel.
- Ambientes permanecem abertos após o relatório para permitir entrevistas. Reiniciar a bridge perde esses ambientes; resultados já salvos continuam disponíveis, mas entrevistas exigem nova execução.
- Etapas externas **não são repetidas automaticamente** após falhas. Um reinício marca trabalhos pendentes como `interrupted`, evitando reenvio silencioso de operações cobradas.
- São aceitos até 20 agentes, 20 rodadas, duas plataformas e 10 eventos. O caminho live limita a configuração a 400 ativações potenciais. Eventos devem apontar para personas realmente criadas.
- `MAX_LLM_CALLS` limita somente as chamadas feitas pelo Node. **Não é um teto financeiro global**: OASIS e Zep têm consumo próprio. Defina limites também nas contas dos provedores.
- O painel mostra tokens e chamadas do Node; não inclui tokens internos do OASIS nem ingestão do Zep.
- Personas recebem até 24 horas de atividade. A seed reproduz a seleção dos agentes; respostas LLM e execução interna do OASIS não são determinísticas.
- PDFs escaneados exigem OCR externo. Limites: 8 MB por arquivo, oito documentos e 250 mil caracteres por projeto. TXT/Markdown são tratados como UTF-8.

## API

Todas as rotas `/api/*` usam `Authorization: Bearer API_KEY` quando configurada.

| Método | Rota                          | Uso                                                      |
| ------ | ----------------------------- | -------------------------------------------------------- |
| GET    | `/health`                     | Saúde e modo                                             |
| GET    | `/api/status`                 | Configuração funcional                                   |
| POST   | `/api/projects`               | `{name, scenario, text}`                                 |
| GET    | `/api/projects`               | Projetos sem o corpo dos documentos                      |
| POST   | `/api/projects/:id/documents` | Multipart com um arquivo                                 |
| POST   | `/api/projects/:id/runs`      | Iniciar execução                                         |
| GET    | `/api/runs`                   | Listar execuções                                         |
| GET    | `/api/runs/:id`               | Estado, grafo, personas, ações e relatório               |
| POST   | `/api/runs/:id/explore`       | `{question, agentId?}`; sem agentId consulta o relatório |
| POST   | `/api/runs/:id/close`         | Encerrar ambientes OASIS                                 |

Exemplo de configuração:

```json
{
  "rounds": 5,
  "maxAgents": 4,
  "platforms": ["twitter", "reddit"],
  "minutesPerRound": 60,
  "seed": 42,
  "memory": true,
  "events": [
    {
      "round": 2,
      "agentId": 0,
      "content": "Comunicado adicional da organização."
    }
  ]
}
```

Rodadas e agentes usam índice inicial **zero** na API. As telas mostram rodadas a partir de um.

## Validação

```sh
npm run check
python -m unittest bridge.test_core
python -m compileall -q bridge
```

A suíte Node cobre o fluxo de nove etapas, eventos, referências, persistência, chave de acesso, uploads, recuperação após reinício e contratos live com provedores substituídos por doubles. Os testes Python cobrem horários, seleção por seed, eventos e preservação de texto. O CI executa os testes em Node 24 e Python 3.11.

**Limite da validação inicial:** testes Node executados localmente; integração com provedores reais não executada. Não há evidência de precisão preditiva. Os testes de contrato não substituem o teste ponta a ponta com as versões fixadas de OASIS/Zep.

## Segurança e próximas etapas

O servidor usa loopback por padrão e exige API key ao escutar fora dele. Inclui validação de dados, limites de upload/requisições, CSP e apresentação dos textos por `textContent`. Não há autenticação individual nem isolamento de clientes: a chave dá acesso a todos os projetos da instância. Não publique a instância como SaaS multiusuário sem implementar usuários, permissões, TLS e isolamento.

Outras evoluções: PostgreSQL e fila distribuída, cancelamento de execução, orçamento global, inventário atualizado do grafo, visualização interativa de relações, comparação de cenários, métricas de propagação, avaliação com dados históricos e cobertura live do adaptador. A aplicação não possui conectores de coleta de Twitter/Reddit reais.

## Referências e autoria

Projeto novo escrito para este laboratório, inspirado no fluxo público do [MiroFish](https://github.com/666ghj/MiroFish). Não inclui código copiado daquele repositório. O motor externo é o [CAMEL-AI OASIS](https://github.com/camel-ai/oasis), com sua própria licença; o Zep é um serviço externo. O código original deste repositório ainda não tem licença de distribuição definida.
