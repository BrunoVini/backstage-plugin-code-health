import { Fragment } from "react";
import { formatCount } from "@rios0rios0/backstage-plugin-code-health-common";
import Box from "@material-ui/core/Box";
import Button from "@material-ui/core/Button";
import Paper from "@material-ui/core/Paper";
import Table from "@material-ui/core/Table";
import TableBody from "@material-ui/core/TableBody";
import TableCell from "@material-ui/core/TableCell";
import TableContainer from "@material-ui/core/TableContainer";
import TableHead from "@material-ui/core/TableHead";
import TableRow from "@material-ui/core/TableRow";
import TableSortLabel from "@material-ui/core/TableSortLabel";
import TextField from "@material-ui/core/TextField";
import Typography from "@material-ui/core/Typography";
import { makeStyles } from "@material-ui/core/styles";
import type { Column, RowData, Table as TanstackTable } from "@tanstack/react-table";
import { flexRender } from "@tanstack/react-table";

/**
 * One entry of a select filter, when the value the filter function compares is
 * not what a reader should be reading.
 *
 * A bare string is still accepted and shows itself, which is right for a
 * branch name or a language. It is wrong for everything whose stored value is
 * a colour or a state name: the Compliance filter offered `red` and `yellow`
 * while the chip beside it said "Non-compliant" and "Partial", leaving the
 * reader to work out that they were the same two things.
 */
export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

declare module "@tanstack/react-table" {
  interface ColumnMeta<TData extends RowData, TValue> {
    filterType?: "select";
    options?: readonly (string | FilterOption)[];
    /** Present only to satisfy the declaration merge signature. */
    _phantom?: [TData, TValue];
  }
}

const asFilterOption = (option: string | FilterOption): FilterOption =>
  typeof option === "string" ? { value: option, label: option } : option;

/**
 * The page sizes every table offers, and the one it opens with.
 *
 * One list for all of them, so a reader who has picked fifty rows on the
 * repositories table finds the same fifty on offer on the contributors table
 * next to it. Ten is there for a card that shares its page with a dozen
 * charts, where twenty-five rows would push everything below it off screen.
 */
export const PAGE_SIZE_OPTIONS: readonly number[] = [10, 25, 50, 100];

export const DEFAULT_PAGE_SIZE = 25;

const useStyles = makeStyles((theme) => ({
  headerCell: {
    whiteSpace: "nowrap",
    textTransform: "uppercase",
    fontSize: theme.typography.pxToRem(11),
    letterSpacing: "0.05em",
  },
  filterCell: {
    paddingTop: 0,
    paddingBottom: theme.spacing(1),
  },
  bodyCell: {
    whiteSpace: "nowrap",
  },
  pageSize: { minWidth: 96 },
  skeleton: {
    height: 14,
    width: 64,
    borderRadius: theme.shape.borderRadius,
    backgroundColor: theme.palette.action.hover,
    animation: "$pulse 1.5s ease-in-out infinite",
  },
  "@keyframes pulse": {
    "0%, 100%": { opacity: 1 },
    "50%": { opacity: 0.4 },
  },
}));

