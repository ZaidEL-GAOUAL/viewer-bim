// L'API du viewer offerte aux agents : les mêmes outils que le chat IA, appelables depuis la page
// (window.viewerBim) et déclarés à WebMCP quand le navigateur le propose. Aucun appel d'IA ici :
// l'agent qui s'en sert apporte son propre modèle. Tout reste dans l'onglet.

import { TOOL_DEFINITIONS, runTool, type ToolContext, type ToolOutcome } from './tools.ts';

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: object;
}

export interface ViewerApi {
  readonly version: 1;
  /** Outils au format MCP : nom, description, schéma JSON des arguments. */
  readonly tools: readonly AgentTool[];
  /** Exécute un outil : `result` pour l'agent, `note` lisible par une personne. */
  call(name: string, args?: Record<string, unknown> | string): ToolOutcome;
}

/** WebMCP : `document.modelContext` (proposition W3C), `navigator.modelContext` dans ses premières versions. */
interface ModelContext {
  registerTool(tool: AgentTool & { execute(args: Record<string, unknown>): Promise<unknown> }): unknown;
}

export function createViewerApi(context: () => ToolContext | null): ViewerApi {
  const tools = TOOL_DEFINITIONS.map(({ function: tool }) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters }));
  return Object.freeze({
    version: 1 as const,
    tools: Object.freeze(tools),
    call(name: string, args: Record<string, unknown> | string = {}): ToolOutcome {
      const current = context();
      if (!current) return { result: { error: 'Aucun modèle chargé dans le viewer.' }, note: 'Aucun modèle chargé' };
      let parsed: unknown = args;
      if (typeof args === 'string') {
        try { parsed = JSON.parse(args); } catch { return { result: { error: 'Arguments JSON illisibles.' }, note: 'Arguments illisibles' }; }
      }
      return runTool(name, parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}, current);
    },
  });
}

/** Déclare chaque outil à WebMCP. Renvoie le nombre d'outils déclarés : 0 si le navigateur ne le propose pas. */
export function registerWebMcp(api: ViewerApi, modelContext: unknown): number {
  const target = modelContext as Partial<ModelContext> | null | undefined;
  if (typeof target?.registerTool !== 'function') return 0;
  let registered = 0;
  for (const tool of api.tools) {
    try {
      const pending = target.registerTool({
        ...tool,
        execute: async (args) => ({ content: [{ type: 'text', text: JSON.stringify(api.call(tool.name, args)) }] }),
      });
      if (pending instanceof Promise) pending.catch(() => {});
      registered++;
    } catch {
      // API expérimentale : une forme différente ne doit pas empêcher le viewer de démarrer.
    }
  }
  return registered;
}
