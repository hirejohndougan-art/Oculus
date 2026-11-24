/**
 * Item records (DESIGN.md §8 "Items", T-046): the working site's records,
 * searched with staff search or listed newest change first or by title,
 * filtered by status and record type, a page at a time. Search words and
 * filters stay in this tab's memory (never in the page's address or in
 * storage), so coming back from a record finds the list as it was.
 */
import { useState } from "react";
import { useLocation } from "react-router";
import { Link as AriaLink } from "react-aria-components";
import { problemText } from "../api";
import { Button, Note, TextLink } from "../components/ui";
import ui from "../components/ui.module.css";
import { Choice, StatePill, TextInput } from "./controls";
import { KIND_LABELS, STATE_LABELS, recordPath, whenText } from "./model";
import { useItems, useRecordTypes, useSiteAbilities, type ListParams } from "./queries";
import styles from "./Records.module.css";

/** The list's state per site, for this tab only (memory; gone on reload). */
const remembered = new Map<string, { params: ListParams; pages: (string | undefined)[] }>();

/** Forgets every list's search words and filters (signing out). */
export function forgetLists(): void {
  remembered.clear();
}

const START: ListParams = { q: "", state: "", type: "", sort: "updated", after: undefined };

export function ItemList(props: { readonly siteId: string; readonly siteName: string }) {
  const { siteId } = props;
  const location = useLocation();
  const notice = (location.state as { notice?: unknown } | null)?.notice;
  const saved = remembered.get(siteId);
  const [params, setParamsState] = useState<ListParams>(saved?.params ?? START);
  // The `after` of every page shown so far, for "Previous page".
  const [pages, setPagesState] = useState<(string | undefined)[]>(saved?.pages ?? [undefined]);
  const [words, setWords] = useState(saved?.params.q ?? "");
  const items = useItems(siteId, params);
  const types = useRecordTypes(siteId);
  const abilities = useSiteAbilities(siteId);

  function update(next: ListParams, nextPages: (string | undefined)[]) {
    setParamsState(next);
    setPagesState(nextPages);
    remembered.set(siteId, { params: next, pages: nextPages });
  }
  function filter(change: Partial<ListParams>) {
    update({ ...params, ...change, after: undefined }, [undefined]);
  }
  function search(event: { preventDefault: () => void }) {
    event.preventDefault();
    filter({ q: words });
  }

  const searching = params.q.trim() !== "";
  const canCreate = (abilities.data?.createKinds.length ?? 0) > 0;
  const typeLabel = (key: string | null) =>
    key === null ? "" : (types.data?.find((t) => t.key === key)?.label ?? key);
  const records = items.data?.records ?? [];
  const filtered = searching || params.state !== "" || params.type !== "";

  return (
    <>
      <div className={styles.header}>
        <div>
          <h1 className={styles.pageTitle}>{props.siteName}</h1>
          <p className={styles.lead}>
            Item records: every photo, letter, map, recording and object on this site. Search them,
            or narrow the list by status and type.
          </p>
        </div>
        {canCreate ? (
          <div className={styles.actions}>
            <AriaLink
              className={`${ui.button} ${ui.primary}`}
              href={`/sites/${siteId}/records/new`}
            >
              + Catalog an item
            </AriaLink>
          </div>
        ) : null}
      </div>

      {typeof notice === "string" ? <Note tone="green">{notice}</Note> : null}

      <form className={styles.filters} onSubmit={search} role="search" aria-label="Item records">
        <div className={styles.search}>
          <TextInput
            className={styles.searchField}
            label="Search this site's records"
            help="Words from titles and fields, or an ID number."
            value={words}
            onChange={setWords}
            name="q"
          />
          <Button variant="dark" type="submit">
            Search
          </Button>
          {searching ? (
            <Button
              variant="secondary"
              onPress={() => {
                setWords("");
                filter({ q: "" });
              }}
            >
              Clear search
            </Button>
          ) : null}
        </div>
        <Choice
          label="Status"
          value={params.state}
          onChange={(state) => {
            filter({ state });
          }}
          options={[
            { id: "", label: "Any status" },
            ...Object.entries(STATE_LABELS).map(([id, label]) => ({ id, label })),
          ]}
        />
        <Choice
          label="Record type"
          value={params.type}
          onChange={(type) => {
            filter({ type });
          }}
          options={[
            { id: "", label: "Any type" },
            ...(types.data ?? []).map((t) => ({ id: t.key, label: t.label })),
          ]}
        />
        <Choice
          label="Order"
          value={searching ? "best" : params.sort}
          isDisabled={searching}
          help={searching ? "Search results come best match first." : undefined}
          onChange={(sort) => {
            filter({ sort: sort === "title" ? "title" : "updated" });
          }}
          options={
            searching
              ? [{ id: "best", label: "Best match" }]
              : [
                  { id: "updated", label: "Last changed first" },
                  { id: "title", label: "Title, A to Z" },
                ]
          }
        />
      </form>

      <div aria-live="polite" aria-busy={items.isFetching}>
        {items.isPending ? (
          <p role="status">Loading records…</p>
        ) : items.isError ? (
          <div className={styles.actions}>
            <Note tone="amber" alert>
              The records couldn't be loaded. {problemText(items.error)}
            </Note>
            <Button
              variant="secondary"
              onPress={() => {
                void items.refetch();
              }}
            >
              Load the records again
            </Button>
          </div>
        ) : records.length === 0 ? (
          <div className={styles.empty}>
            {filtered ? (
              <p>No records match. Try other words, or clear the filters.</p>
            ) : (
              <p>This site has no records yet.</p>
            )}
            {canCreate && !filtered ? (
              <TextLink href={`/sites/${siteId}/records/new`}>Catalog the first item</TextLink>
            ) : null}
          </div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>
                {searching ? "Search results" : "Records"}, page {String(pages.length)}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Kind and type</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last changed</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => {
                  const href = recordPath(siteId, r.recordId);
                  return (
                    <tr key={r.recordId}>
                      <td>
                        {href === undefined ? r.title : <TextLink href={href}>{r.title}</TextLink>}
                      </td>
                      <td>
                        {KIND_LABELS[r.kind] ?? r.kind}
                        {r.recordTypeKey === null ? null : ` · ${typeLabel(r.recordTypeKey)}`}
                      </td>
                      <td>
                        <StatePill state={r.state} />
                      </td>
                      <td>{whenText(r.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {pages.length > 1 || (items.data?.next ?? null) !== null ? (
        <nav className={styles.pager} aria-label="Pages">
          <Button
            variant="secondary"
            isDisabled={pages.length <= 1}
            onPress={() => {
              const back = pages.slice(0, -1);
              update({ ...params, after: back.at(-1) }, back);
            }}
          >
            Previous page
          </Button>
          <Button
            variant="secondary"
            isDisabled={(items.data?.next ?? null) === null}
            onPress={() => {
              const next = items.data?.next ?? undefined;
              if (next === undefined) return;
              update({ ...params, after: next }, [...pages, next]);
            }}
          >
            Next page
          </Button>
        </nav>
      ) : null}
    </>
  );
}
