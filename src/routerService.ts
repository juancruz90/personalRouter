import { AssignmentView, AssignmentsService } from './assignmentsService';

type CandidateClass = 'primary' | 'fallback' | 'excluded';

export interface RouterCandidate {
  assignmentId: number;
  accountId: number;
  provider: string;
  accountExternalId: string;
  profileId: string;
  priority: number;
  mode: string;
  healthScore: number;
  status: string;
  locked: boolean;
  expiresAt: string | null;
  class: CandidateClass;
  reason?: string;
}

export interface RouterSelection {
  ok: boolean;
  agentSlug: string;
  provider?: string;
  selected: RouterCandidate | null;
  failoverApplied: boolean;
  reason?: string;
  candidates: RouterCandidate[];
}

const ACTIVE_RANK: Record<string, number> = {
  active: 0,
  degraded: 1,
  failover: 2,
};

function candidateFromAssignment(assignment: AssignmentView): RouterCandidate {
  const status = assignment.account.status;
  const allowed = status === 'active' || status === 'degraded' || status === 'failover';

  return {
    assignmentId: assignment.id,
    accountId: assignment.accountId,
    provider: assignment.account.provider,
    accountExternalId: assignment.account.accountId,
    profileId: assignment.account.profileId,
    priority: assignment.priority,
    mode: assignment.mode,
    healthScore: assignment.account.healthScore,
    status,
    locked: assignment.account.locked,
    expiresAt: assignment.account.expiresAt,
    class: allowed ? (status === 'active' ? 'primary' : 'fallback') : 'excluded',
    reason: allowed ? undefined : `status:${status}`,
  };
}

function compareCandidate(a: RouterCandidate, b: RouterCandidate): number {
  if (a.priority !== b.priority) {
    return a.priority - b.priority;
  }

  const statusRankA = ACTIVE_RANK[a.status] ?? 99;
  const statusRankB = ACTIVE_RANK[b.status] ?? 99;
  if (statusRankA !== statusRankB) {
    return statusRankA - statusRankB;
  }

  if (a.healthScore !== b.healthScore) {
    return b.healthScore - a.healthScore;
  }

  return a.assignmentId - b.assignmentId;
}

export class RouterService {
  constructor(private readonly assignments: AssignmentsService) {}

  async select(agentSlug: string, provider?: string): Promise<RouterSelection> {
    const items = await this.assignments.list({ agentSlug, provider });

    if (!items.length) {
      return {
        ok: false,
        agentSlug,
        provider,
        selected: null,
        failoverApplied: false,
        reason: 'no_assignments',
        candidates: [],
      };
    }

    const candidates = items.map(candidateFromAssignment);
    const eligible = candidates
      .filter((candidate) => candidate.class !== 'excluded')
      .sort(compareCandidate);

    if (!eligible.length) {
      return {
        ok: false,
        agentSlug,
        provider,
        selected: null,
        failoverApplied: false,
        reason: 'no_eligible_accounts',
        candidates,
      };
    }

    const selected = eligible[0];

    return {
      ok: true,
      agentSlug,
      provider,
      selected,
      failoverApplied: selected.status !== 'active',
      candidates,
    };
  }
}
