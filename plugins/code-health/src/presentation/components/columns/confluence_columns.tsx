import type {
  ConfluenceAnalyticsState,
  ContributorSummary,
  RepositorySummary,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  confluenceStaleShare,
  formatCount,
  formatPercent,
} from "@rios0rios0/backstage-plugin-code-health-common";
import Box from "@material-ui/core/Box";
import Link from "@material-ui/core/Link";
import Tooltip from "@material-ui/core/Tooltip";
import Typography from "@material-ui/core/Typography";
import { makeStyles } from "@material-ui/core/styles";
import HelpOutlineIcon from "@material-ui/icons/HelpOutline";
import type { ColumnDef } from "@tanstack/react-table";
import {
  contributorConfluence,
  repositoryConfluence,
} from "../../../domain/entities/confluence_insights";
import { EmptyCell } from "../empty_cell";

const useStyles = makeStyles((theme) => ({
  help: { fontSize: "0.85rem", opacity: 0.6 },
  header: { display: "inline-flex", alignItems: "center", gap: 4 },
  added: { color: theme.palette.success.main },
  removed: { color: theme.palette.error.main },
  warning: { color: theme.palette.warning.main },
  critical: { color: theme.palette.error.main },
}));

/**
 * A column heading that explains itself.
 *
 * Every Confluence figure here is measured over a trailing window the backend
 * chose rather than the range selected above the table, and half of them can be
 * absent for a reason that has nothing to do with the team. Neither fact is
 * guessable from a two-word heading, and a reader who guesses wrong reads the
 * column backwards.
 *
 * Deliberately a copy of the contributors table's helper rather than an import
 * of it: that one is private to that file, and a column group that reached into
 * it would make the two impossible to change independently.
 */
const HeaderWithHelp = ({ label, help }: { label: string; help: string }) => {
  const classes = useStyles();

  return (
    <Box component="span" className={classes.header}>
      {label}
      <Tooltip title={help}>
        {/* `tabIndex` gives the icon a focus event for MUI to open the tooltip
            on, and `titleAccess` is what carries the text to assistive
            technology — `SvgIcon` stamps `aria-hidden` on any icon without one,
            so an `aria-label` would sit on an element screen readers skip. */}
        <HelpOutlineIcon className={classes.help} titleAccess={help} tabIndex={0} />
      </Tooltip>
    </Box>
  );
};

const WINDOW_NOTE =
  "Measured over the trailing window the backend collects — 90 days by default — " +
  "rather than the range selected above. Confluence reports no per-day history, so " +
  "this figure does not move with the range picker.";

/** A figure, or an em dash when there is nothing to show. */
const Figure = ({
  value,
  caption,
}: {
  value: number | string | null;
  caption?: string;
}) => {
  if (value === null) return <EmptyCell />;

  return (
    <Box>
      <Typography variant="body2">
        {typeof value === "number" ? formatCount(value) : value}
      </Typography>
      {caption === undefined ? null : (
        <Typography variant="caption" color="textSecondary">
          {caption}
        </Typography>
      )}
    </Box>
  );
};

/**
 * Words added, with what was pruned beside it.
 *
 * A component rather than an inline cell body because it needs the stylesheet,
 * and a hook belongs in something React renders as a component.
 */
const WordsCell = ({
  added,
  removed,
}: {
  added: number | null;
  removed: number | null;
}) => {
  const classes = useStyles();
  if (added === null) return <EmptyCell />;

  return (
    <Box>
      <Typography variant="body2">{formatCount(added)}</Typography>
      <Typography variant="caption" color="textSecondary">
        <span className={classes.added}>+{formatCount(added)}</span>
        {" / "}
        <span className={classes.removed}>-{formatCount(removed ?? 0)}</span>
      </Typography>
    </Box>
  );
};

const STALE_WARNING = 10;
const STALE_CRITICAL = 33;

const staleToneOf = (share: number | null): "none" | "warning" | "critical" => {
  if (share === null || share < STALE_WARNING) return "none";
  return share < STALE_CRITICAL ? "warning" : "critical";
};

