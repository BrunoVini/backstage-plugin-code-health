import type { HttpAuthService, SchedulerService } from "@backstage/backend-plugin-api";
import { InputError, NotAllowedError, NotFoundError } from "@backstage/errors";
import {
  CODE_HEALTH_API_VERSION,
  isExclusionReason,
  isIdentitySource,
  isTimeSeriesBucket,
  type IdentitySource,
  type IntegrationCapabilities,
  type TimeSeriesBucket,
} from "@rios0rios0/backstage-plugin-code-health-common";
import express from "express";
import Router from "express-promise-router";
import { z } from "zod";
import type { AuthorizeAdministrator } from "../../domain/commands/authorize_administrator";
import type { ExcludeIdentity } from "../../domain/commands/exclude_identity";
import type { GetContributorTrend } from "../../domain/commands/get_contributor_trend";
import type { GetRepositoryTimeSeries } from "../../domain/commands/get_repository_time_series";
import type { GetRepositoryTrend } from "../../domain/commands/get_repository_trend";
import {
  MalformedEntityRefError,
  NotAUserReferenceError,
  UnknownIdentityError,
  UnknownUserError,
  type LinkIdentity,
} from "../../domain/commands/link_identity";
import type { ListContributorSummaries } from "../../domain/commands/list_contributor_summaries";
import {
  MAX_DIRECTORY_SEARCH_HITS,
  type ListDirectoryUsers,
} from "../../domain/commands/list_directory_users";
import type { ListIdentities } from "../../domain/commands/list_identities";
import type { ListOwnedRepositories } from "../../domain/commands/list_owned_repositories";
import type { ListRepositorySummaries } from "../../domain/commands/list_repository_summaries";
import type { ResetIngestion } from "../../domain/commands/reset_ingestion";
import type { CodeHealthStore } from "../../domain/repositories/code_health_store";

/** Asked for nothing in particular, the dashboard gets the last day. */
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A year of daily buckets is already more than any chart renders usefully. */
const MAX_WINDOW_MS = 400 * 24 * 60 * 60 * 1000;

const windowSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

const parseInstant = (value: string, field: string): Date => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new InputError(`\`${field}\` is not a valid ISO 8601 instant`);
  }
  return parsed;
};

/**
 * Reads the requested window, defaulting to the last day.
 *
 * The window is bounded rather than trusted: an unbounded `from` would make one
 * request scan the entire event table, which is a denial of service any
 * authenticated user could trigger by editing a URL.
 */
const readWindow = (query: unknown): { from: Date; to: Date } => {
  const parsed = windowSchema.safeParse(query);
  if (!parsed.success) throw new InputError(parsed.error.message);

  const to = parsed.data.to ? parseInstant(parsed.data.to, "to") : new Date();
  const from = parsed.data.from
    ? parseInstant(parsed.data.from, "from")
    : new Date(to.getTime() - DEFAULT_WINDOW_MS);

  if (from >= to) throw new InputError("`from` must be earlier than `to`");
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) {
    throw new InputError("the requested window is longer than the retention period");
  }

  return { from, to };
};

const readBucket = (value: unknown): TimeSeriesBucket => {
  if (value === undefined) return "day";
  if (typeof value !== "string" || !isTimeSeriesBucket(value)) {
    throw new InputError("`bucket` must be one of day, week or month");
  }
  return value;
};

const linkSchema = z.object({
  source: z.string(),
  sourceKey: z.string().min(1),
  entityRef: z.string().min(1),
});

const exclusionSchema = z.object({
  source: z.string(),
  sourceKey: z.string().min(1),
  reason: z.string().min(1),
});

/**
 * What a directory search asks for: the text, and how many answers at most.
 *
 * `q` may be empty — the screen asks for nothing while the field is empty,
 * and the command answers with nobody rather than the whole directory. The
 * limit is bounded so a URL cannot turn a search into a listing.
 */
const directorySearchSchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_DIRECTORY_SEARCH_HITS).optional(),
});

/**
 * How far back a reset reaches.
 *
 * A whole number of days, at least one — the walk is keyed by day, so half a
 * day is not a thing it can be asked for. The upper bound is the configured
 * retention and is checked in the route, where that number is known.
 */
const resetSchema = z.object({
  days: z.number().int().min(1),
});

/**
 * Reads the `source` query parameter, which narrows the Identities screen to
 * one system. An unrecognised value is rejected rather than ignored: silently
 * returning every source would look like a filter that does not work.
 */
