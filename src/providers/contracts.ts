export interface XCandidate {
  candidateRef: string;
  text: string;
  authorUsername?: string;
  authorName?: string;
  createdAt?: string;
  metrics: {
    likes?: number;
    replies?: number;
    reposts?: number;
    quotes?: number;
    views?: number;
  };
}

export interface ResolvedXCandidate extends XCandidate {
  postId: string;
  canonicalUrl: string;
}

export interface PublishResult {
  confirmed: boolean;
  /** Zernio's internal post record, used to poll non-terminal publishes. */
  providerRecordId?: string;
  providerPostId?: string;
  providerPostUrl?: string;
  providerStatus: string;
  message: string;
}

export interface MemoryContext {
  static: string[];
  dynamic: string[];
  relevant: string[];
}