/** How much of a space has rotted, coloured once it is worth acting on. */
const StaleCell = ({ pages, share }: { pages: number; share: number | null }) => {
  const classes = useStyles();
  const tone = staleToneOf(share);

  return (
    <Box>
      <Typography
        variant="body2"
        component="span"
        className={tone === "none" ? undefined : classes[tone]}
        data-tone={tone}
      >
        {formatCount(pages)}
      </Typography>
      {share === null ? null : (
        <Typography variant="caption" color="textSecondary" component="div">
          {formatPercent(share)} of the space
        </Typography>
      )}
    </Box>
  );
};

const ANALYTICS_REASONS: Readonly<Record<ConfluenceAnalyticsState, string>> = {
  measured: "",
  // The single most common case, and the one worth spelling out: nothing the
  // team does to its wiki will make this number appear.
  unavailable:
    "Confluence refused its analytics API. Page views are a Confluence Cloud Premium " +
    "feature — on a Standard site there is nothing to switch on.",
  "not-measured":
    "This run did not ask for view counts; its analytics allowance went on other pages. " +
    "The next run may report them.",
};

/**
 * Views, or the reason there are none.
 *
 * An em dash on its own would leave a reader wondering whether nobody opened
 * the page or nobody counted, and those have completely different answers.
 */
const ViewsCell = ({
  views,
  analytics,
  pages,
}: {
  views: number | null;
  analytics: ConfluenceAnalyticsState;
  pages: number;
}) => {
  if (views !== null) {
    return (
      <Figure
        value={views}
        caption={`across ${formatCount(pages)} page${pages === 1 ? "" : "s"}`}
      />
    );
  }

  return (
    <Tooltip title={ANALYTICS_REASONS[analytics]}>
      <span>
        <EmptyCell />
      </span>
    </Tooltip>
  );
};

/**
 * The Confluence columns of the contributors table.
 *
 * A factory rather than a constant so nothing is built for a backend with no
 * Confluence configured: the page calls it only when the capability flag is on.
 */
export const confluenceContributorColumns = (): ColumnDef<ContributorSummary>[] => [
  {
    id: "confluencePages",
    accessorFn: (row) => contributorConfluence(row)?.pagesCreated ?? null,
    header: () => (
      <HeaderWithHelp
        label="Wiki pages"
        help={`Pages this person created, and the distinct pages they authored any version of. A page created in the window counts in both. ${WINDOW_NOTE}`}
      />
    ),
    cell: ({ row }) => {
      const metrics = contributorConfluence(row.original);
      return (
        <Figure
          value={metrics === null ? null : metrics.pagesCreated}
          {...(metrics === null
            ? {}
            : { caption: `${formatCount(metrics.pagesEdited)} edited` })}
        />
      );
    },
    enableColumnFilter: false,
  },
  {
    id: "confluenceWords",
    accessorFn: (row) => contributorConfluence(row)?.wordsAdded ?? null,
    header: () => (
      <HeaderWithHelp
        label="Words written"
        help={`Words added to page bodies, from the size of the body either side of each edit. Confluence has no line count and serves no diff between two versions, so words are the unit it can actually be measured in — and a rewrite that kept a paragraph the same length measures as nothing. An em dash means no page of theirs could be measured, not that they wrote nothing. ${WINDOW_NOTE}`}
      />
    ),
    cell: ({ row }) => {
      const metrics = contributorConfluence(row.original);
      return (
        <WordsCell
          added={metrics?.wordsAdded ?? null}
          removed={metrics?.wordsRemoved ?? null}
        />
      );
    },
    enableColumnFilter: false,
  },
  {
    id: "confluenceComments",
    accessorFn: (row) => contributorConfluence(row)?.commentsWritten ?? null,
    header: () => (
      <HeaderWithHelp
        label="Wiki comments"
        help={`Comments this person wrote, inline and footer together. Confluence's search vocabulary has one comment type covering both, and the endpoints that separate them cannot be filtered by date. ${WINDOW_NOTE}`}
      />
    ),
    cell: ({ row }) => {
      const metrics = contributorConfluence(row.original);
      return <Figure value={metrics === null ? null : metrics.commentsWritten} />;
    },
    enableColumnFilter: false,
  },
  {
    id: "confluenceSpaces",
    accessorFn: (row) => contributorConfluence(row)?.spaceKeys.length ?? null,
    header: () => (
      <HeaderWithHelp
        label="Spaces"
        help={`How many spaces this person touched. Someone writing across many spaces is either the person everybody asks, or the only one keeping several teams' documentation alive. ${WINDOW_NOTE}`}
      />
    ),
    cell: ({ row }) => {
      const metrics = contributorConfluence(row.original);
      if (metrics === null) return <EmptyCell />;

      return (
        <Figure
          value={metrics.spaceKeys.length}
          {...(metrics.spaceKeys.length === 0
            ? {}
            : { caption: metrics.spaceKeys.join(", ") })}
        />
      );
    },
    enableColumnFilter: false,
  },
  {
    id: "confluenceViews",
    accessorFn: (row) => contributorConfluence(row)?.pageViews ?? null,
    header: () => (
      <HeaderWithHelp
        label="Page views"
        help={`Views of the pages this person wrote. Confluence's analytics API is a Cloud Premium feature, so on a Standard site this column is empty however much anybody reads. ${WINDOW_NOTE}`}
      />
    ),
    cell: ({ row }) => {
      const metrics = contributorConfluence(row.original);
      if (metrics === null) return <EmptyCell />;

      return (
        <ViewsCell
          views={metrics.pageViews}
          analytics={metrics.analytics}
          pages={metrics.pagesMeasuredForViews}
        />
      );
    },
    enableColumnFilter: false,
  },
];