const readSources = (value: unknown): readonly IdentitySource[] | undefined => {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  const sources = values.filter(isIdentitySource);
  if (sources.length !== values.length) {
    throw new InputError("`source` must be one of vcs, wakatime, jira or confluence");
  }
  return sources;
};

/**
 * Turns the linking command's own refusals into HTTP.
 *
 * The command throws plain domain errors so it stays testable without a web
 * framework; mapping them lives here, where the transport does.
 */
const asHttpError = (error: unknown): unknown => {
  // A reference that cannot be parsed is a bad request; one that parses but
  // names nobody is a missing thing. Collapsing the two would tell somebody who
  // typed a bare name to go and look for a user that was never asked for.
  if (error instanceof MalformedEntityRefError || error instanceof NotAUserReferenceError) {
    return new InputError(error.message);
  }
  if (error instanceof UnknownIdentityError || error instanceof UnknownUserError) {
    return new NotFoundError(error.message);
  }
  return error;
};

/**
 * Reads a `true`/`false` query parameter that narrows the Identities screen.
 *
 * Absent means "do not narrow at all", which is a third answer rather than a
 * default of false: the screen has to be able to ask for every account, for the
 * ones with a link and for the ones without, and a missing parameter read as
 * false would make the first of those impossible to express.
 */
const readFlag = (value: unknown, field: string): boolean | undefined => {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new InputError(`\`${field}\` must be true or false`);
};

export interface CodeHealthRouterOptions {
  readonly store: CodeHealthStore;
  readonly httpAuth: HttpAuthService;
  readonly scheduler: SchedulerService;
  readonly repositories: ListRepositorySummaries;
  readonly contributors: ListContributorSummaries;
  readonly timeSeries: GetRepositoryTimeSeries;
  readonly contributorTrend: GetContributorTrend;
  readonly repositoryTrend: GetRepositoryTrend;
  readonly owned: ListOwnedRepositories;
  readonly identities: ListIdentities;
  readonly directoryUsers: ListDirectoryUsers;
  readonly links: LinkIdentity;
  readonly exclusions: ExcludeIdentity;
  readonly access: AuthorizeAdministrator;
  readonly reset: ResetIngestion;
  /** The furthest back a reset may be asked to reach. */
  readonly retentionDays: number;
  readonly capabilities: IntegrationCapabilities;
  readonly refreshableTaskIds: readonly string[];
  /** Triggered after a reset, and by the refresh route. */
  readonly ingestionTaskId: string;
}

/**
 * The read side of the plugin, mounted at `/api/code-health`.
 *
 * Every route serves from the database. The browser never reaches a version
 * control provider, so a dashboard load costs the same whether ten people or a
 * thousand are looking at it, and whether the catalog holds ten repositories or
 * a thousand.
 */
