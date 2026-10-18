/**
 * 模型目录与切换。
 *
 * session/modelCatalog 无参数，返回：
 *   { default: {provider, model, reasoningEffort?},
 *     routableProviders: string[],
 *     groups: [{ id, name, models: [{ id, name, description?, reasoning? }] }] }
 *
 * `reasoning` 是思考强度档位：
 *   { efforts: [{id, name, description?}], defaultEffort? }
 * 各模型的档位不一样（DeepSeek：off/low/high/max；GPT-6-Luna：low/medium/high/xhigh），
 * 所以 UI 必须按当前模型动态渲染，不能写死。
 *
 * session/selectModel 需要 { sessionId, provider, model, reasoningEffort? }
 */

import type { DshConnection } from '../transport';

export interface ReasoningEffort {
  id: string;
  name: string;
  description?: string;
}

export interface ModelReasoning {
  efforts: ReasoningEffort[];
  defaultEffort?: string;
}

export interface CatalogModel {
  id: string;
  name: string;
  description?: string;
  reasoning?: ModelReasoning | null;
}

export interface CatalogGroup {
  id: string;
  name: string;
  models: CatalogModel[];
}

export interface ModelCatalog {
  default: { provider: string; model: string; reasoningEffort?: string };
  routableProviders: string[];
  groups: CatalogGroup[];
}

export interface SelectedModel {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export class ModelApi {
  constructor(private readonly conn: DshConnection) {}

  /** 拉取可用模型目录 */
  async catalog(): Promise<ModelCatalog> {
    const res = await this.conn.call<ModelCatalog>('session/modelCatalog', {});
    return {
      default: res?.default ?? { provider: '', model: '' },
      routableProviders: res?.routableProviders ?? [],
      groups: res?.groups ?? [],
    };
  }

  /** 切换会话模型 */
  async select(sessionId: string, selected: SelectedModel): Promise<SelectedModel> {
    const request: Record<string, unknown> = {
      sessionId,
      provider: selected.provider,
      model: selected.model,
    };
    if (selected.reasoningEffort) request.reasoningEffort = selected.reasoningEffort;
    const res = await this.conn.call<{ selected: SelectedModel }>('session/selectModel', {
      request,
    });
    return res?.selected ?? selected;
  }
}

/** 在拍平列表里找当前模型（provider + model 匹配） */
export function findCatalogModel(
  flat: ReturnType<typeof flattenCatalog>,
  provider?: string | null,
  model?: string | null,
): CatalogModel | undefined {
  if (!model) return undefined;
  return flat.find((it) => it.model.id === model && (!provider || it.provider === provider))?.model;
}

/** 把目录拍平成可搜索的列表 */
export function flattenCatalog(catalog: ModelCatalog): Array<{
  provider: string;
  model: CatalogModel;
  groupName: string;
}> {
  const out: Array<{ provider: string; model: CatalogModel; groupName: string }> = [];
  for (const g of catalog.groups) {
    for (const m of g.models) {
      out.push({ provider: g.id, model: m, groupName: g.name });
    }
  }
  return out;
}
