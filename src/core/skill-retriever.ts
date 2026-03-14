import {inferIntent, retrieveCandidateSkills, type RetrievedSkillCandidate} from "./router.ts";
import type {ConversationState, InstalledSkill, IntentAnalysis, SessionState} from "./types.ts";

export interface SkillRetrieverRequest {
  input: string;
  skills: InstalledSkill[];
  limit?: number;
  intentHint?: IntentAnalysis;
  conversationState?: ConversationState;
  session?: SessionState;
}

export interface SkillRetrieverResult {
  candidates: RetrievedSkillCandidate[];
}

export class SkillRetriever {
  retrieve(request: SkillRetrieverRequest): SkillRetrieverResult {
    const intent = request.intentHint ?? inferIntent(applyConversationStateHint(request.input, request.conversationState));
    return {
      candidates: retrieveCandidateSkills(
        request.input,
        request.skills,
        intent,
        request.limit ?? 8,
      ),
    };
  }
}

function applyConversationStateHint(
  input: string,
  conversationState?: ConversationState,
): string {
  if (!conversationState?.currentSymbol) {
    return input;
  }
  if (!/^(继续|接着|然后|再看|再看看|那.+呢|换成)/.test(input.trim())) {
    return input;
  }
  return `${input} ${conversationState.currentSymbol}`;
}
