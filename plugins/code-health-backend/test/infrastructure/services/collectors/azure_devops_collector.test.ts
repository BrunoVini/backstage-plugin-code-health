import { RequestBudget } from "../../../../src/domain/entities/request_budget";
import { ProviderGateway } from "../../../../src/infrastructure/http/provider_gateway";
import { AzureDevOpsCollector } from "../../../../src/infrastructure/services/collectors/azure_devops_collector";
import { anAzureRepository } from "../../../builders/tracked_repository_builder";
import { ControlledClock } from "../../../doubles/controlled_clock";
import { RecordingLogger } from "../../../doubles/recording_logger";
import { StubCredentialsResolver } from "../../../doubles/stub_credentials_resolver";
import { TestProviderServer } from "../../../doubles/test_provider_server";

const server = new TestProviderServer();

const WINDOW = {
  from: new Date("2026-08-09T00:00:00.000Z"),
  to: new Date("2026-08-10T00:00:00.000Z"),
};

beforeAll(async () => server.start());
afterAll(async () => server.stop());
beforeEach(() => server.reset());

const createCollector = (credentials = new StubCredentialsResolver()) => {
  const logger = new RecordingLogger();
  const collector = new AzureDevOpsCollector({
    gateway: new ProviderGateway({
      logger,
      concurrencyPerHost: 4,
      clock: new ControlledClock(1_000_000),
    }),
    credentials,
    logger,
  });
  return { collector, logger, credentials };
};

/** Empty responses for every endpoint, so a test only scripts what it cares about. */
const withEmptyDefaults = () =>
  server
    .onPath("/repositories/gateway", () => ({
      body: { id: "guid-1", name: "gateway", defaultBranch: "refs/heads/main" },
    }))
    .on("/commits", () => ({ body: { value: [] } }))
    .on("/pullrequests", () => ({ body: { value: [] } }))
    .on("/build/builds", () => ({ body: { value: [] } }));

const collect = async () => {
  const { collector } = createCollector();
  return collector.collect(anAzureRepository(server.baseUrl), WINDOW, {
    budget: new RequestBudget(50),
  });
};

