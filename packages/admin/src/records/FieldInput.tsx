/**
 * One template field in the record editor (D-073: one input per field kind):
 * text, long text and dates as text fields, pick lists as a select, and the
 * structured kinds (controlled term, identifier, link, rights, place, record
 * link) as a group of labelled parts. A repeatable field holds a list with
 * "Add another" and "Remove". The value the record inherits (D-013) shows
 * under the field while the record has none of its own; the server's
 * problems show beside the field.
 */
import type { ReactNode } from "react";
import { Button, TextLink } from "../components/ui";
import { Choice, TextInput } from "./controls";
import {
  PARTS,
  PART_LABELS,
  emptyPart,
  recordPath,
  storedValueOf,
  valueText,
  type FieldDefinition,
  type FormValue,
  type InheritedValue,
  type PartValue,
} from "./model";
import styles from "./Records.module.css";

const DATE_HELP = "An EDTF date: 1909, 1909-04-25, 1909~ for about 1909, 195X for the 1950s.";

export interface FieldInputProps {
  readonly field: FieldDefinition;
  readonly value: FormValue;
  readonly onChange: (value: FormValue) => void;
  readonly onBlur: () => void;
  readonly errors: readonly string[] | undefined;
  readonly inherited: InheritedValue | undefined;
  readonly siteId: string;
  readonly isReadOnly: boolean;
}

function labelOf(field: FieldDefinition) {
  return (
    <>
      {field.label}
      {field.required ? " (required)" : null}
      {field.visibility === "staff" ? <span className={styles.tag}>Staff only</span> : null}
    </>
  );
}

function helpOf(field: FieldDefinition): string | undefined {
  const parts: string[] = [];
  if (field.help !== undefined) parts.push(field.help);
  if (field.kind === "date") parts.push(DATE_HELP);
  if (field.visibility === "staff") parts.push("Never shown on public sites.");
  return parts.length === 0 ? undefined : parts.join(" ");
}

/** One value: a text input, a pick list, or a group of parts. */
function OneValue(props: {
  readonly field: FieldDefinition;
  readonly value: PartValue;
  readonly onChange: (value: PartValue) => void;
  readonly onBlur: () => void;
  readonly label: ReactNode;
  readonly help: string | undefined;
  readonly errors: readonly string[] | undefined;
  readonly isReadOnly: boolean;
}) {
  const { field } = props;
  const parts = PARTS[field.kind];
  if (parts === undefined || typeof props.value === "string") {
    const text = typeof props.value === "string" ? props.value : "";
    if (field.kind === "list") {
      return (
        <Choice
          label={props.label}
          value={text}
          help={props.help}
          errors={props.errors}
          isDisabled={props.isReadOnly}
          isRequired={field.required}
          onChange={(v) => {
            props.onChange(v);
            props.onBlur();
          }}
          options={[
            { id: "", label: "None" },
            ...(field.options ?? []).map((o) => ({ id: o.value, label: o.label })),
          ]}
        />
      );
    }
    return (
      <TextInput
        label={props.label}
        value={text}
        onChange={props.onChange}
        onBlur={props.onBlur}
        help={props.help}
        errors={props.errors}
        multiline={field.kind === "long_text"}
        isRequired={field.required}
        isReadOnly={props.isReadOnly}
        maxLength={field.maxLength}
      />
    );
  }
  const value = props.value;
  const set = (part: string, v: string) => {
    props.onChange({ ...value, [part]: v });
  };
  return (
    <fieldset className={styles.fieldset}>
      <legend className={styles.legend}>{props.label}</legend>
      {props.help === undefined ? null : <p className={styles.meta}>{props.help}</p>}
      <div className={styles.parts}>
        {parts.map((part) => {
          const choices =
            part === "type" && field.identifierTypes !== undefined
              ? field.identifierTypes
              : part === "vocabulary" && field.vocabularies !== undefined
                ? field.vocabularies
                : undefined;
          if (choices !== undefined) {
            return (
              <Choice
                key={part}
                label={PART_LABELS[part] ?? part}
                value={value[part] ?? ""}
                isDisabled={props.isReadOnly}
                onChange={(v) => {
                  set(part, v);
                  props.onBlur();
                }}
                options={[
                  { id: "", label: part === "vocabulary" ? "Local term" : "None" },
                  ...choices.map((c) => ({ id: c, label: c })),
                ]}
              />
            );
          }
          return (
            <TextInput
              key={part}
              label={PART_LABELS[part] ?? part}
              value={value[part] ?? ""}
              onChange={(v) => {
                set(part, v);
              }}
              onBlur={props.onBlur}
              isReadOnly={props.isReadOnly}
            />
          );
        })}
      </div>
      {props.errors === undefined || props.errors.length === 0 ? null : (
        <p className={styles.issues} role="alert">
          {props.errors.join(" ")}
        </p>
      )}
    </fieldset>
  );
}