const ColumnFilter = <T,>({ column }: { column: Column<T, unknown> }) => {
  const meta = column.columnDef.meta;
  const value = (column.getFilterValue() as string) ?? "";
  const handleChange = (event: React.ChangeEvent<{ value: unknown }>) =>
    column.setFilterValue((event.target.value as string) || undefined);

  if (meta?.filterType === "select") {
    return (
      <TextField
        select
        size="small"
        fullWidth
        value={value}
        onChange={handleChange}
        SelectProps={{ native: true }}
        inputProps={{ "aria-label": `Filter ${column.id}` }}
      >
        <option value="">All</option>
        {meta.options
          ?.map(asFilterOption)
          // The blank value is the "any" option above, so an entry carrying it
          // would draw a second one.
          .filter((option) => option.value !== "")
          .map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
      </TextField>
    );
  }

  return (
    <TextField
      size="small"
      fullWidth
      value={value}
      onChange={handleChange}
      placeholder="Filter..."
      inputProps={{ "aria-label": `Filter ${column.id}` }}
    />
  );
};

export interface PaginationControlsProps<T> {
  readonly table: TanstackTable<T>;
}

/**
 * The page size, and the way from one page to the next.
 *
 * Drawn whenever the table has rows, one page or ten. The controls used to
 * appear only past the first page, which made pagination look like something
 * the repositories table had and the contributors table did not, on any fleet
 * with more repositories than people — and left nobody a way to ask for a
 * shorter page. The size lives here rather than on each table so it is one
 * control, in one place, on every table that pages.
 */
export const PaginationControls = <T,>({ table }: PaginationControlsProps<T>) => {
  const classes = useStyles();
  const { pageIndex, pageSize } = table.getState().pagination;
  const pageCount = Math.max(table.getPageCount(), 1);

  return (
    <Box display="flex" alignItems="center" flexWrap="wrap" gridGap={8}>
      <TextField
        select
        size="small"
        label="Rows per page"
        className={classes.pageSize}
        value={pageSize}
        onChange={(event) => table.setPageSize(Number(event.target.value))}
        SelectProps={{ native: true }}
        // A native select always renders whichever option is current, so its
        // label has to be shrunk unconditionally or it is drawn across it.
        InputLabelProps={{ shrink: true }}
        inputProps={{ "aria-label": "Rows per page" }}
      >
        {PAGE_SIZE_OPTIONS.map((size) => (
          <option key={size} value={size}>
            {size}
          </option>
        ))}
      </TextField>
      <Button
        size="small"
        variant="outlined"
        disabled={!table.getCanPreviousPage()}
        onClick={() => table.previousPage()}
      >
        Previous
      </Button>
      <Typography variant="caption" color="textSecondary">
        {formatCount(pageIndex + 1)} / {formatCount(pageCount)}
      </Typography>
      <Button
        size="small"
        variant="outlined"
        disabled={!table.getCanNextPage()}
        onClick={() => table.nextPage()}
      >
        Next
      </Button>
    </Box>
  );
};

interface DataTableProps<T> {
  table: TanstackTable<T>;
  isLoading: boolean;
  skeletonRows?: number;
  /** What the table is a table of, for assistive technology. */
  label?: string;
  /** A class for a row that has to look different from its neighbours. */
  rowClassName?: (row: T) => string | undefined;
}

export const DataTable = <T,>({
  table,
  isLoading,
  skeletonRows = 8,
  label,
  rowClassName,
}: DataTableProps<T>) => {
  const classes = useStyles();
  const columnCount = table.getAllLeafColumns().length;

  return (
    <TableContainer component={Paper} variant="outlined">
      <Table size="small" aria-label={label}>
        <TableHead>
          {table.getHeaderGroups().map((headerGroup) => (
            <Fragment key={headerGroup.id}>
              <TableRow>
                {headerGroup.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <TableCell
                      key={header.id}
                      className={classes.headerCell}
                      sortDirection={sorted === false ? false : sorted}
                    >
                      <TableSortLabel
                        active={sorted !== false}
                        direction={sorted === "desc" ? "desc" : "asc"}
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </TableSortLabel>
                    </TableCell>
                  );
                })}
              </TableRow>
              <TableRow>
                {headerGroup.headers.map((header) => (
                  <TableCell key={header.id} className={classes.filterCell}>
                    {header.column.getCanFilter() ? <ColumnFilter column={header.column} /> : null}
                  </TableCell>
                ))}
              </TableRow>
            </Fragment>
          ))}
        </TableHead>
        {/* Named so an assertion about a cell can say it means a cell. Several
            filter selects carry the same words their column's cells do — a
            branch name, "Passed", "Compliant" — because the filter says what
            the badge beside it says, and a document-wide text query matches
            both. */}
        <TableBody data-testid="tableBody">
          {isLoading
            ? Array.from({ length: skeletonRows }, (_, rowIndex) => (
                <TableRow key={rowIndex} data-testid="loadingRow">
                  {Array.from({ length: columnCount }, (__, cellIndex) => (
                    <TableCell key={cellIndex}>
                      <div className={classes.skeleton} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            : table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} hover className={rowClassName?.(row.original)}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className={classes.bodyCell}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
};
