import type { LoggerService } from "@backstage/backend-plugin-api";
import type { CIState, Platform } from "@rios0rios0/backstage-plugin-code-health-common";
import { parseBadgesFromReadme } from "@rios0rios0/backstage-plugin-code-health-common";
import type {
  CodeHealthEvent,
  EventOutcome,
} from "../../../domain/entities/code_health_event";
import {
  attributeMergedWork,
  isGitMergeMessage,
  type CollectedBuild,
  type CollectedCommit,
  type MergedPullRequest,
  type MergeStrategy,
} from "../../../domain/entities/merge_attribution";
import type { RepositoryFileFacts } from "../../../domain/entities/repository_snapshot";
import type { TrackedRepository } from "../../../domain/entities/tracked_repository";
import type { CredentialsResolver } from "../../../domain/services/credentials_resolver";
import type {
  CollectedFacts,
  CollectionWindow,
  CollectorContext,
  ProviderSnapshot,
  SnapshotContext,
  VcsCollector,
} from "../../../domain/services/vcs_collector";
import type { ProviderGateway } from "../../http/provider_gateway";
import { evaluatePolicies, pickLatestTag } from "./azure_devops_snapshot";
import { buildCompliance } from "./compliance";
import { detectRepositoryFiles, SCANNED_DIRECTORIES } from "./repository_files";
import type {
  AdoBuildDefinitionNode,
  AdoItemNode,
  AdoPolicyConfigurationNode,
  AdoRefNode,
  AdoBuildNode,
  AdoCommitNode,
  AdoIdentityNode,
  AdoListResponse,
  AdoPullRequestNode,
  AdoRepositoryNode,
} from "./azure_devops_node";

/**
 * `7.1` is the current stable version. `7.2` exists but is still marked preview
 * for several of these endpoints, and nothing here needs it.
 */
const API_VERSION = "7.1";

/** Azure DevOps caps `$top` well above this; the cap here bounds one response. */
const PAGE_SIZE = 200;

/** Guards against an unbounded loop if a page ever fails to advance. */
const MAX_PAGES = 25;

/** Commit ids looked up per `commitsbatch` request. */
const COMMIT_BATCH = 100;

/**
 * Reviewer votes, as Azure DevOps encodes them.
 * 10 approved, 5 approved with suggestions, 0 no vote, -5 waiting, -10 rejected.
 */
const VOTE_OUTCOMES: ReadonlyMap<number, EventOutcome> = new Map([
  [10, "approved"],
  [5, "approved_with_suggestions"],
  [0, "no_vote"],
  [-5, "waiting"],
  [-10, "rejected"],
]);

const BUILD_OUTCOMES: ReadonlyMap<string, EventOutcome> = new Map([
  ["succeeded", "succeeded"],
  ["partiallySucceeded", "succeeded"],
  ["failed", "failed"],
  ["canceled", "canceled"],
]);

const CI_STATES_BY_RESULT: ReadonlyMap<string, CIState> = new Map([
  ["succeeded", "SUCCESS"],
  ["partiallySucceeded", "SUCCESS"],
  ["failed", "FAILURE"],
  ["canceled", "ERROR"],
]);

const PULL_REQUEST_OUTCOMES: ReadonlyMap<string, EventOutcome> = new Map([
  ["completed", "merged"],
  ["abandoned", "abandoned"],
  ["active", "open"],
]);

/**
 * What each Azure DevOps completion does to the commit it lands, in the terms
 * attribution works in.
 *
 * `rebase` rewrites the pull request's commits onto the target with their
 * authors intact; `rebaseMerge` does the same and then adds a merge commit on
 * top. Neither leaves anything to re-attribute, but the merge commit of the
 * second carries no work and is dropped like any other.
 */
const MERGE_STRATEGIES: ReadonlyMap<string, MergeStrategy> = new Map([
  ["squash", "squash"],
  ["rebase", "linear"],
  ["rebaseMerge", "merge_commit"],
  ["noFastForward", "merge_commit"],
]);