export const createCodeHealthRouter = (options: CodeHealthRouterOptions): express.Router => {
  const router = Router();
  const version = CODE_HEALTH_API_VERSION;
  router.use(express.json());

  router.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  // Asked once before anything is drawn, so a column for a switched-off
  // integration is never built rather than being built and left empty.
  router.get(`/${version}/capabilities`, (_request, response) => {
    response.json({ integrations: options.capabilities });
  });

  router.get(`/${version}/identities`, async (request, response) => {
    const sources = readSources(request.query.source);
    const linked = readFlag(request.query.linked, "linked");
    const excluded = readFlag(request.query.excluded, "excluded");

    response.json({
      items: await options.identities.run({
        ...(sources === undefined ? {} : { sources }),
        ...(linked === undefined ? {} : { linked }),
        ...(excluded === undefined ? {} : { excluded }),
      }),
    });
  });

  /**
   * The catalog users matching what somebody typed into the link field.
   *
   * A signed-in user, like every write on this screen: the answer is a slice
   * of the organisation's directory, and it is asked for by the person about
   * to make a link, never by a service.
   */
  router.get(`/${version}/identities/users`, async (request, response) => {
    await options.httpAuth.credentials(request, { allow: ["user"] });

    const parsed = directorySearchSchema.safeParse(request.query);
    if (!parsed.success) throw new InputError(parsed.error.message);

    response.json({
      items: await options.directoryUsers.run({
        query: parsed.data.q ?? "",
        ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
      }),
    });
  });

  /**
   * Attaches an account to a catalog user.
   *
   * `PUT` rather than `POST` because it is idempotent: an account has at most
   * one link, and linking the same pair twice has to mean the same thing as
   * linking it once.
   */
  router.put(`/${version}/identities/links`, async (request, response) => {
    // A signed-in user, not a service. A manual link is a human's statement
    // that two accounts are the same person, and it outranks everything the
    // plugin infers — so who made it is recorded, and a service account cannot.
    const credentials = await options.httpAuth.credentials(request, { allow: ["user"] });

    const parsed = linkSchema.safeParse(request.body);
    if (!parsed.success) throw new InputError(parsed.error.message);
    if (!isIdentitySource(parsed.data.source)) {
      throw new InputError("`source` must be one of vcs, wakatime, jira or confluence");
    }

    try {
      await options.links.link({
        source: parsed.data.source,
        sourceKey: parsed.data.sourceKey,
        entityRef: parsed.data.entityRef,
        linkedBy: credentials.principal.userEntityRef,
        now: new Date(),
      });
    } catch (error) {
      throw asHttpError(error);
    }

    response.status(204).end();
  });

  router.delete(
    `/${version}/identities/links/:source/:sourceKey`,
    async (request, response) => {
      await options.httpAuth.credentials(request, { allow: ["user"] });

      const { source, sourceKey } = request.params;
      if (!isIdentitySource(source)) {
        throw new InputError("`source` must be one of vcs, wakatime, jira or confluence");
      }

      await options.links.unlink({ source, sourceKey });
      response.status(204).end();
    },
  );

  /**
   * Takes an account out of every measurement the plugin makes.
   *
   * `PUT` for the same reason the link route is: an account has at most one
   * exclusion, and excluding it twice has to mean what excluding it once meant.
   * Re-sending it with a different reason is a correction, not a second
   * exclusion.
   */
  router.put(`/${version}/identities/exclusions`, async (request, response) => {
    // A signed-in user, not a service. This is the one write that makes rows
    // disappear from every table in the plugin, and the only thing that makes
    // that reviewable later is a name beside the reason.
    const credentials = await options.httpAuth.credentials(request, { allow: ["user"] });

    const parsed = exclusionSchema.safeParse(request.body);
    if (!parsed.success) throw new InputError(parsed.error.message);
    if (!isIdentitySource(parsed.data.source)) {
      throw new InputError("`source` must be one of vcs, wakatime, jira or confluence");
    }
    if (!isExclusionReason(parsed.data.reason)) {
      throw new InputError(
        "`reason` must be one of former-contributor, open-source-contributor, automated-bot or service-account",
      );
    }

    try {
      await options.exclusions.exclude({
        source: parsed.data.source,
        sourceKey: parsed.data.sourceKey,
        reason: parsed.data.reason,
        excludedBy: credentials.principal.userEntityRef,
        now: new Date(),
      });
    } catch (error) {
      throw asHttpError(error);
    }

    response.status(204).end();
  });

  router.delete(
    `/${version}/identities/exclusions/:source/:sourceKey`,
    async (request, response) => {
      await options.httpAuth.credentials(request, { allow: ["user"] });

      const { source, sourceKey } = request.params;
      if (!isIdentitySource(source)) {
        throw new InputError("`source` must be one of vcs, wakatime, jira or confluence");
      }

      await options.exclusions.include({ source, sourceKey });
      response.status(204).end();
    },
  );

  router.get(`/${version}/coverage`, async (_request, response) => {
    const counts = await options.store.getCoverage();

    const percent =
      counts.expectedDays === 0
        ? 0
        : Math.round((counts.ingestedDays / counts.expectedDays) * 1000) / 10;

    response.json({
      earliestDay: counts.earliestDay,
      latestDay: counts.latestDay,
      lastIngestedAt: counts.lastIngestedAt?.toISOString() ?? null,
      freshUntil: counts.freshUntil?.toISOString() ?? null,
      backfill: {
        repositories: counts.repositories,
        complete: counts.complete,
        pendingDays: Math.max(0, counts.expectedDays - counts.ingestedDays),
        ingestedDays: counts.ingestedDays,
        percent,
        failing: counts.failing,
      },
    });
  });

  router.get(`/${version}/repositories`, async (request, response) => {
    const window = readWindow(request.query);
    response.json({
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      items: await options.repositories.run(window),
    });
  });

  // Fleet-wide cadence. Registered before the per-repository route so the
  // literal path is not swallowed by `:id`.
  router.get(`/${version}/timeseries`, async (request, response) => {
    const window = readWindow(request.query);
    const bucket = readBucket(request.query.bucket);

    response.json({
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      bucket,
      points: await options.timeSeries.run({ ...window, bucket }),
    });
  });

  router.get(`/${version}/repositories/:id/timeseries`, async (request, response) => {
    const window = readWindow(request.query);
    const bucket = readBucket(request.query.bucket);

    const tracked = await options.store.getTrackedRepository(request.params.id);
    if (!tracked) throw new NotFoundError(`no repository with id ${request.params.id}`);

    response.json({
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      bucket,
      points: await options.timeSeries.run({
        repositoryId: request.params.id,
        ...window,
        bucket,
      }),
    });
  });

  router.get(`/${version}/repositories/:id/trend`, async (request, response) => {
    const window = readWindow(request.query);
    const bucket = readBucket(request.query.bucket);

    const tracked = await options.store.getTrackedRepository(request.params.id);
    if (!tracked) throw new NotFoundError(`no repository with id ${request.params.id}`);

    const trend = await options.repositoryTrend.run({
      repositoryId: request.params.id,
      ...window,
      bucket,
    });

    response.json({
      id: request.params.id,
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      bucket,
      ...trend,
    });
  });

  router.get(`/${version}/contributors`, async (request, response) => {
    const window = readWindow(request.query);
    const repositoryId = request.query.repositoryId;
    if (repositoryId !== undefined && typeof repositoryId !== "string") {
      throw new InputError("`repositoryId` must be a single value");
    }

    response.json({
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      items: await options.contributors.run({
        ...window,
        ...(repositoryId === undefined ? {} : { repositoryId }),
      }),
    });
  });

  /**
   * One person's history, bucketed.
   *
   * The key arrives percent-encoded, because a linked person's key is an entity
   * reference and carries both a colon and a slash; Express decodes the
   * parameter before this sees it, so the route reads it verbatim.
   */
  router.get(`/${version}/contributors/:key/trend`, async (request, response) => {
    const window = readWindow(request.query);
    const bucket = readBucket(request.query.bucket);

    const trend = await options.contributorTrend.run({
      key: request.params.key,
      ...window,
      bucket,
    });

    response.json({
      key: request.params.key,
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      bucket,
      ...trend,
    });
  });

  // The repositories a person is responsible for, which is `spec.owner` rather
  // than where they committed.
  router.get(`/${version}/contributors/:key/repositories`, async (request, response) => {
    const window = readWindow(request.query);

    response.json({
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      ...(await options.owned.run({ key: request.params.key, ...window })),
    });
  });

  /**
   * What the caller may do beyond reading.
   *
   * Never a 403: a dashboard asks this before it decides whether to draw a
   * button, and refusing to answer would make "you are not an administrator"
   * indistinguishable from "the backend is broken". A service principal and an
   * anonymous decision both read as false.
   */
  router.get(`/${version}/access`, async (request, response) => {
    const credentials = await options.httpAuth.credentials(request);

    response.json({
      canResetIngestion: await options.access.isAdministrator(credentials),
      retentionDays: options.retentionDays,
    });
  });

  router.post(`/${version}/ingestion/reset`, async (request, response) => {
    const credentials = await options.httpAuth.credentials(request);
    if (!(await options.access.isAdministrator(credentials))) {
      throw new NotAllowedError("only a Code Health administrator may reset the ingestion");
    }

    const parsed = resetSchema.safeParse(request.body);
    if (!parsed.success) throw new InputError(parsed.error.message);
    // Bounded by the retention rather than trusted: reaching further back than
    // the read API will ever answer for spends a day of provider requests on
    // history no window can ask about.
    if (parsed.data.days > options.retentionDays) {
      throw new InputError(
        `\`days\` must not exceed the configured retention of ${options.retentionDays} days`,
      );
    }

    const result = await options.reset.run({ days: parsed.data.days, now: new Date() });

    const triggered: string[] = [];
    try {
      await options.scheduler.triggerTask(options.ingestionTaskId);
      triggered.push(options.ingestionTaskId);
    } catch {
      // Already running, which is a perfectly good answer to "start again now":
      // the run in flight reads the cursors this just moved.
    }

    response.json({ repositories: result.repositories, days: parsed.data.days, triggered });
  });

  router.post(`/${version}/refresh`, async (request, response) => {
    // A signed-in user, not a service: this exists so someone looking at stale
    // numbers can ask for a run, and attributing that to a person is the point.
    await options.httpAuth.credentials(request, { allow: ["user"] });

    const triggered: string[] = [];
    for (const id of options.refreshableTaskIds) {
      try {
        await options.scheduler.triggerTask(id);
        triggered.push(id);
      } catch {
        // `triggerTask` throws when the task is already running, which is a
        // perfectly good answer to "refresh now" and not worth surfacing as a
        // failure.
      }
    }

    response.json({ triggered });
  });

  return router;
};
