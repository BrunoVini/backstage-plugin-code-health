import Avatar from "@material-ui/core/Avatar";
import Box from "@material-ui/core/Box";
import Button from "@material-ui/core/Button";
import Chip from "@material-ui/core/Chip";
import CircularProgress from "@material-ui/core/CircularProgress";
import Link from "@material-ui/core/Link";
import TextField from "@material-ui/core/TextField";
import Tooltip from "@material-ui/core/Tooltip";
import Typography from "@material-ui/core/Typography";
import { makeStyles } from "@material-ui/core/styles";
import Autocomplete from "@material-ui/lab/Autocomplete";
import type {
  DirectoryUser,
  IdentityRow,
} from "@rios0rios0/backstage-plugin-code-health-common";
import {
  catalogEntityPath,
  parseEntityRef,
} from "@rios0rios0/backstage-plugin-code-health-common";
import { useCallback, useMemo, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import {
  DIRECTORY_SEARCH_MIN_LENGTH,
  useDirectorySearch,
} from "../hooks/use_directory_search";

const useStyles = makeStyles((theme) => ({
  suggestions: { display: "flex", flexWrap: "wrap", gap: theme.spacing(0.5) },
  manual: { display: "flex", alignItems: "flex-start", gap: theme.spacing(1), marginTop: theme.spacing(1) },
  input: { minWidth: 300 },
  origin: { color: theme.palette.text.secondary },
  option: { display: "flex", alignItems: "center", gap: theme.spacing(1), minWidth: 0 },
  optionAvatar: { width: 24, height: 24, fontSize: "0.7rem" },
  optionText: { minWidth: 0 },
  optionDetail: { display: "block", color: theme.palette.text.secondary },
}));

/** Where the picker offers an option from, which is also its heading. */
type PickerGroup = "Likely matches" | "Directory";

interface PickerOption {
  readonly user: DirectoryUser;
  readonly group: PickerGroup;
  /** Why the plugin thinks so, for a likely match; nothing for a search hit. */
  readonly reason: string | null;
}

/** Up to two initials, from a display name or an e-mail-shaped slug. */
const initialsOf = (name: string): string =>
  name
    .replace(/@.*$/u, "")
    .split(/[\s._-]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");

const labelOf = (option: PickerOption | string): string =>
  typeof option === "string" ? option : (option.user.displayName ?? option.user.entityRef);

const OptionRow = ({ option }: { option: PickerOption }) => {
  const classes = useStyles();
  const name = option.user.displayName ?? option.user.entityRef;
  const detail = [option.user.entityRef, option.user.email, option.reason]
    .filter((part): part is string => part !== null && part !== name)
    .join(" · ");

  return (
    <Box className={classes.option}>
      <Avatar src={option.user.picture ?? undefined} alt="" className={classes.optionAvatar}>
        {initialsOf(name)}
      </Avatar>
      <Box className={classes.optionText}>
        <Typography variant="body2" noWrap>
          {name}
        </Typography>
        <Typography variant="caption" noWrap className={classes.optionDetail}>
          {detail}
        </Typography>
      </Box>
    </Box>
  );
};

export interface IdentityLinkCellProps {
  readonly row: IdentityRow;
  readonly onLink: (entityRef: string) => void;
  readonly onUnlink: () => void;
  readonly isBusy: boolean;
  /** The directory search the picker asks once the typing pauses. */
  readonly searchUsers: (query: string) => Promise<readonly DirectoryUser[]>;
}

/**
 * The half of a row where a person says who an account belongs to.
 *
 * Suggestions come first and are one click, because the ranked match is right
 * the overwhelming majority of the time and the whole point of the screen is
 * that linking a fleet's worth of accounts should not take an afternoon.
 *
 * Behind them is a picker rather than a bare field. It opens on the same
 * likely matches, and as somebody types it searches the directory for the
 * name, the address or the entity name — so `fel` finds Felipe Rios and one
 * click fills the field with a reference nobody had to spell. The field still
 * accepts a reference typed or pasted whole, because that is what the backend
 * validates against and a picker that could only pick would have nothing to
 * offer for a person the search cannot find. The button enables only once
 * there is something linkable to send: a picked user, or text that parses as
 * a reference. A name typed on its own is not one, and sending it would only
 * come back as a refusal the reader could not act on.
 */
export const IdentityLinkCell = ({
  row,
  onLink,
  onUnlink,
  isBusy,
  searchUsers,
}: IdentityLinkCellProps) => {
  const classes = useStyles();
  const [inputValue, setInputValue] = useState("");
  const [picked, setPicked] = useState<DirectoryUser | null>(null);
  const search = useDirectorySearch(searchUsers, inputValue);

  const options = useMemo<PickerOption[]>(() => {
    const suggested = row.suggestions.map<PickerOption>((suggestion) => ({
      user: suggestion,
      group: "Likely matches",
      reason: suggestion.reason,
    }));
    const known = new Set(suggested.map((option) => option.user.entityRef));
    const found = search.users
      .filter((user) => !known.has(user.entityRef))
      .map<PickerOption>((user) => ({ user, group: "Directory", reason: null }));
    return [...suggested, ...found];
  }, [row.suggestions, search.users]);

  // What pressing the button would send: the picked user's own reference, or
  // whatever was typed once it is a reference at all.
  const typed = inputValue.trim();
  const target = picked?.entityRef ?? (parseEntityRef(typed) === null ? null : typed);

  // Said under the field rather than only in the popup, because a row that
  // carries likely matches always has something to list there — and a reader
  // who typed a name the directory does not hold would otherwise be shown the
  // likely matches and left to guess whether anything was searched at all.
  const searchNote = (() => {
    if (search.error !== null) return `The directory could not be searched: ${search.error}`;
    if (typed.length < DIRECTORY_SEARCH_MIN_LENGTH) return null;
    if (search.isSearching || search.users.length > 0) return null;
    return "Nobody in the directory matches that.";
  })();

  const noOptionsText =
    searchNote ?? "Type a name, an address or a user reference to search the directory.";

  const handleLink = useCallback(() => {
    if (target === null) return;
    onLink(target);
  }, [onLink, target]);

  if (row.link !== null) {
    const path = catalogEntityPath(row.link.entityRef);

    return (
      <Box>
        <Typography variant="body2">
          {path === null ? (
            row.link.entityRef
          ) : (
            <Link component={RouterLink} to={path} title="Open in the catalog">
              {row.link.entityRef}
            </Link>
          )}
        </Typography>
        <Box display="flex" alignItems="center" gridGap={8}>
          <Typography variant="caption" className={classes.origin}>
            {row.link.origin === "manual"
              ? `linked by ${row.link.linkedBy ?? "a person"}`
              : "matched on the e-mail address"}
          </Typography>
          <Button size="small" onClick={onUnlink} disabled={isBusy}>
            Unlink
          </Button>
        </Box>
      </Box>
    );
  }

  return (
    <Box>
      {row.suggestions.length === 0 ? (
        <Typography variant="caption" color="textSecondary">
          Nothing in the catalog resembles this account.
        </Typography>
      ) : (
        <Box className={classes.suggestions}>
          {row.suggestions.map((suggestion) => (
            <Tooltip
              key={suggestion.entityRef}
              title={`${suggestion.reason} — ${suggestion.entityRef}`}
            >
              <Chip
                size="small"
                clickable
                disabled={isBusy}
                label={suggestion.displayName ?? suggestion.entityRef}
                onClick={() => onLink(suggestion.entityRef)}
              />
            </Tooltip>
          ))}
        </Box>
      )}

      <Box className={classes.manual}>
        <Autocomplete<PickerOption, false, false, true>
          freeSolo
          openOnFocus
          forcePopupIcon
          size="small"
          className={classes.input}
          options={options}
          groupBy={(option) => option.group}
          getOptionLabel={(option) => labelOf(option)}
          // The directory already answered for what was typed, and the likely
          // matches are offered whatever was typed; filtering again here would
          // hide a search hit whose name does not contain the address it was
          // found by.
          filterOptions={(candidates) => candidates}
          inputValue={inputValue}
          onInputChange={(_event, value, reason) => {
            setInputValue(value);
            // Typing after a pick means the pick no longer describes the field.
            if (reason === "input") setPicked(null);
          }}
          onChange={(_event, value) => {
            setPicked(value === null || typeof value === "string" ? null : value.user);
          }}
          loading={search.isSearching}
          loadingText="Searching the directory…"
          noOptionsText={noOptionsText}
          renderOption={(option) => <OptionRow option={option} />}
          renderInput={(parameters) => (
            <TextField
              {...parameters}
              size="small"
              label="Link to another user"
              placeholder="Name, address or user:default/name"
              helperText={searchNote}
              error={search.error !== null}
              inputProps={{
                ...parameters.inputProps,
                "aria-label": `Catalog user for ${row.identity.sourceKey}`,
              }}
              InputProps={{
                ...parameters.InputProps,
                endAdornment: (
                  <>
                    {search.isSearching ? (
                      <CircularProgress size={14} aria-label="Searching the directory" />
                    ) : null}
                    {parameters.InputProps.endAdornment}
                  </>
                ),
              }}
            />
          )}
        />
        <Button
          size="small"
          variant="outlined"
          disabled={isBusy || target === null}
          onClick={handleLink}
        >
          Link
        </Button>
      </Box>
    </Box>
  );
};