/** The Confluence columns of the repositories table. */
export const confluenceRepositoryColumns = (): ColumnDef<RepositorySummary>[] => [
  {
    id: "confluenceSpace",
    accessorFn: (row) => repositoryConfluence(row)?.space.key ?? null,
    header: () => (
      <HeaderWithHelp
        label="Space"
        help="The Confluence space this repository's catalog entity names through its `confluence.io/space-key` annotation. A repository with no annotation has no space, and nothing here is guessed from its name."
      />
    ),
    cell: ({ row }) => {
      const metrics = repositoryConfluence(row.original);
      if (metrics === null) return <EmptyCell />;
      const label = metrics.space.name ?? metrics.space.key;

      return metrics.space.url === null ? (
        <Typography variant="body2">{label}</Typography>
      ) : (
        <Link href={metrics.space.url} target="_blank" rel="noopener noreferrer">
          {label}
        </Link>
      );
    },
    filterFn: "includesString",
  },
  {
    id: "confluencePagesTotal",
    accessorFn: (row) => repositoryConfluence(row)?.totalPages ?? null,
    header: () => (
      <HeaderWithHelp
        label="Wiki pages"
        help={`Pages in the space today, with how many of them were written inside the measured window underneath. ${WINDOW_NOTE}`}
      />
    ),
    cell: ({ row }) => {
      const metrics = repositoryConfluence(row.original);
      return (
        <Figure
          value={metrics?.totalPages ?? null}
          {...(metrics === null
            ? {}
            : { caption: `${formatCount(metrics.pagesCreated)} new` })}
        />
      );
    },
    enableColumnFilter: false,
  },
  {
    id: "confluenceStale",
    accessorFn: (row) => repositoryConfluence(row)?.stalePages ?? null,
    header: () => (
      <HeaderWithHelp
        label="Stale pages"
        help="Pages nobody has edited for the configured staleness period — six months by default — as a count and as a share of the space. This is the documentation-rot figure: a space where a third of the pages are stale is one a reader stops trusting."
      />
    ),
    cell: ({ row }) => {
      const metrics = repositoryConfluence(row.original);
      if (metrics === null || metrics.stalePages === null) return <EmptyCell />;

      return (
        <StaleCell pages={metrics.stalePages} share={confluenceStaleShare(metrics)} />
      );
    },
    enableColumnFilter: false,
  },
  {
    id: "confluenceLastEdit",
    accessorFn: (row) => repositoryConfluence(row)?.lastActivityAt ?? null,
    header: () => (
      <HeaderWithHelp
        label="Last wiki edit"
        help="When anything in the space was last touched. A space whose newest edit predates the measured window is one nobody is maintaining at all."
      />
    ),
    cell: ({ row }) => {
      const metrics = repositoryConfluence(row.original);
      return <Figure value={metrics?.lastActivityAt?.slice(0, 10) ?? null} />;
    },
    enableColumnFilter: false,
  },
];
