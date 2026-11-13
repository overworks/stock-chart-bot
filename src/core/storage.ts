export interface SymbolEntry {
  key: string;
  value: string;
  /** 검색에만 쓰고 표시명으로는 쓰지 않는 별칭 */
  alias?: boolean;
}

export interface MutationIdentity {
  key: string;
  /** epoch 밀리초 */
  expiresAt: number;
}

export interface AliasMutation {
  key: string;
  value?: string;
  request?: MutationIdentity;
}

export interface SymbolReader {
  readSeed(): Promise<SymbolEntry[]>;
  readAliases(): Promise<SymbolEntry[]>;
}

export interface SymbolStore extends SymbolReader {
  mutateAlias(mutation: AliasMutation): Promise<SymbolEntry>;
}

export interface CachedToken {
  token: string;
  /** epoch 초 */
  expiresAt: number;
}

export interface TokenCache {
  get(): Promise<CachedToken | null>;
  put(token: CachedToken, ttlSeconds: number): Promise<void>;
}