/**
 * Normalised author identity, so the same person is one contributor row.
 *
 * The e-mail is preferred and lowercased: Azure DevOps reports display names
 * inconsistently between the commit metadata and the identity service, and a
 * display name is not unique in the first place.
 */
const identityKey = (identity: AdoIdentityNode | undefined): string | null => {
  const value =
    identity?.uniqueName ?? identity?.email ?? identity?.displayName ?? identity?.name;
  return value ? value.toLowerCase() : null;
};

const identityName = (identity: AdoIdentityNode | undefined): string | null =>
  identity?.displayName ?? identity?.name ?? identity?.uniqueName ?? identity?.email ?? null;

/**
 * How a completed pull request landed, and whether its own commits have to be
 * fetched to be seen at all.
 *
 * Only a plain merge hides them: the commits keep the dates they were written
 * on, so the branch history for the day of the merge never returns them, and
 * the day they were written was fetched before they were on the branch. A
 * squash puts one new commit on the branch, a rebase puts rewritten ones there,
 * and both are dated at the merge.
 *
 * With no completion options at all the completion was a plain merge, which is
 * what Azure DevOps does when nothing says otherwise; `squashMerge` is the
 * boolean `mergeStrategy` replaced. A strategy this plugin does not know keeps
 * whatever the provider stamped, because guessing either way could lose work.
 */
const completionOf = (
  node: AdoPullRequestNode,
): { strategy: MergeStrategy; fetchesCommits: boolean } => {
  const options = node.completionOptions;
  const raw =
    options?.mergeStrategy ?? (options?.squashMerge === true ? "squash" : "noFastForward");
  return {
    strategy: MERGE_STRATEGIES.get(raw) ?? "linear",
    fetchesCommits: raw === "noFastForward",
  };
};

/**
 * Repository-relative path of an item.
 *
 * Azure DevOps reports paths rooted at `/`, and the listing of `/docs` includes
 * `/docs` itself, so both the leading slash and the scope have to be stripped
 * before the shared classifier sees them.
 */
const pathOf = (item: AdoItemNode): string => (item.path ?? "").replace(/^\/+/, "");

const isoOrNull = (value: string | undefined): Date | null => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const chunked = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_unused, index) =>
    items.slice(index * size, (index + 1) * size),
  );

interface CollectedPullRequests {
  readonly events: CodeHealthEvent[];
  readonly merged: MergedPullRequest[];
  /** Completed with a plain merge, so their commits have to be asked for. */
  readonly needingCommits: number[];
}

export interface AzureDevOpsCollectorOptions {
  readonly gateway: ProviderGateway;
  readonly credentials: CredentialsResolver;
  readonly logger: LoggerService;
}

/**
 * Reads a window of an Azure DevOps repository's history.
 *
 * Every endpoint used here accepts a date range, so one window costs a fixed
 * number of requests regardless of how much history exists — four plus
 * pagination, against the five *per repository per dashboard load* the browser
 * used to issue — plus one or two per pull request completed with a plain
 * merge, whose commits the branch history never returns. The organisation-wide
 * project and repository enumeration is gone entirely: the catalog already
 * knows which repositories exist.
 *
 * What the provider reports is not what is stored: merged work is credited to
 * whoever did it rather than to whoever completed the pull request, see
 * `attributeMergedWork`.
 */
export class AzureDevOpsCollector implements VcsCollector {
  readonly platform: Platform = "azure-devops";

  constructor(private readonly options: AzureDevOpsCollectorOptions) {}