/** A single field's value (a list's first entry, should a stored value be a list). */
function firstValue(value: FormValue, field: FieldDefinition): PartValue {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const list = value as readonly PartValue[];
    return list[0] ?? emptyPart(field.kind);
  }
  return value as PartValue;
}

export function FieldInput(props: FieldInputProps) {
  const { field } = props;
  const help = helpOf(field);
  const own = storedValueOf(field, props.value);
  const inherited =
    own === undefined && props.inherited !== undefined ? (
      <p className={styles.inherited}>
        Inherited from{" "}
        {recordPath(props.siteId, props.inherited.from) === undefined ? (
          "a unit above"
        ) : (
          <TextLink href={recordPath(props.siteId, props.inherited.from) ?? ""}>
            the unit above
          </TextLink>
        )}
        : {valueText(props.inherited.value)}. A value here replaces it for this record.
      </p>
    ) : null;
  const wide =
    field.kind === "long_text" || field.repeatable || PARTS[field.kind] !== undefined
      ? styles.wide
      : "";

  if (!field.repeatable) {
    return (
      <div className={wide}>
        <OneValue
          field={field}
          value={firstValue(props.value, field)}
          onChange={props.onChange}
          onBlur={props.onBlur}
          label={labelOf(field)}
          help={help}
          errors={props.errors}
          isReadOnly={props.isReadOnly}
        />
        {inherited}
      </div>
    );
  }

  const list: readonly PartValue[] = Array.isArray(props.value)
    ? props.value
    : [props.value as PartValue];
  return (
    <fieldset className={`${styles.fieldset} ${wide}`}>
      <legend className={styles.legend}>{labelOf(field)}</legend>
      {help === undefined ? null : <p className={styles.meta}>{help}</p>}
      {list.map((entry, index) => (
        <div className={styles.entry} key={index}>
          <OneValue
            field={field}
            value={entry}
            onChange={(v) => {
              props.onChange(list.map((e, i) => (i === index ? v : e)));
            }}
            onBlur={props.onBlur}
            label={`${field.label} ${String(index + 1)} of ${String(list.length)}`}
            help={undefined}
            errors={undefined}
            isReadOnly={props.isReadOnly}
          />
          {props.isReadOnly || list.length <= 1 ? null : (
            <div>
              <Button
                variant="link"
                onPress={() => {
                  props.onChange(list.filter((_, i) => i !== index));
                  props.onBlur();
                }}
              >
                Remove {field.label} {String(index + 1)}
              </Button>
            </div>
          )}
        </div>
      ))}
      {props.isReadOnly ? null : (
        <div>
          <Button
            variant="secondary"
            onPress={() => {
              props.onChange([...list, emptyPart(field.kind)]);
            }}
          >
            Add another {field.label}
          </Button>
        </div>
      )}
      {props.errors === undefined || props.errors.length === 0 ? null : (
        <p className={styles.issues} role="alert">
          {props.errors.join(" ")}
        </p>
      )}
      {inherited}
    </fieldset>
  );
}
