// Every table in this module sorts with core's shared helpers:
// coreApi.useSortedRows (natural order, saved per user under
// `<rememberAs>.sort`) and coreApi.ui.SortHeader (the ascending and
// descending buttons). Components import them from here so they do not each
// need coreApi handed down. The module has no sorting of its own: on a core
// without these helpers the tables simply show the rows in the order they came.
import React from 'react';
import { useCoreApi } from './pageState';

function useCoreSort(core, rows, columns, options) {
  return core.useSortedRows(rows, columns, options);
}

function useUnsorted(core, rows) {
  return { rows, sort: null };
}

// Call at the top level of the component, before any early return. `columns`
// gives each column's RAW value (a number, a timestamp), not the cell text.
export function useSortedRows(rows, columns, options) {
  const core = useCoreApi();
  const useImpl = core && typeof core.useSortedRows === 'function' ? useCoreSort : useUnsorted;
  return useImpl(core, rows, columns, options);
}

export function SortHeader({ table, column, label, children, ...cellProps }) {
  const core = useCoreApi();
  const CoreHeader = core && core.ui ? core.ui.SortHeader : null;
  if (CoreHeader && table.toggle) {
    return <CoreHeader table={table} column={column} label={label} {...cellProps}>{children}</CoreHeader>;
  }
  return <th {...cellProps}>{children}</th>;
}