describe("AzureDevOpsCollector", () => {
  describe("commits", () => {
    it("should map a commit to an event on the author's date", async () => {
      // given
      server
        .onPath("/repositories/gateway", () => ({
          body: { id: "guid-1", defaultBranch: "refs/heads/main" },
        }))
        .on("/commits", () => ({
          body: {
            value: [
              {
                commitId: "abc123",
                comment: "fixed the thing",
                remoteUrl: "https://dev.azure.com/commit/abc123",
                // Git's own metadata, which is a `name` and an `email` rather
                // than the identity service's `displayName` and `uniqueName`.
                author: {
                  name: "Dev Example",
                  email: "Dev.Example@Corp.COM",
                  date: "2026-08-09T10:00:00Z",
                  imageUrl: "https://avatar",
                },
                changeCounts: { Add: 2, Edit: 3, Delete: 1 },
              },
            ],
          },
        }))
        .on("/pullrequests", () => ({ body: { value: [] } }))
        .on("/build/builds", () => ({ body: { value: [] } }));

      // when
      const result = await collect();

      // then
      const commit = result.events.find((event) => event.kind === "commit");
      expect(commit).toMatchObject({
        externalId: "abc123",
        occurredAt: new Date("2026-08-09T10:00:00Z"),
        // Lowercased so the same person under a differently cased address is
        // one contributor row rather than two.
        actorKey: "dev.example@corp.com",
        actorName: "Dev Example",
        changedFiles: 6,
      });
    });

    it("should leave line counts unset, because Azure DevOps reports files", async () => {
      // given
      // Filling additions and deletions from a file count would put a different
      // unit behind the same name and make the platforms silently incomparable.
      server
        .onPath("/repositories/gateway", () => ({ body: { id: "guid-1" } }))
        .on("/commits", () => ({
          body: {
            value: [
              {
                commitId: "abc123",
                author: { uniqueName: "dev@example.com", date: "2026-08-09T10:00:00Z" },
                changeCounts: { Add: 5 },
              },
            ],
          },
        }))
        .on("/pullrequests", () => ({ body: { value: [] } }))
        .on("/build/builds", () => ({ body: { value: [] } }));

      // when
      const result = await collect();

      // then
      const commit = result.events.find((event) => event.kind === "commit");
      expect(commit?.additions).toBeNull();
      expect(commit?.deletions).toBeNull();
      expect(commit?.changedFiles).toBe(5);
    });

    it("should ask for the window and the default branch", async () => {
      // given
      withEmptyDefaults();

      // when
      await collect();

      // then
      const [request] = server.requestsFor("/commits");
      expect(request.query.get("searchCriteria.fromDate")).toBe(WINDOW.from.toISOString());
      expect(request.query.get("searchCriteria.toDate")).toBe(WINDOW.to.toISOString());
      expect(request.query.get("searchCriteria.itemVersion.version")).toBe("main");
      expect(request.query.get("api-version")).toBe("7.1");
    });

    it("should recognise a merge commit by its message when no parents are reported", async () => {
      // given
      // No list endpoint here reports a parent count, and the message is the
      // only other evidence: git writes the same subject on every merge it
      // makes.
      server
        .onPath("/repositories/gateway", () => ({ body: { id: "guid-1" } }))
        .on("/commits", () => ({
          body: {
            value: [
              {
                commitId: "local-merge",
                comment: "Merge branch 'main' into feature/thing",
                author: { email: "dev@example.com", date: "2026-08-09T10:00:00Z" },
                changeCounts: { Edit: 400 },
              },
              {
                commitId: "work",
                comment: "fixed the thing",
                author: { email: "dev@example.com", date: "2026-08-09T11:00:00Z" },
                changeCounts: { Edit: 1 },
              },
            ],
          },
        }))
        .on("/pullrequests", () => ({ body: { value: [] } }))
        .on("/build/builds", () => ({ body: { value: [] } }));

      // when
      const result = await collect();

      // then
      expect(result.events.filter((event) => event.kind === "commit").map((event) => event.externalId)).toEqual(["work"]);
    });

    it("should trust a reported parent count over the message", async () => {
      // given
      server
        .onPath("/repositories/gateway", () => ({ body: { id: "guid-1" } }))
        .on("/commits", () => ({
          body: {
            value: [
              {
                commitId: "two-parents",
                comment: "fixed the thing",
                parents: ["a", "b"],
                author: { email: "dev@example.com", date: "2026-08-09T10:00:00Z" },
              },
              {
                commitId: "one-parent",
                comment: "Merge branch 'main' into feature/thing",
                parents: ["a"],
                author: { email: "dev@example.com", date: "2026-08-09T11:00:00Z" },
              },
            ],
          },
        }))
        .on("/pullrequests", () => ({ body: { value: [] } }))
        .on("/build/builds", () => ({ body: { value: [] } }));

      // when
      const result = await collect();

      // then
      expect(result.events.filter((event) => event.kind === "commit").map((event) => event.externalId)).toEqual(["one-parent"]);
    });

    it("should skip a commit with no usable date", async () => {
      // given
      server
        .onPath("/repositories/gateway", () => ({ body: { id: "guid-1" } }))
        .on("/commits", () => ({
          body: { value: [{ commitId: "abc123" }, { author: { date: "2026-08-09T10:00:00Z" } }] },
        }))
        .on("/pullrequests", () => ({ body: { value: [] } }))
        .on("/build/builds", () => ({ body: { value: [] } }));

      // when
      const result = await collect();

      // then
      expect(result.events.filter((event) => event.kind === "commit")).toEqual([]);
    });
  });

  describe("pull requests", () => {
    it("should override the two defaults that would otherwise hide most pull requests", async () => {
      // given
      // The API returns only *active* pull requests and filters on *creation*
      // time unless told otherwise, which is why a naive query looks empty.
      withEmptyDefaults();

      // when
      await collect();

      // then
      const requests = server.requestsFor("/pullrequests");
      expect(requests).toHaveLength(2);
      expect(requests.every((request) => request.query.get("searchCriteria.status") === "all")).toBe(
        true,
      );
      expect(
        requests.map((request) => request.query.get("searchCriteria.queryTimeRangeType")).sort(),
      ).toEqual(["closed", "created"]);
    });

    it("should emit separate events for opening and for closing", async () => {
      // given
      // A pull request opened in one window and merged in another has to count
      // once in each; a single event would force "merged" to mean "opened then
      // later merged", which is not how the number is read.
      const pullRequest = {
        pullRequestId: 42,
        title: "add the thing",
        status: "completed",
        creationDate: "2026-08-09T09:00:00Z",
        closedDate: "2026-08-09T15:00:00Z",
        createdBy: { displayName: "Dev", uniqueName: "dev@example.com" },
        reviewers: [],
      };
      server
        .onPath("/repositories/gateway", () => ({ body: { id: "guid-1" } }))
        .on("/commits", () => ({ body: { value: [] } }))
        .on("/pullrequests", (request) => ({
          body: {
            value:
              request.query.get("searchCriteria.queryTimeRangeType") === "created"
                ? [pullRequest]
                : [pullRequest],
          },
        }))
        .on("/build/builds", () => ({ body: { value: [] } }));

      // when
      const result = await collect();

      // then
      const events = result.events.filter((event) => event.kind === "pull_request");
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.externalId).sort()).toEqual(["42", "42:closed"]);
      expect(events.find((event) => event.externalId === "42")?.outcome).toBe("open");
      expect(events.find((event) => event.externalId === "42:closed")?.outcome).toBe("merged");
    });

    it("should record an abandoned pull request as abandoned", async () => {
      // given
      server
        .onPath("/repositories/gateway", () => ({ body: { id: "guid-1" } }))
        .on("/commits", () => ({ body: { value: [] } }))
        .on("/pullrequests", (request) => ({
          body: {
            value:
              request.query.get("searchCriteria.queryTimeRangeType") === "closed"
                ? [
                    {
                      pullRequestId: 43,
                      status: "abandoned",
                      creationDate: "2026-08-09T09:00:00Z",
                      closedDate: "2026-08-09T15:00:00Z",
                      createdBy: { uniqueName: "dev@example.com" },
                    },
                  ]
                : [],
          },
        }))
        .on("/build/builds", () => ({ body: { value: [] } }));

      // when
      const result = await collect();

      // then
      const closed = result.events.find((event) => event.externalId === "43:closed");
      expect(closed?.outcome).toBe("abandoned");
    });

    it("should turn reviewer votes into review events", async () => {
      // given
      server
        .onPath("/repositories/gateway", () => ({ body: { id: "guid-1" } }))
        .on("/commits", () => ({ body: { value: [] } }))
        .on("/pullrequests", (request) => ({
          body: {
            value:
              request.query.get("searchCriteria.queryTimeRangeType") === "closed"
                ? [
                    {
                      pullRequestId: 42,
                      status: "completed",
                      creationDate: "2026-08-09T09:00:00Z",
                      closedDate: "2026-08-09T15:00:00Z",
                      createdBy: { uniqueName: "author@example.com" },
                      reviewers: [
                        { id: "r1", uniqueName: "approver@example.com", vote: 10 },
                        { id: "r2", uniqueName: "blocker@example.com", vote: -10 },
                        { id: "r3", uniqueName: "team@example.com", vote: 0, isContainer: true },
                      ],
                    },
                  ]
                : [],
          },
        }))
        .on("/build/builds", () => ({ body: { value: [] } }));

      // when
      const result = await collect();

      // then
      const reviews = result.events.filter((event) => event.kind === "pr_review");
      expect(reviews).toHaveLength(2);
      expect(reviews.map((event) => event.outcome).sort()).toEqual(["approved", "rejected"]);
      // A reviewer group carries a required-reviewer policy and never casts a
      // vote a person is accountable for.
      expect(reviews.some((event) => event.actorKey === "team@example.com")).toBe(false);
    });
  });

  describe("merged work", () => {
    const completer = { displayName: "Merger", uniqueName: "merger@example.com" };
    const creator = {
      displayName: "Author",
      uniqueName: "Author@Example.com",
      imageUrl: "https://avatar/author",
    };

    const completed = (overrides: Record<string, unknown>) => ({
      pullRequestId: 42,
      status: "completed",
      creationDate: "2026-08-06T09:00:00Z",
      closedDate: "2026-08-09T15:00:00Z",
      createdBy: creator,
      lastMergeCommit: { commitId: "landed" },
      ...overrides,
    });

    const withClosed = (pullRequest: Record<string, unknown>, commits: Record<string, unknown>[]) =>
      server
        .onPath("/repositories/gateway", () => ({ body: { id: "guid-1" } }))
        .on("/pullrequests", (request) => ({
          body: {
            value:
              request.query.get("searchCriteria.queryTimeRangeType") === "closed"
                ? [pullRequest]
                : [],
          },
        }))
        .on("/commits", () => ({ body: { value: commits } }))
        .on("/build/builds", () => ({ body: { value: [] } }));

    it("should credit a squash commit to the pull request's creator", async () => {
      // given
      // Azure DevOps stamps the squash commit with whoever pressed Complete.
      withClosed(completed({ completionOptions: { mergeStrategy: "squash" } }), [
        {
          commitId: "landed",
          comment: "Merged PR 42: add the thing",
          author: { name: "Merger", email: "merger@example.com", date: "2026-08-09T15:00:00Z" },
          changeCounts: { Add: 2, Edit: 3 },
        },
      ]);

      // when
      const result = await collect();

      // then
      const commit = result.events.find((event) => event.kind === "commit");
      expect(commit).toMatchObject({
        externalId: "landed",
        actorKey: "author@example.com",
        actorName: "Author",
        actorAvatarUrl: "https://avatar/author",
        changedFiles: 5,
      });
      expect(commit?.payload).toMatchObject({ pullRequestId: "42" });
      expect(server.requests.filter((request) => request.path.includes("/pullrequests/42/commits"))).toEqual([]);
    });

    it("should honour the boolean an older completion recorded a squash with", async () => {
      // given
      withClosed(completed({ completionOptions: { squashMerge: true } }), [
        {
          commitId: "landed",
          author: { email: "merger@example.com", date: "2026-08-09T15:00:00Z" },
        },
      ]);

      // when
      const result = await collect();

      // then
      expect(result.events.find((event) => event.kind === "commit")?.actorKey).toBe("author@example.com");
    });

    it("should drop the merge commit of a plain merge and count the pull request's own commits", async () => {
      // given
      // With no completion options the completion was a plain merge, whose
      // commits keep the dates they were written on and never appear in the
      // branch history for the day of the merge.
      server
        .onPath("/pullrequests/42/commits", () => ({
          body: {
            value: [
              {
                commitId: "work-1",
                comment: "added the thing",
                author: { name: "Author", email: "author@example.com", date: "2026-08-06T10:00:00Z" },
              },
              {
                commitId: "work-2",
                comment: "Merge branch 'main' into feature/thing",
                author: { name: "Author", email: "author@example.com", date: "2026-08-07T10:00:00Z" },
              },
            ],
          },
        }))
        .on("/commitsbatch", (request) => ({
          body: {
            value: (JSON.parse(request.body) as { ids: string[] }).ids.map((commitId) => ({
              commitId,
              changeCounts: { Edit: commitId === "work-1" ? 4 : 400 },
            })),
          },
        }));
      withClosed(completed({}), [
        {
          commitId: "landed",
          comment: "Merged PR 42: add the thing",
          author: { email: "merger@example.com", date: "2026-08-09T15:00:00Z" },
          changeCounts: { Add: 2, Edit: 402 },
        },
      ]);

      // when
      const result = await collect();

      // then
      const commits = result.events.filter((event) => event.kind === "commit");
      // The merge the author made from main on the way is a merge commit too.
      expect(commits.map((event) => event.externalId)).toEqual(["work-1"]);
      expect(commits[0]).toMatchObject({
        actorKey: "author@example.com",
        actorName: "Author",
        occurredAt: new Date("2026-08-06T10:00:00Z"),
        changedFiles: 4,
      });
      const batch = server.requests.find((request) => request.path.endsWith("/commitsbatch"));
      expect(batch?.method).toBe("POST");
      expect(JSON.parse(batch!.body)).toEqual({ ids: ["work-1", "work-2"] });
    });

    it("should not ask for change counts the pull request's commit list already carried", async () => {
      // given
      server.onPath("/pullrequests/42/commits", () => ({
        body: {
          value: [
            {
              commitId: "work-1",
              author: { email: "author@example.com", date: "2026-08-06T10:00:00Z" },
              changeCounts: { Add: 1 },
            },
          ],
        },
      }));
      withClosed(completed({ completionOptions: { mergeStrategy: "noFastForward" } }), []);

      // when
      const result = await collect();

      // then
      expect(result.events.find((event) => event.kind === "commit")?.changedFiles).toBe(1);
      expect(server.requests.filter((request) => request.path.endsWith("/commitsbatch"))).toEqual([]);
    });

    it("should follow the continuation token across a pull request's commit pages", async () => {
      // given
      let served = 0;
      server.onPath("/pullrequests/42/commits", () => {
        served += 1;
        return served === 1
          ? {
              body: { value: [{ commitId: "work-1", author: { email: "author@example.com", date: "2026-08-06T10:00:00Z" }, changeCounts: {} }] },
              headers: { "x-ms-continuationtoken": "page-2" },
            }
          : {
              body: { value: [{ commitId: "work-2", author: { email: "author@example.com", date: "2026-08-07T10:00:00Z" }, changeCounts: {} }] },
            };
      });
      withClosed(completed({}), []);

      // when
      const result = await collect();

      // then
      expect(result.events.filter((event) => event.kind === "commit").map((event) => event.externalId)).toEqual(["work-1", "work-2"]);
      expect(server.requestsFor("/pullrequests/42/commits")[1].query.get("continuationToken")).toBe("page-2");
    });

    it("should leave a rebase completion's commits as the provider reported them", async () => {
      // given
      // A rebase rewrites the pull request's commits onto the target with their
      // authors intact, and they are dated at the completion, so the branch
      // history already has them under the right people.
      withClosed(completed({ completionOptions: { mergeStrategy: "rebase" } }), [
        {
          commitId: "landed",
          comment: "added the thing",
          author: { email: "author@example.com", date: "2026-08-09T15:00:00Z" },
        },
      ]);

      // when
      const result = await collect();

      // then
      const commit = result.events.find((event) => event.kind === "commit");
      expect(commit?.actorKey).toBe("author@example.com");
      expect(commit?.payload).not.toHaveProperty("pullRequestId");
      expect(server.requests.filter((request) => request.path.includes("/pullrequests/42/commits"))).toEqual([]);
    });

    it("should drop the merge commit of a rebase-and-merge without re-fetching its commits", async () => {
      // given
      // The rewritten commits are already on the branch under their authors;
      // asking the pull request for its commits would return the originals
      // under different identifiers and count the work twice.
      withClosed(completed({ completionOptions: { mergeStrategy: "rebaseMerge" } }), [
        {
          commitId: "landed",
          comment: "Merged PR 42: add the thing",
          author: { email: "merger@example.com", date: "2026-08-09T15:00:01Z" },
        },
        {
          commitId: "rewritten",
          comment: "added the thing",
          author: { email: "author@example.com", date: "2026-08-09T15:00:00Z" },
        },
      ]);

      // when
      const result = await collect();

      // then
      expect(result.events.filter((event) => event.kind === "commit").map((event) => event.externalId)).toEqual(["rewritten"]);
      expect(server.requests.filter((request) => request.path.includes("/pullrequests/42/commits"))).toEqual([]);
    });

    it("should keep the stamp on a completion strategy it does not know", async () => {
      // given
      withClosed(completed({ completionOptions: { mergeStrategy: "somethingNew" } }), [
        {
          commitId: "landed",
          author: { email: "merger@example.com", date: "2026-08-09T15:00:00Z" },
        },
      ]);

      // when
      const result = await collect();

      // then
      expect(result.events.find((event) => event.kind === "commit")?.actorKey).toBe("merger@example.com");
    });

    it("should credit a build to the creator of the pull request whose completion it built", async () => {
      // given
      // The post-completion build is requested for whoever completed, and it
      // built the creator's change.
      server.on("/build/builds", () => ({
        body: {
          value: [
            {
              id: 900,
              result: "succeeded",
              finishTime: "2026-08-09T15:10:00Z",
              sourceBranch: "refs/heads/main",
              sourceVersion: "landed",
              requestedFor: completer,
            },
          ],
        },
      }));
      withClosed(completed({ completionOptions: { mergeStrategy: "squash" } }), []);

      // when
      const result = await collect();

      // then
      const build = result.events.find((event) => event.kind === "build");
      expect(build).toMatchObject({ actorKey: "author@example.com", actorName: "Author" });
      expect(build?.payload).toMatchObject({ commitSha: "landed" });
    });

    it("should credit a build to the author of the commit it built", async () => {
      // given
      server.on("/build/builds", () => ({
        body: {
          value: [
            {
              id: 901,
              result: "failed",
              finishTime: "2026-08-09T11:10:00Z",
              sourceVersion: "abc123",
              requestedFor: completer,
            },
          ],
        },
      }));
      server
        .onPath("/repositories/gateway", () => ({ body: { id: "guid-1" } }))
        .on("/commits", () => ({
          body: {
            value: [
              {
                commitId: "abc123",
                author: { email: "author@example.com", date: "2026-08-09T11:00:00Z" },
              },
            ],
          },
        }))
        .on("/pullrequests", () => ({ body: { value: [] } }));

      // when
      const result = await collect();

      // then
      expect(result.events.find((event) => event.kind === "build")?.actorKey).toBe("author@example.com");
    });

    it("should keep a reviewer who never voted as an invitation rather than a review", async () => {
      // given
      // Azure DevOps lists everyone a policy or a person added, and most of
      // them never look. That is the fact the score needs: it separates
      // somebody nobody asked from somebody who was asked and did not answer.
      withClosed(
        completed({
          reviewers: [
            { id: "r1", uniqueName: "approver@example.com", vote: 10 },
            { id: "r2", uniqueName: "bystander@example.com", vote: 0 },
            { id: "r3", uniqueName: "silent@example.com" },
          ],
        }),
        [],
      );

      // when
      const result = await collect();

      // then
      const reviews = result.events.filter((event) => event.kind === "pr_review");
      expect(reviews.map((event) => [event.actorKey, event.outcome])).toEqual([
        ["approver@example.com", "approved"],
        ["bystander@example.com", "no_vote"],
        ["silent@example.com", "no_vote"],
      ]);
    });

    it("should not count the creator's own vote as a review", async () => {
      // given
      withClosed(
        completed({
          reviewers: [
            { id: "r1", uniqueName: "author@example.com", vote: 10 },
            { id: "r2", uniqueName: "approver@example.com", vote: 5 },
          ],
        }),
        [],
      );

      // when
      const result = await collect();

      // then
      const reviews = result.events.filter((event) => event.kind === "pr_review");
      expect(reviews.map((event) => event.actorKey)).toEqual(["approver@example.com"]);
    });
  });

  describe("builds", () => {
    it("should filter on finish time rather than queue time", async () => {
      // given
      // `queryOrder` decides which timestamp the window applies to. Without it
      // a build queued before midnight and finished after it lands in the
      // wrong day.
      withEmptyDefaults();

      // when
      await collect();

      // then
      const [request] = server.requestsFor("/build/builds");
      expect(request.query.get("queryOrder")).toBe("finishTimeAscending");
      expect(request.query.get("minTime")).toBe(WINDOW.from.toISOString());
      expect(request.query.get("repositoryType")).toBe("TfsGit");
      expect(request.query.get("repositoryId")).toBe("guid-1");
    });

    it("should map a build result to an outcome", async () => {
      // given
      server
        .onPath("/repositories/gateway", () => ({ body: { id: "guid-1" } }))
        .on("/commits", () => ({ body: { value: [] } }))
        .on("/pullrequests", () => ({ body: { value: [] } }))
        .on("/build/builds", () => ({
          body: {
            value: [
              {
                id: 900,
                result: "partiallySucceeded",
                finishTime: "2026-08-09T11:00:00Z",
                requestedFor: { displayName: "Dev", uniqueName: "dev@example.com" },
                definition: { name: "ci" },
              },
            ],
          },
        }));

      // when
      const result = await collect();

      // then
      const build = result.events.find((event) => event.kind === "build");
      expect(build).toMatchObject({
        externalId: "900",
        outcome: "succeeded",
        actorKey: "dev@example.com",
      });
    });

    it("should follow the continuation token across pages", async () => {
      // given
      let served = 0;
      server
        .onPath("/repositories/gateway", () => ({ body: { id: "guid-1" } }))
        .on("/commits", () => ({ body: { value: [] } }))
        .on("/pullrequests", () => ({ body: { value: [] } }))
        .on("/build/builds", () => {
          served += 1;
          return served === 1
            ? {
                body: { value: [{ id: 1, result: "succeeded", finishTime: "2026-08-09T01:00:00Z" }] },
                headers: { "x-ms-continuationtoken": "page-2" },
              }
            : {
                body: { value: [{ id: 2, result: "failed", finishTime: "2026-08-09T02:00:00Z" }] },
              };
        });

      // when
      const result = await collect();

      // then
      const builds = result.events.filter((event) => event.kind === "build");
      expect(builds.map((event) => event.externalId)).toEqual(["1", "2"]);
      expect(server.requestsFor("/build/builds")[1].query.get("continuationToken")).toBe("page-2");
    });
  });

  describe("repository facts", () => {
    it("should learn the identifier and default branch the catalog cannot supply", async () => {
      // given
      withEmptyDefaults();

      // when
      const result = await collect();

      // then
      expect(result.repositoryFacts).toMatchObject({
        defaultBranch: "main",
        externalId: "guid-1",
      });
    });

    it("should report a disabled repository as archived", async () => {
      // given
      server
        .onPath("/repositories/gateway", () => ({
          body: { id: "guid-1", defaultBranch: "refs/heads/main", isDisabled: true },
        }))
        .on("/commits", () => ({ body: { value: [] } }))
        .on("/pullrequests", () => ({ body: { value: [] } }))
        .on("/build/builds", () => ({ body: { value: [] } }));

      // when
      const result = await collect();

      // then
      expect(result.repositoryFacts?.archived).toBe(true);
    });

    it("should skip the lookup once both facts are already known", async () => {
      // given
      // The lookup exists only to learn them; repeating it every window would
      // spend a request per repository per day for nothing.
      const { collector } = createCollector();
      const repository = anAzureRepository(server.baseUrl, {
        externalId: "guid-1",
        defaultBranch: "main",
      });
      server
        .on("/commits", () => ({ body: { value: [] } }))
        .on("/pullrequests", () => ({ body: { value: [] } }))
        .on("/build/builds", () => ({ body: { value: [] } }));

      // when
      await collector.collect(repository, WINDOW, { budget: new RequestBudget(50) });

      // then
      expect(server.requests.filter((request) => request.path.endsWith("/repositories/gateway"))).toEqual([]);
    });

    it("should carry on when the repository cannot be resolved", async () => {
      // given
      const { collector, logger } = createCollector();
      server
        .onPath("/repositories/gateway", () => ({ status: 404, body: { message: "gone" } }))
        .on("/commits", () => ({ body: { value: [] } }))
        .on("/pullrequests", () => ({ body: { value: [] } }))
        .on("/build/builds", () => ({ body: { value: [] } }));

      // when
      const result = await collector.collect(anAzureRepository(server.baseUrl), WINDOW, {
        budget: new RequestBudget(50),
      });

      // then
      expect(result.events).toEqual([]);
      expect(logger.at("warn").join(" ")).toContain("could not resolve");
    });
  });

  describe("credentials", () => {
    it("should send the resolved headers on every call", async () => {
      // given
      const credentials = new StubCredentialsResolver().withHeaders({
        Authorization: "Basic fixture-token-placeholder",
      });
      const { collector } = createCollector(credentials);
      withEmptyDefaults();

      // when
      await collector.collect(anAzureRepository(server.baseUrl), WINDOW, {
        budget: new RequestBudget(50),
      });

      // then
      expect(credentials.calls).toEqual(["component:default/gateway"]);
      expect(server.requests.every((request) => request.headers.authorization !== undefined)).toBe(
        true,
      );
    });

    it("should fail loudly when no integration covers the repository", async () => {
      // given
      // Silently collecting nothing would record the window as ingested and
      // leave a permanent hole in the history.
      const { collector } = createCollector(
        new StubCredentialsResolver().withMissingCredentials(),
      );

      // when / then
      await expect(
        collector.collect(anAzureRepository(server.baseUrl), WINDOW, {
          budget: new RequestBudget(50),
        }),
      ).rejects.toThrow("no integration is configured");
    });
  });

  describe("sparse payloads", () => {
    it("should map every kind when the provider omits all optional fields", async () => {
      // given
      // Azure DevOps omits fields rather than nulling them, and which ones come
      // back varies by project configuration. A payload carrying only the
      // required identifiers has to map cleanly, because the alternative is a
      // whole window lost to a `TypeError`.
      server
        .onPath("/repositories/gateway", () => ({ body: {} }))
        .on("/commits", () => ({
          body: { value: [{ commitId: "abc123", author: { date: "2026-08-09T10:00:00Z" } }] },
        }))
        .on("/pullrequests", (request) => ({
          body: {
            value:
              request.query.get("searchCriteria.queryTimeRangeType") === "created"
                ? [{ pullRequestId: 1, creationDate: "2026-08-09T09:00:00Z" }]
                : [
                    {
                      pullRequestId: 1,
                      closedDate: "2026-08-09T15:00:00Z",
                      reviewers: [{ uniqueName: "reviewer@example.com" }],
                    },
                  ],
          },
        }))
        .on("/build/builds", () => ({
          body: { value: [{ id: 900, finishTime: "2026-08-09T11:00:00Z" }] },
        }));

      // when
      const result = await collect();

      // then
      const byKind = (kind: string) => result.events.filter((event) => event.kind === kind);
      expect(byKind("commit")[0]).toMatchObject({
        actorKey: null,
        actorName: null,
        changedFiles: null,
      });
      expect(byKind("pull_request")).toHaveLength(2);
      // A pull request with no recognisable status is treated as abandoned
      // rather than counted as merged, so the merge rate cannot be inflated by
      // a payload the plugin failed to understand.
      expect(byKind("pull_request").find((event) => event.externalId === "1:closed")?.outcome).toBe(
        "abandoned",
      );
      // A reviewer with no vote never reviewed, so the event is recorded as an
      // invitation — opportunity for the score, never a review.
      expect(byKind("pr_review").map((event) => event.outcome)).toEqual(["no_vote"]);
      expect(byKind("build")[0]).toMatchObject({ outcome: null, actorKey: null });
    });

    it("should treat a missing value array as an empty page", async () => {
      // given
      server
        .onPath("/repositories/gateway", () => ({ body: { id: "guid-1" } }))
        .on("/commits", () => ({ body: {} }))
        .on("/pullrequests", () => ({ body: {} }))
        .on("/build/builds", () => ({ body: {} }));

      // when
      const result = await collect();

      // then
      expect(result.events).toEqual([]);
    });

    it("should skip a pull request with no usable date for the range asked for", async () => {
      // given
      server
        .onPath("/repositories/gateway", () => ({ body: { id: "guid-1" } }))
        .on("/commits", () => ({ body: { value: [] } }))
        .on("/pullrequests", () => ({ body: { value: [{ pullRequestId: 5 }] } }))
        .on("/build/builds", () => ({ body: { value: [] } }));

      // when
      const result = await collect();

      // then
      expect(result.events).toEqual([]);
    });

    it("should skip a build with no timestamp at all", async () => {
      // given
      server
        .onPath("/repositories/gateway", () => ({ body: { id: "guid-1" } }))
        .on("/commits", () => ({ body: { value: [] } }))
        .on("/pullrequests", () => ({ body: { value: [] } }))
        .on("/build/builds", () => ({ body: { value: [{ id: 900 }] } }));

      // when
      const result = await collect();

      // then
      expect(result.events).toEqual([]);
    });

    it("should fall back to the committer date when the author has none", async () => {
      // given
      server
        .onPath("/repositories/gateway", () => ({ body: { id: "guid-1" } }))
        .on("/commits", () => ({
          body: {
            value: [
              {
                commitId: "abc123",
                committer: { uniqueName: "bot@example.com", date: "2026-08-09T10:00:00Z" },
              },
            ],
          },
        }))
        .on("/pullrequests", () => ({ body: { value: [] } }))
        .on("/build/builds", () => ({ body: { value: [] } }));

      // when
      const result = await collect();

      // then
      expect(result.events[0].occurredAt).toEqual(new Date("2026-08-09T10:00:00Z"));
    });
  });

  describe("snapshot", () => {
    const snapshotContext = () => ({
      budget: new RequestBudget(50),
      projectCache: new Map<string, unknown>(),
    });

    const withSnapshotRoutes = () =>
      server
        .onPath("/repositories/gateway", () => ({
          body: { id: "guid-1", defaultBranch: "refs/heads/main", isDisabled: false },
        }))
        .on("/policy/configurations", () => ({
          body: {
            value: [
              {
                isEnabled: true,
                isBlocking: true,
                type: { id: "0609b952-1397-4640-95ec-e00a01b2c241" },
                settings: { validDuration: 720, scope: [{ repositoryId: null }] },
              },
            ],
          },
        }))
        .on("/build/definitions", () => ({ body: { value: [{ id: 1, name: "ci" }] } }))
        .on("/refs", (request) => ({
          body: {
            value:
              request.query.get("filter") === "tags/"
                ? [
                    { name: "refs/tags/v1.0.0", objectId: "t1", peeledObjectId: "c1" },
                    { name: "refs/tags/v1.10.0", objectId: "t2", peeledObjectId: "c2" },
                  ]
                : [{ name: "refs/heads/main" }, { name: "refs/heads/release" }],
          },
        }))
        .on("/build/builds", () => ({
          body: {
            value: [
              {
                id: 5,
                result: "succeeded",
                finishTime: "2026-08-10T01:00:00Z",
                buildNumber: "20260810.1",
                definition: { name: "ci" },
              },
            ],
          },
        }))
        // One endpoint serves two jobs: `path` fetches a blob for the badge
        // scan, `scopePath` lists a directory for the documentation scan.
        .on("/items", (request) => {
          const scope = request.query.get("scopePath");
          if (scope === null) {
            return {
              body: {
                content:
                  "![Build Status](https://img.shields.io/github/actions/workflow/status/x/y)",
              },
            };
          }
          if (scope === "/") {
            return {
              body: {
                value: [
                  { path: "/README.md", isFolder: false },
                  { path: "/docs", isFolder: true },
                  { path: "/go.mod", isFolder: false },
                ],
              },
            };
          }
          return {
            body: {
              value: [
                { path: "/docs", isFolder: true },
                { path: "/docs/index.md", isFolder: false },
                { path: "/docs/openapi.yaml", isFolder: false },
              ],
            },
          };
        });

    it("should assemble the repository's current state", async () => {
      // given
      const { collector } = createCollector();
      withSnapshotRoutes();

      // when
      const result = await collector.snapshot(anAzureRepository(server.baseUrl), snapshotContext());

      // then
      expect(result.payload).toMatchObject({
        defaultBranch: "main",
        isArchived: false,
        branches: ["main", "release"],
        latestTag: { name: "v1.10.0", commitSha: "c2" },
      });
      expect(result.payload.ciStatus?.state).toBe("SUCCESS");
    });

    it("should derive compliance from the project's policies", async () => {
      // given
      const { collector } = createCollector();
      withSnapshotRoutes();

      // when
      const result = await collector.snapshot(anAzureRepository(server.baseUrl), snapshotContext());

      // then
      expect(result.payload.complianceStatus).toEqual({
        pipelineExists: true,
        buildPolicyOnPRs: true,
        buildPolicyExpiration: true,
        branchProtection: true,
        color: "green",
      });
    });

    it("should fetch a project's policies once for the whole pass", async () => {
      // given
      // This is the single largest request saving in the snapshot: policies are
      // configured per project, and the previous design downloaded the identical
      // list once per repository.
      const { collector } = createCollector();
      withSnapshotRoutes();
      const context = snapshotContext();

      // when
      await collector.snapshot(anAzureRepository(server.baseUrl), context);
      await collector.snapshot(
        anAzureRepository(server.baseUrl, { entityRef: "component:default/other" }),
        context,
      );

      // then
      expect(server.requestsFor("/policy/configurations")).toHaveLength(1);
    });

    it("should read badges out of the README", async () => {
      // given
      const { collector } = createCollector();
      withSnapshotRoutes();

      // when
      const result = await collector.snapshot(anAzureRepository(server.baseUrl), snapshotContext());

      // then
      const build = result.payload.badgeStatus?.checks.find(
        (check) => check.label === "Build Status",
      );
      expect(build?.present).toBe(true);
    });

    it("should tolerate a repository with no README", async () => {
      // given
      // A missing README answers 404 and is the common case, not a failure of
      // the snapshot.
      const { collector } = createCollector();
      server
        .onPath("/repositories/gateway", () => ({ body: { id: "guid-1" } }))
        .on("/policy/configurations", () => ({ body: { value: [] } }))
        .on("/build/definitions", () => ({ body: { value: [] } }))
        .on("/refs", () => ({ body: { value: [] } }))
        .on("/build/builds", () => ({ body: { value: [] } }))
        .on("/items", () => ({ status: 404, body: { message: "not found" } }));

      // when
      const result = await collector.snapshot(anAzureRepository(server.baseUrl), snapshotContext());

      // then
      expect(result.payload.badgeStatus).toBeNull();
    });

    it("should scan the repository for documentation and API definitions", async () => {
      // given
      const { collector } = createCollector();
      withSnapshotRoutes();

      // when
      const result = await collector.snapshot(anAzureRepository(server.baseUrl), snapshotContext());

      // then
      expect(result.payload.repositoryFiles).toEqual({
        hasReadme: true,
        hasDocsSource: true,
        apiDefinitionPath: "docs/openapi.yaml",
      });
    });

    it("should list a directory only when the root said it exists", async () => {
      // given
      // The common repository has neither, and paying for two extra listings
      // per repository per day to discover that would be the whole cost of the
      // metric.
      const { collector } = createCollector();
      server
        .onPath("/repositories/gateway", () => ({ body: { id: "guid-1" } }))
        .on("/policy/configurations", () => ({ body: { value: [] } }))
        .on("/build/definitions", () => ({ body: { value: [] } }))
        .on("/refs", () => ({ body: { value: [] } }))
        .on("/build/builds", () => ({ body: { value: [] } }))
        .on("/items", (request) =>
          request.query.get("scopePath") === null
            ? { status: 404, body: { message: "not found" } }
            : { body: { value: [{ path: "/main.go", isFolder: false }] } },
        );

      // when
      const result = await collector.snapshot(anAzureRepository(server.baseUrl), snapshotContext());

      // then
      const listings = server
        .requestsFor("/items")
        .filter((request) => request.query.get("scopePath") !== null);
      expect(listings).toHaveLength(1);
      expect(result.payload.repositoryFiles).toEqual({
        hasReadme: false,
        hasDocsSource: false,
        apiDefinitionPath: null,
      });
    });

    it("should tolerate an empty repository whose listing 404s", async () => {
      // given
      const { collector } = createCollector();
      server
        .onPath("/repositories/gateway", () => ({ body: { id: "guid-1" } }))
        .on("/policy/configurations", () => ({ body: { value: [] } }))
        .on("/build/definitions", () => ({ body: { value: [] } }))
        .on("/refs", () => ({ body: { value: [] } }))
        .on("/build/builds", () => ({ body: { value: [] } }))
        .on("/items", () => ({ status: 404, body: { message: "not found" } }));

      // when
      const result = await collector.snapshot(anAzureRepository(server.baseUrl), snapshotContext());

      // then
      expect(result.payload.repositoryFiles).toEqual({
        hasReadme: false,
        hasDocsSource: false,
        apiDefinitionPath: null,
      });
    });

    it("should not invent a release, because Azure DevOps Repos has none", async () => {
      // given
      const { collector } = createCollector();
      withSnapshotRoutes();

      // when
      const result = await collector.snapshot(anAzureRepository(server.baseUrl), snapshotContext());

      // then
      expect(result.payload.latestRelease).toBeNull();
      expect(result.events).toEqual([]);
    });
  });
});
