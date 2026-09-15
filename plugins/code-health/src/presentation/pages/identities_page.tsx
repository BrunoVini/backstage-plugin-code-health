import { ContentHeader, InfoCard, Progress, WarningPanel } from "@backstage/core-components";
import Avatar from "@material-ui/core/Avatar";
import Box from "@material-ui/core/Box";
import Chip from "@material-ui/core/Chip";
import FormControlLabel from "@material-ui/core/FormControlLabel";
import Paper from "@material-ui/core/Paper";
import Switch from "@material-ui/core/Switch";
import Table from "@material-ui/core/Table";
import TableBody from "@material-ui/core/TableBody";
import TableCell from "@material-ui/core/TableCell";
import TableContainer from "@material-ui/core/TableContainer";
import TableHead from "@material-ui/core/TableHead";
import TableRow from "@material-ui/core/TableRow";
import TextField from "@material-ui/core/TextField";
import Typography from "@material-ui/core/Typography";
import { makeStyles } from "@material-ui/core/styles";
import type {
  IdentityRow,
  IdentitySource,
  IntegrationCapabilities,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  IDENTITY_SOURCE_LABELS,
  isIdentitySource,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { useMemo, useState } from "react";
import type { IdentityService } from "../../domain/services/dashboard_service";
import { IdentityExclusionCell } from "../components/identity_exclusion_cell";
import { IdentityLinkCell } from "../components/identity_link_cell";
import { useIdentities } from "../hooks/use_identities";

const useStyles = makeStyles((theme) => ({
  avatar: { width: 24, height: 24, fontSize: "0.7rem" },
  account: { display: "flex", alignItems: "center", gap: theme.spacing(1) },
  headerCell: {
    whiteSpace: "nowrap",
    textTransform: "uppercase",
    fontSize: theme.typography.pxToRem(11),
    letterSpacing: "0.05em",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing(2),
    marginBottom: theme.spacing(2),
  },
  filter: { minWidth: 180 },
  excludedRow: { opacity: 0.6 },
}));

export interface IdentitiesPageProps {
  readonly identityService: IdentityService;
  readonly capabilities: IntegrationCapabilities;
}

/**
 * Which sources are worth offering as a filter.
 *
 * Version control is always there — it is where commit authors come from and it
 * is not optional. The rest appear only when their integration is configured,
 * because a filter that can only ever return nothing is a filter that looks
 * broken.
 */
const filterableSources = (capabilities: IntegrationCapabilities): IdentitySource[] => [
  "vcs",
  ...(capabilities.wakatime ? (["wakatime"] as const) : []),
  ...(capabilities.jira ? (["jira"] as const) : []),
  ...(capabilities.confluence ? (["confluence"] as const) : []),
];

/**
 * The three answers the measurement filter can give.
 *
 * "All" is a third state rather than the absence of the other two: the screen
 * has to be able to ask for everything, and a two-way switch could only ever
 * hide one half or the other.
 */
type MeasurementFilter = "" | "measured" | "excluded";

const excludedFlagOf = (filter: MeasurementFilter): boolean | undefined => {
  if (filter === "excluded") return true;
  if (filter === "measured") return false;
  return undefined;
};

const isMeasurementFilter = (value: string): value is MeasurementFilter =>
  value === "" || value === "measured" || value === "excluded";

const initials = (value: string): string =>
  value
    .replace(/@.*$/u, "")
    .split(/[\s._-]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");

const AccountCell = ({ row }: { row: IdentityRow }) => {
  const classes = useStyles();
  const { identity } = row;
  const name = identity.displayName ?? identity.sourceKey;

  return (
    <Box className={classes.account}>
      <Avatar src={identity.avatarUrl ?? undefined} alt="" className={classes.avatar}>
        {initials(name)}
      </Avatar>
      <Box>
        <Typography variant="body2">{name}</Typography>
        <Typography variant="caption" color="textSecondary">
          {identity.sourceKey}
          {identity.email === null || identity.email === identity.sourceKey
            ? ""
            : ` · ${identity.email}`}
        </Typography>
      </Box>
    </Box>
  );
};

/**
 * One person, one row — the screen that makes that true, and the screen that
 * decides which rows are people at all.
 *
 * The plugin measures four systems that each identify people differently: a
 * commit author e-mail or a GitHub login, a WakaTime username, an Atlassian
 * account id. Nothing joins those automatically except a shared e-mail address,
 * and outside a tidy directory that covers perhaps half of them. Everything
 * else is a judgement — is `friosrios` the same person as `Felipe Rios`? — and
 * a judgement made by a heuristic is a merge nobody asked for and nobody can
 * see. So the heuristic ranks, and a person decides.
 *
 * The other half of the screen is the accounts that are not people being
 * measured: the build service a platform performs merges as, the bot that opens
 * dependency pull requests, an outside contributor to a public repository,
 * somebody who left. Excluding one takes it out of every figure the plugin
 * reports — including the fleet reference everybody's output is scored against,
 * which is where an automation merging two hundred pull requests a month does
 * the most damage.
 *
 * Both decisions are stored, and every window the plugin has ever collected is
 * re-read through them: correcting a link or including an account again today
 * fixes last March's numbers too, because both are applied when the row is
 * built rather than when the measurement was taken.
 */
/**
 * Deliberately without the `enabled` gate the other tabs carry. Theirs exists
 * because they cannot pick a window until the coverage probe answers; this
 * screen asks about accounts rather than about a period, so there is nothing to
 * wait for.
 */
export const IdentitiesPage = ({
  identityService,
  capabilities,
}: IdentitiesPageProps) => {
  const classes = useStyles();
  const [source, setSource] = useState<IdentitySource | "">("");
  // On by default. A fleet's accounts are overwhelmingly already linked, and
  // the only work this screen exists for is the ones that are not — opening it
  // on the full list means scrolling past ninety rows that need nothing to
  // reach the nine that do.
  const [unlinkedOnly, setUnlinkedOnly] = useState(true);
  const [measurement, setMeasurement] = useState<MeasurementFilter>("");

  const excluded = excludedFlagOf(measurement);

  const filter = useMemo(
    () => ({
      ...(source === "" ? {} : { sources: [source] }),
      ...(unlinkedOnly ? { linked: false } : {}),
      ...(excluded === undefined ? {} : { excluded }),
    }),
    [source, unlinkedOnly, excluded],
  );

  const { identities, isLoading, error, writeError, link, unlink, exclude, include } =
    useIdentities(identityService, filter);

  const sources = filterableSources(capabilities);
  const unlinkedCount = identities.filter((row) => row.link === null).length;
  const excludedCount = identities.filter((row) => row.exclusion !== null).length;

  return (
    <>
      <ContentHeader title="Identities" />

      <Box mb={2}>
        <InfoCard title="Why this exists">
          <Typography variant="body2">
            Every system here identifies people differently — a commit author address or a
            login, a WakaTime username, an Atlassian account id — and only a shared e-mail
            address joins any two of them on its own. Linking an account to a catalog user
            puts its numbers on that person&apos;s row everywhere in the plugin, including
            for windows that were collected before the link was made.
          </Typography>
          <Box mt={1}>
            <Typography variant="caption" color="textSecondary">
              An account whose address already matches a catalog user is linked automatically.
              Nothing is ever merged on a name resemblance alone: two people who share a
              surname would silently become one contributor, and a merge nobody asked for is
              far harder to notice than a row that stayed separate.
            </Typography>
          </Box>
          <Box mt={1}>
            <Typography variant="caption" color="textSecondary">
              Not every account is a person being measured. Excluding one — a build service,
              a bot, an outside contributor, somebody who has left — takes it out of every
              figure the plugin reports, the fleet totals everybody&apos;s output is scored
              against included. Nothing is deleted, so measuring it again restores every
              window that was ever collected.
            </Typography>
          </Box>
        </InfoCard>
      </Box>

      <Box className={classes.toolbar}>
        <TextField
          select
          size="small"
          label="Source"
          className={classes.filter}
          value={source}
          onChange={(event) => {
            const value = event.target.value;
            setSource(isIdentitySource(value) ? value : "");
          }}
          SelectProps={{ native: true }}
          // A native select always renders whichever option is current, so its
          // label has to be shrunk unconditionally. Left to decide for itself,
          // Material UI reads the empty value of "All sources" as an empty
          // field and draws the label across the option text.
          InputLabelProps={{ shrink: true }}
          inputProps={{ "aria-label": "Filter by source" }}
        >
          <option value="">All sources</option>
          {sources.map((candidate) => (
            <option key={candidate} value={candidate}>
              {IDENTITY_SOURCE_LABELS[candidate]}
            </option>
          ))}
        </TextField>

        <TextField
          select
          size="small"
          label="Measurement"
          className={classes.filter}
          value={measurement}
          onChange={(event) => {
            const value = event.target.value;
            setMeasurement(isMeasurementFilter(value) ? value : "");
          }}
          SelectProps={{ native: true }}
          InputLabelProps={{ shrink: true }}
          inputProps={{ "aria-label": "Filter by measurement" }}
        >
          <option value="">Measured and excluded</option>
          <option value="measured">Measured only</option>
          <option value="excluded">Excluded only</option>
        </TextField>

        <FormControlLabel
          control={
            <Switch
              checked={unlinkedOnly}
              onChange={(event) => setUnlinkedOnly(event.target.checked)}
              color="primary"
            />
          }
          label="Only accounts nobody has linked"
        />

        <Typography variant="body2" color="textSecondary">
          {identities.length} listed · {unlinkedCount} unlinked · {excludedCount} excluded
        </Typography>
      </Box>

      {error === null ? null : (
        <Box mb={2}>
          <WarningPanel severity="error" title="Failed to load identities" message={error} />
        </Box>
      )}

      {writeError === null ? null : (
        <Box mb={2}>
          <WarningPanel severity="error" title="That change was not saved" message={writeError} />
        </Box>
      )}

      {isLoading && identities.length === 0 ? <Progress /> : null}

      {!isLoading && identities.length === 0 && error === null ? (
        <WarningPanel
          severity="info"
          title="No accounts to show"
          message="Accounts are recorded as the background tasks meet them, so this fills in once ingestion has run for the first time. If it has, widen the filters above — the listing starts on the accounts nobody has linked."
        />
      ) : null}

      {identities.length === 0 ? null : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell className={classes.headerCell}>Account</TableCell>
                <TableCell className={classes.headerCell}>Source</TableCell>
                <TableCell className={classes.headerCell}>Person</TableCell>
                <TableCell className={classes.headerCell}>Measurement</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {identities.map((row) => (
                <TableRow
                  key={`${row.identity.source}:${row.identity.sourceKey}`}
                  hover
                  // Dimmed rather than hidden: the row is what somebody reads to
                  // find out an account was excluded on purpose, and it is the
                  // only place the decision can be undone.
                  className={row.exclusion === null ? undefined : classes.excludedRow}
                >
                  <TableCell>
                    <AccountCell row={row} />
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      variant="outlined"
                      label={IDENTITY_SOURCE_LABELS[row.identity.source]}
                    />
                  </TableCell>
                  <TableCell>
                    <IdentityLinkCell
                      row={row}
                      isBusy={isLoading}
                      onLink={(entityRef) =>
                        void link({
                          source: row.identity.source,
                          sourceKey: row.identity.sourceKey,
                          entityRef,
                        })
                      }
                      onUnlink={() =>
                        void unlink({
                          source: row.identity.source,
                          sourceKey: row.identity.sourceKey,
                        })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <IdentityExclusionCell
                      row={row}
                      isBusy={isLoading}
                      onExclude={(reason) =>
                        void exclude({
                          source: row.identity.source,
                          sourceKey: row.identity.sourceKey,
                          reason,
                        })
                      }
                      onInclude={() =>
                        void include({
                          source: row.identity.source,
                          sourceKey: row.identity.sourceKey,
                        })
                      }
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </>
  );
};
