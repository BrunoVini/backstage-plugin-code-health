/**
 * Shapes of the GitHub GraphQL and REST responses this plugin reads, narrowed
 * to the fields it uses.
 */

export interface GithubRateLimitNode {
  readonly cost?: number;
  readonly limit?: number;
  readonly remaining?: number;
  readonly resetAt?: string;
}

export interface GithubActorNode {
  readonly login?: string;
  readonly avatarUrl?: string;
  readonly url?: string;
}

export interface GithubCommitNode {
  readonly oid?: string;
  readonly messageHeadline?: string;
  readonly committedDate?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changedFilesIfAvailable?: number;
  readonly url?: string;
  readonly author?: {
    readonly name?: string;
    readonly email?: string;
    readonly avatarUrl?: string;
    readonly user?: GithubActorNode;
  };
  /**
   * How many histories the commit joins. Two or more is a merge commit, whose
   * diff is the sum of the commits it joins rather than work of its own.
   */
  readonly parents?: { readonly totalCount?: number };
}

export interface GithubPageInfo {
  readonly hasNextPage?: boolean;
  readonly endCursor?: string | null;
}

export interface GithubReviewNode {
  readonly id?: string;
  readonly state?: string;
  readonly submittedAt?: string;
  readonly author?: GithubActorNode;
}

export interface GithubPullRequestNode {
  /** The node id, which is what a follow-up `nodes(ids:)` query is addressed by. */
  readonly id?: string;
  readonly number?: number;
  readonly title?: string;
  readonly state?: string;
  readonly createdAt?: string;
  readonly closedAt?: string;
  readonly mergedAt?: string;
  readonly author?: GithubActorNode;
  /**
   * The commit the merge put on the base branch. Its parent count is what tells
   * a merge commit apart from a squash or a rebase, because GitHub reports the
   * merge method nowhere else.
   */
  readonly mergeCommit?: {
    readonly oid?: string;
    readonly parents?: { readonly totalCount?: number };
  } | null;
  readonly reviews?: { readonly nodes?: readonly (GithubReviewNode | null)[] };
  /**
   * Reviewers still waiting to answer. GitHub drops a request the moment its
   * review is submitted, so on a closed pull request this holds exactly the
   * people who were asked and never did — the complement of `reviews`, which is
   * what makes the two together the full set of who was asked.
   */
  readonly reviewRequests?: {
    readonly nodes?: readonly (GithubReviewRequestNode | null)[];
  };
}

export interface GithubReviewRequestNode {
  readonly requestedReviewer?: {
    readonly login?: string;
    readonly avatarUrl?: string;
  } | null;
}

export interface GithubHistoryResponse {
  readonly data?: {
    readonly rateLimit?: GithubRateLimitNode;
    readonly repository?: {
      readonly isArchived?: boolean;
      readonly databaseId?: number;
      readonly defaultBranchRef?: {
        readonly name?: string;
        readonly target?: {
          readonly history?: {
            readonly pageInfo?: GithubPageInfo;
            readonly nodes?: readonly (GithubCommitNode | null)[];
          };
        };
      };
    };
  };
  readonly errors?: readonly { readonly message?: string }[];
}

export interface GithubSearchResponse {
  readonly data?: {
    readonly rateLimit?: GithubRateLimitNode;
    readonly search?: {
      readonly pageInfo?: GithubPageInfo;
      readonly nodes?: readonly (GithubPullRequestNode | null)[];
    };
  };
  readonly errors?: readonly { readonly message?: string }[];
}

/** The commits of one pull request, fetched by node id after a search. */
export interface GithubPullRequestCommitsNode {
  readonly id?: string;
  readonly number?: number;
  readonly commits?: {
    readonly totalCount?: number;
    readonly pageInfo?: GithubPageInfo;
    readonly nodes?: readonly ({ readonly commit?: GithubCommitNode } | null)[];
  };
}

/** One batch of pull requests, each with the first page of its commits. */
export interface GithubPullRequestCommitsResponse {
  readonly data?: {
    readonly rateLimit?: GithubRateLimitNode;
    readonly nodes?: readonly (GithubPullRequestCommitsNode | null)[];
  };
  readonly errors?: readonly { readonly message?: string }[];
}

/** A later page of one pull request's commits. */
export interface GithubPullRequestCommitsPageResponse {
  readonly data?: {
    readonly rateLimit?: GithubRateLimitNode;
    readonly node?: GithubPullRequestCommitsNode | null;
  };
  readonly errors?: readonly { readonly message?: string }[];
}

export interface GithubWorkflowRunNode {
  readonly id?: number;
  readonly name?: string;
  readonly head_branch?: string;
  /** The commit the run built, which is what decides whose run it was. */
  readonly head_sha?: string;
  readonly status?: string;
  readonly conclusion?: string;
  readonly run_started_at?: string;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly html_url?: string;
  readonly actor?: { readonly login?: string; readonly avatar_url?: string };
}

export interface GithubWorkflowRunsResponse {
  readonly total_count?: number;
  readonly workflow_runs?: readonly GithubWorkflowRunNode[];
}
