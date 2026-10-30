/** 草稿存储的类型定义（单独放，避免 Node 单测 import 到 RN 模块）。 */

export interface DraftRecord {
  /** 会话 id：草稿按会话独立保存 */
  sessionId: string;
  /** 未发送文本 */
  text: string;
  /** 最后编辑时间（ms） */
  updatedAt: number;
}

/** 存储适配器：生产用 AsyncStorage，单测注入内存实现 */
export interface DraftStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