  async collect(
    repository: TrackedRepository,
    window: CollectionWindow,
    context: CollectorContext,
  ): Promise<CollectedFacts> {
    const headers = await this.options.credentials.resolve(repository);

    const repositoryNode = await this.fetchRepository(repository, headers, context);
    const repositoryId = repositoryNode?.id ?? repository.externalId ?? repository.name;
    const defaultBranch = repositoryNode?.defaultBranch?.replace(/^refs\/heads\//, "") ?? null;

    const [commits, opened, closed, builds] = await Promise.all([
      this.collectCommits(repository, repositoryId, defaultBranch, window, headers, context),
      this.collectPullRequests(repository, repositoryId, window, headers, context, "created"),
      this.collectPullRequests(repository, repositoryId, window, headers, context, "closed"),
      this.collectBuilds(repository, repositoryId, window, headers, context),
    ]);

    const constituents = await this.collectPullRequestCommits(
      repository,
      repositoryId,
      closed.needingCommits,
      headers,
      context,
    );

    const attributed = attributeMergedWork({
      commits: [...commits, ...constituents],
      builds,
      pullRequests: closed.merged,
    });

    return {
      events: [...attributed.commits, ...opened.events, ...closed.events, ...attributed.builds],
      repositoryFacts: {
        defaultBranch: defaultBranch ?? repository.defaultBranch,
        externalId: repositoryNode?.id ?? repository.externalId,
        ...(repositoryNode?.isDisabled === undefined ? {} : { archived: repositoryNode.isDisabled }),
      },
    };
  }

  async snapshot(
    repository: TrackedRepository,
    context: SnapshotContext,
  ): Promise<ProviderSnapshot> {
    const headers = await this.options.credentials.resolve(repository);
    const project = this.projectUrl(repository);

    const repositoryNode = await this.getJson<AdoRepositoryNode>(
      `${project}/_apis/git/repositories/${encodeURIComponent(repository.name)}?api-version=${API_VERSION}`,
      headers,
      context,
    );
    const repositoryId = repositoryNode.id ?? repository.externalId ?? repository.name;
    const defaultBranch = repositoryNode.defaultBranch?.replace(/^refs\/heads\//, "") ?? null;

    const [policies, definitions, tags, branches, latestBuild, readme, files] = await Promise.all([
      this.projectPolicies(repository, headers, context),
      this.getJson<AdoListResponse<AdoBuildDefinitionNode>>(
        `${project}/_apis/build/definitions?repositoryId=${encodeURIComponent(repositoryId)}` +
          `&repositoryType=TfsGit&api-version=${API_VERSION}`,
        headers,
        context,
      ),
      this.getJson<AdoListResponse<AdoRefNode>>(
        `${project}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/refs` +
          `?filter=tags/&peelTags=true&$top=1000&api-version=${API_VERSION}`,
        headers,
        context,
      ),
      this.getJson<AdoListResponse<AdoRefNode>>(
        `${project}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/refs` +
          `?filter=heads/&$top=1000&api-version=${API_VERSION}`,
        headers,
        context,
      ),
      this.getJson<AdoListResponse<AdoBuildNode>>(
        `${project}/_apis/build/builds?repositoryId=${encodeURIComponent(repositoryId)}` +
          `&repositoryType=TfsGit&$top=1&queryOrder=finishTimeDescending&api-version=${API_VERSION}`,
        headers,
        context,
      ),
      this.readme(repository, repositoryId, headers, context),
      this.repositoryFiles(repository, repositoryId, headers, context),
    ]);

    const findings = evaluatePolicies(policies, repositoryId);
    const build = latestBuild.value?.[0];

    return {
      events: [],
      payload: {
        description: null,
        // Azure DevOps has no language detection, so this stays unset rather
        // than being guessed from file extensions.
        primaryLanguage: null,
        // A repository is only reachable by a caller the project already
        // authorises, so anything visible here is effectively private.
        visibility: "PRIVATE",
        isArchived: repositoryNode.isDisabled ?? false,
        isFork: false,
        defaultBranch: defaultBranch ?? repository.defaultBranch ?? "",
        updatedAt: build?.finishTime ?? new Date(0).toISOString(),
        ciStatus:
          build === undefined
            ? null
            : {
                state: CI_STATES_BY_RESULT.get(build.result ?? "") ?? "PENDING",
                commitSha: build.buildNumber ?? "",
                commitMessage: build.definition?.name ?? "",
                commitUrl: "",
              },
        // Azure DevOps Repos has no release concept. The nearest equivalent is
        // an Azure Pipelines release, which is a different product that not
        // every organisation uses, so claiming one here would be an invention.
        latestRelease: null,
        latestTag: pickLatestTag(tags.value ?? []),
        branches: (branches.value ?? [])
          .map((ref) => (ref.name ?? "").replace(/^refs\/heads\//, ""))
          .filter((name) => name !== ""),
        complianceStatus: buildCompliance({
          pipelineExists: (definitions.value ?? []).length > 0,
          ...findings,
        }),
        badgeStatus: readme === null ? null : parseBadgesFromReadme(readme),
        repositoryFiles: files,
      },
      repositoryFacts: {
        defaultBranch: defaultBranch ?? repository.defaultBranch,
        externalId: repositoryNode.id ?? repository.externalId,
        archived: repositoryNode.isDisabled ?? false,
      },
    };
  }

  /**
   * Branch policies are configured per project, so the list is fetched once per
   * project and reused for every repository in it during the same pass.
   *
   * The previous design fetched this identical payload once per repository —
   * forty repositories in a project meant forty downloads of the same list —
   * which was the single largest source of avoidable Azure DevOps traffic.
   */
  private async projectPolicies(
    repository: TrackedRepository,
    headers: Record<string, string>,
    context: SnapshotContext,
  ): Promise<AdoPolicyConfigurationNode[]> {
    const key = `ado-policies:${repository.host}/${repository.owner}/${repository.project}`;
    const cached = context.projectCache.get(key);
    if (cached) return cached as AdoPolicyConfigurationNode[];

    const body = await this.getJson<AdoListResponse<AdoPolicyConfigurationNode>>(
      `${this.projectUrl(repository)}/_apis/policy/configurations?api-version=${API_VERSION}`,
      headers,
      context,
    );
    const policies = [...(body.value ?? [])];
    context.projectCache.set(key, policies);
    return policies;
  }

  /**
   * The shallow file scan behind the documentation and API-exposure metrics.
   *
   * One listing of the root, then one of `docs/` and one of `api/` — and only
   * when the root said those directories exist, so the common repository costs
   * a single request. A recursive listing would be unbounded on a large
   * repository and is not needed: nothing here looks deeper than GitHub's own
   * scan does, which keeps the metric comparable across the two platforms.
   */
  private async repositoryFiles(
    repository: TrackedRepository,
    repositoryId: string,
    headers: Record<string, string>,
    context: SnapshotContext,
  ): Promise<RepositoryFileFacts> {
    const root = await this.listItems(repository, repositoryId, "/", headers, context);

    const present = SCANNED_DIRECTORIES.filter((directory) =>
      root.some((item) => item.isFolder === true && pathOf(item) === directory),
    );

    const nested = await Promise.all(
      present.map((directory) =>
        this.listItems(repository, repositoryId, `/${directory}`, headers, context),
      ),
    );

    return detectRepositoryFiles(
      [root, ...nested]
        .flat()
        .filter((item) => item.isFolder !== true)
        .map(pathOf)
        .filter((path) => path !== ""),
    );
  }

  private async listItems(
    repository: TrackedRepository,
    repositoryId: string,
    scopePath: string,
    headers: Record<string, string>,
    context: SnapshotContext,
  ): Promise<AdoItemNode[]> {
    const parameters = new URLSearchParams({
      "api-version": API_VERSION,
      scopePath,
      recursionLevel: "OneLevel",
    });
    const url =
      `${this.projectUrl(repository)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}` +
      `/items?${parameters.toString()}`;

    try {
      const body = await this.getJson<AdoListResponse<AdoItemNode>>(url, headers, context);
      return [...(body.value ?? [])];
    } catch {
      // An empty repository, or one whose default branch has no such directory,
      // answers 404. Neither is a reason to fail the whole snapshot.
      return [];
    }
  }

  private async readme(
    repository: TrackedRepository,
    repositoryId: string,
    headers: Record<string, string>,
    context: SnapshotContext,
  ): Promise<string | null> {
    const url =
      `${this.projectUrl(repository)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}` +
      `/items?path=/README.md&includeContent=true&api-version=${API_VERSION}`;

    try {
      const item = await this.getJson<AdoItemNode>(url, headers, context);
      return item.content ?? null;
    } catch {
      // A repository with no README answers 404, which is the common case.
      return null;
    }
  }

  /**
   * The project-scoped API root, derived by truncating the repository URL at
   * its `/_git/` segment.
   *
   * Rebuilding it from host, organisation and project would look tidier and be
   * wrong on Azure DevOps Server, whose URLs carry a collection segment
   * (`https://host/tfs/org/project/_git/repo`) that no field on the repository
   * records. Truncation keeps whatever prefix the real URL had.
   */
  private projectUrl(repository: TrackedRepository): string {
    const marker = "/_git/";
    const index = repository.repoUrl.indexOf(marker);
    if (index > 0) return repository.repoUrl.slice(0, index);
    return `https://${repository.host}/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.project ?? "")}`;
  }

  private async getJson<T>(
    url: string,
    headers: Record<string, string>,
    context: CollectorContext,
  ): Promise<T> {
    const response = await this.options.gateway.request(
      { url, headers, ...(context.signal === undefined ? {} : { signal: context.signal }) },
      context.budget,
    );
    return JSON.parse(response.body) as T;
  }

  private async postJson<T>(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    context: CollectorContext,
  ): Promise<T> {
    const response = await this.options.gateway.request(
      {
        url,
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      },
      context.budget,
    );
    return JSON.parse(response.body) as T;
  }

  /**
   * Resolves the repository once per window, which is also where the GUID and
   * the default branch come from. Both are needed by the calls below and
   * neither is available from the catalog.
   */
  private async fetchRepository(
    repository: TrackedRepository,
    headers: Record<string, string>,
    context: CollectorContext,
  ): Promise<AdoRepositoryNode | null> {
    if (repository.externalId && repository.defaultBranch) return null;

    const url =
      `${this.projectUrl(repository)}/_apis/git/repositories/` +
      `${encodeURIComponent(repository.name)}?api-version=${API_VERSION}`;

    try {
      return await this.getJson<AdoRepositoryNode>(url, headers, context);
    } catch (error) {
      this.options.logger.warn(
        `could not resolve ${repository.entityRef} on Azure DevOps: ${String(error)}`,
      );
      return null;
    }
  }

  /**
   * A commit as the provider reported it. Attribution happens afterwards.
   *
   * Whether it is a merge commit comes from its parents when the payload has
   * them and from its message otherwise: no list endpoint here fills the
   * parents in, and the message is the only other evidence on offer.
   */
  private commitOf(repository: TrackedRepository, node: AdoCommitNode): CollectedCommit | null {
    const occurredAt = isoOrNull(node.author?.date ?? node.committer?.date);
    if (!node.commitId || !occurredAt) return null;

    const counts = node.changeCounts;
    const changedFiles =
      counts === undefined
        ? null
        : (counts.Add ?? 0) + (counts.Edit ?? 0) + (counts.Delete ?? 0);

    return {
      event: {
        repositoryId: repository.id,
        kind: "commit",
        externalId: node.commitId,
        occurredAt,
        actorKey: identityKey(node.author),
        actorName: identityName(node.author),
        actorAvatarUrl: node.author?.imageUrl ?? null,
        outcome: null,
        // Azure DevOps reports changed *files*, never lines. Filling
        // additions and deletions from that would put a different unit behind
        // the same name and make the two platforms silently incomparable.
        additions: null,
        deletions: null,
        changedFiles,
        payload: {
          messageHeadline: node.comment ?? null,
          url: node.remoteUrl ?? null,
        },
      },
      isMerge:
        node.parents === undefined ? isGitMergeMessage(node.comment) : node.parents.length >= 2,
    };
  }

  private async collectCommits(
    repository: TrackedRepository,
    repositoryId: string,
    defaultBranch: string | null,
    window: CollectionWindow,
    headers: Record<string, string>,
    context: CollectorContext,
  ): Promise<CollectedCommit[]> {
    const branch = defaultBranch ?? repository.defaultBranch;
    const commits: CollectedCommit[] = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const parameters = new URLSearchParams({
        "api-version": API_VERSION,
        "searchCriteria.fromDate": window.from.toISOString(),
        "searchCriteria.toDate": window.to.toISOString(),
        "searchCriteria.$top": String(PAGE_SIZE),
        "searchCriteria.$skip": String(page * PAGE_SIZE),
      });
      if (branch) parameters.set("searchCriteria.itemVersion.version", branch);

      const url =
        `${this.projectUrl(repository)}/_apis/git/repositories/` +
        `${encodeURIComponent(repositoryId)}/commits?${parameters.toString()}`;

      const body = await this.getJson<AdoListResponse<AdoCommitNode>>(url, headers, context);
      const nodes = body.value ?? [];

      for (const node of nodes) {
        const commit = this.commitOf(repository, node);
        if (commit) commits.push(commit);
      }

      if (nodes.length < PAGE_SIZE) break;
    }

    return commits;
  }

  private async collectPullRequests(
    repository: TrackedRepository,
    repositoryId: string,
    window: CollectionWindow,
    headers: Record<string, string>,
    context: CollectorContext,
    range: "created" | "closed",
  ): Promise<CollectedPullRequests> {
    const events: CodeHealthEvent[] = [];
    const merged: MergedPullRequest[] = [];
    const needingCommits: number[] = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const parameters = new URLSearchParams({
        "api-version": API_VERSION,
        // Both defaults are wrong for this: the API returns only *active* pull
        // requests and filters on *creation* time unless told otherwise, which
        // is why a naive query appears to show almost nothing.
        "searchCriteria.status": "all",
        "searchCriteria.queryTimeRangeType": range,
        "searchCriteria.minTime": window.from.toISOString(),
        "searchCriteria.maxTime": window.to.toISOString(),
        $top: String(PAGE_SIZE),
        $skip: String(page * PAGE_SIZE),
      });

      const url =
        `${this.projectUrl(repository)}/_apis/git/repositories/` +
        `${encodeURIComponent(repositoryId)}/pullrequests?${parameters.toString()}`;

      const body = await this.getJson<AdoListResponse<AdoPullRequestNode>>(url, headers, context);
      const nodes = body.value ?? [];

      for (const node of nodes) {
        if (node.pullRequestId === undefined) continue;

        const createdAt = isoOrNull(node.creationDate);
        const closedAt = isoOrNull(node.closedDate);
        const occurredAt = range === "created" ? createdAt : closedAt;
        if (!occurredAt) continue;

        // A pull request opened in one window and closed in another produces
        // one event in each, with distinct identifiers. Counting "opened" and
        // "merged" from a single event would force one of the two to mean
        // "opened in a window that later merged", which is not what either
        // number is normally read as.
        const externalId =
          range === "created" ? String(node.pullRequestId) : `${node.pullRequestId}:closed`;
        const outcome =
          range === "created"
            ? "open"
            : (PULL_REQUEST_OUTCOMES.get(node.status ?? "") ?? "abandoned");

        events.push({
          repositoryId: repository.id,
          kind: "pull_request",
          externalId,
          occurredAt,
          actorKey: identityKey(node.createdBy),
          actorName: identityName(node.createdBy),
          actorAvatarUrl: node.createdBy?.imageUrl ?? null,
          outcome,
          additions: null,
          deletions: null,
          changedFiles: null,
          payload: {
            pullRequestId: node.pullRequestId,
            title: node.title ?? null,
            status: node.status ?? null,
            createdAt: createdAt?.toISOString() ?? null,
            closedAt: closedAt?.toISOString() ?? null,
            mergeCommitSha: node.lastMergeCommit?.commitId ?? null,
            mergeStrategy: node.completionOptions?.mergeStrategy ?? null,
          },
        });

        if (range === "closed") {
          events.push(...this.reviewEvents(repository, node, occurredAt));
        }

        if (range === "closed" && outcome === "merged") {
          const completion = completionOf(node);
          merged.push({
            externalId: String(node.pullRequestId),
            mergeCommitId: node.lastMergeCommit?.commitId ?? null,
            strategy: completion.strategy,
            author: {
              actorKey: identityKey(node.createdBy),
              actorName: identityName(node.createdBy),
              actorAvatarUrl: node.createdBy?.imageUrl ?? null,
            },
          });
          if (completion.fetchesCommits) needingCommits.push(node.pullRequestId);
        }
      }

      if (nodes.length < PAGE_SIZE) break;
    }

    return { events, merged, needingCommits };
  }

  /**
   * The commits the pull requests completed with a plain merge brought in.
   *
   * They keep the dates they were written on, so they are stored where they
   * happened. The pull request's commit list carries no change counts, which
   * are what the churn column is made of, so the same commits are read back
   * through `commitsbatch` — which does — unless the list already had them.
   */
  private async collectPullRequestCommits(
    repository: TrackedRepository,
    repositoryId: string,
    pullRequestIds: readonly number[],
    headers: Record<string, string>,
    context: CollectorContext,
  ): Promise<CollectedCommit[]> {
    const refs: AdoCommitNode[] = [];

    for (const pullRequestId of pullRequestIds) {
      let continuationToken: string | null = null;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const parameters = new URLSearchParams({
          "api-version": API_VERSION,
          $top: String(PAGE_SIZE),
        });
        if (continuationToken) parameters.set("continuationToken", continuationToken);

        const url =
          `${this.projectUrl(repository)}/_apis/git/repositories/` +
          `${encodeURIComponent(repositoryId)}/pullrequests/${pullRequestId}/commits` +
          `?${parameters.toString()}`;

        const response = await this.options.gateway.request(
          { url, headers, ...(context.signal === undefined ? {} : { signal: context.signal }) },
          context.budget,
        );
        const body = JSON.parse(response.body) as AdoListResponse<AdoCommitNode>;
        const nodes = body.value ?? [];
        refs.push(...nodes);

        continuationToken = response.header("x-ms-continuationtoken");
        if (!continuationToken || nodes.length === 0) break;
      }
    }

    const counted = await this.withChangeCounts(repository, repositoryId, refs, headers, context);
    return counted.flatMap((node) => {
      const commit = this.commitOf(repository, node);
      return commit === null ? [] : [commit];
    });
  }

  private async withChangeCounts(
    repository: TrackedRepository,
    repositoryId: string,
    refs: readonly AdoCommitNode[],
    headers: Record<string, string>,
    context: CollectorContext,
  ): Promise<AdoCommitNode[]> {
    const missing = refs.filter((ref) => ref.changeCounts === undefined && ref.commitId);
    if (missing.length === 0) return [...refs];

    const counts = new Map<string, AdoCommitNode["changeCounts"]>();
    for (const batch of chunked(missing, COMMIT_BATCH)) {
      const body = await this.postJson<AdoListResponse<AdoCommitNode>>(
        `${this.projectUrl(repository)}/_apis/git/repositories/` +
          `${encodeURIComponent(repositoryId)}/commitsbatch?api-version=${API_VERSION}`,
        { ids: batch.map((ref) => ref.commitId) },
        headers,
        context,
      );
      for (const node of body.value ?? []) {
        if (node.commitId && node.changeCounts) counts.set(node.commitId, node.changeCounts);
      }
    }

    return refs.map((ref) => {
      const changeCounts = ref.commitId === undefined ? undefined : counts.get(ref.commitId);
      return changeCounts === undefined ? ref : { ...ref, changeCounts };
    });
  }

  /**
   * Reviews and review invitations, from the reviewer list of a closed pull
   * request.
   *
   * A reviewer who never voted did not review — that is `no_vote`, and the
   * aggregation counts it as an opportunity rather than as a review. Azure
   * DevOps lists everyone a policy or a person added and most of them never
   * look, which is precisely the fact the score needs: it separates somebody
   * nobody asked from somebody who was asked and did not answer, and only the
   * second of those has anything to answer for.
   *
   * The author's own vote is not a review either, whatever a policy allows.
   * Group reviewers exist to carry a required-reviewer policy and never cast a
   * vote a person is accountable for, so neither is an invitation a person
   * received.
   */
  private reviewEvents(
    repository: TrackedRepository,
    node: AdoPullRequestNode,
    occurredAt: Date,
  ): CodeHealthEvent[] {
    const author = identityKey(node.createdBy);

    // A reviewer who never voted is kept, as `no_vote`, rather than dropped.
    // They are what tells the score the difference between somebody who had
    // nothing to review and somebody who was handed one and left it — and
    // `EventOutcome` has carried `no_vote` all along for exactly this shape.
    return (node.reviewers ?? [])
      .filter((reviewer) => reviewer.isContainer !== true)
      .filter((reviewer) => {
        const key = identityKey(reviewer);
        return key !== null && key !== author;
      })
      .map((reviewer) => ({
        repositoryId: repository.id,
        kind: "pr_review" as const,
        externalId: `${node.pullRequestId}:${reviewer.id ?? identityKey(reviewer)}`,
        occurredAt,
        actorKey: identityKey(reviewer),
        actorName: identityName(reviewer),
        actorAvatarUrl: reviewer.imageUrl ?? null,
        outcome: VOTE_OUTCOMES.get(reviewer.vote ?? 0) ?? "no_vote",
        additions: null,
        deletions: null,
        changedFiles: null,
        payload: { pullRequestId: node.pullRequestId ?? null, vote: reviewer.vote ?? 0 },
      }));
  }

  private async collectBuilds(
    repository: TrackedRepository,
    repositoryId: string,
    window: CollectionWindow,
    headers: Record<string, string>,
    context: CollectorContext,
  ): Promise<CollectedBuild[]> {
    const builds: CollectedBuild[] = [];
    let continuationToken: string | null = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const parameters = new URLSearchParams({
        "api-version": API_VERSION,
        repositoryId,
        repositoryType: "TfsGit",
        minTime: window.from.toISOString(),
        maxTime: window.to.toISOString(),
        // `queryOrder` decides which timestamp `minTime` and `maxTime` filter
        // on. Without it the window would silently apply to queue time, so a
        // build queued before midnight and finished after it lands in the wrong
        // day.
        queryOrder: "finishTimeAscending",
        $top: String(PAGE_SIZE),
      });
      if (continuationToken) parameters.set("continuationToken", continuationToken);

      const url = `${this.projectUrl(repository)}/_apis/build/builds?${parameters.toString()}`;

      const response = await this.options.gateway.request(
        { url, headers, ...(context.signal === undefined ? {} : { signal: context.signal }) },
        context.budget,
      );
      const body = JSON.parse(response.body) as AdoListResponse<AdoBuildNode>;
      const nodes = body.value ?? [];

      for (const node of nodes) {
        const occurredAt = isoOrNull(node.finishTime ?? node.startTime ?? node.queueTime);
        if (node.id === undefined || !occurredAt) continue;

        builds.push({
          event: {
            repositoryId: repository.id,
            kind: "build",
            externalId: String(node.id),
            occurredAt,
            actorKey: identityKey(node.requestedFor),
            actorName: identityName(node.requestedFor),
            actorAvatarUrl: node.requestedFor?.imageUrl ?? null,
            outcome: BUILD_OUTCOMES.get(node.result ?? "") ?? null,
            additions: null,
            deletions: null,
            changedFiles: null,
            payload: {
              buildNumber: node.buildNumber ?? null,
              definition: node.definition?.name ?? null,
              sourceBranch: node.sourceBranch ?? null,
              commitSha: node.sourceVersion ?? null,
              status: node.status ?? null,
              result: node.result ?? null,
            },
          },
          commitId: node.sourceVersion ?? null,
        });
      }

      continuationToken = response.header("x-ms-continuationtoken");
      if (!continuationToken || nodes.length === 0) break;
    }

    return builds;
  }
}
