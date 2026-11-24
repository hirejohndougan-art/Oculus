/**
 * Controls for the item screens (T-046) on React Aria Components (D-073):
 * a labelled text field (one line or several) with help and the server's
 * problems beside it, a labelled pick list, a status pill and a confirming
 * dialog. Every value is rendered as text by React, never as HTML.
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import {
  Button as AriaButton,
  FieldError,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
  Text,
  TextArea,
  TextField,
} from "react-aria-components";
import ui from "../components/ui.module.css";
import { STATE_LABELS, STATE_TONES, isWorkflowState } from "./model";
import styles from "./Records.module.css";

export interface TextInputProps {
  readonly label: ReactNode;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onBlur?: () => void;
  readonly help?: string | undefined;
  /** The server's problems with this value, shown under it and announced. */
  readonly errors?: readonly string[] | undefined;
  readonly multiline?: boolean;
  readonly isRequired?: boolean;
  readonly isReadOnly?: boolean;
  readonly maxLength?: number | undefined;
  readonly name?: string;
  readonly className?: string | undefined;
}

export function TextInput(props: TextInputProps) {
  const invalid = props.errors !== undefined && props.errors.length > 0;
  return (
    <TextField
      className={`${ui.field} ${props.className ?? ""}`}
      value={props.value}
      onChange={props.onChange}
      {...(props.onBlur === undefined ? {} : { onBlur: props.onBlur })}
      isRequired={props.isRequired ?? false}
      isReadOnly={props.isReadOnly ?? false}
      isInvalid={invalid}
      validationBehavior="aria"
      {...(props.name === undefined ? {} : { name: props.name })}
      {...(props.maxLength === undefined ? {} : { maxLength: props.maxLength })}
    >
      <Label className={ui.label}>{props.label}</Label>
      {props.multiline === true ? (
        <TextArea className={styles.textarea} />
      ) : (
        <Input className={ui.input} spellCheck={false} />
      )}
      {props.help === undefined || props.help === "" ? null : (
        <Text slot="description" className={ui.help}>
          {props.help}
        </Text>
      )}
      <FieldError className={ui.error}>{invalid ? props.errors.join(" ") : null}</FieldError>
    </TextField>
  );
}

export interface ChoiceOption {
  readonly id: string;
  readonly label: string;
}

/** A labelled pick list (React Aria Select). `""` is a valid id ("Any", "None"). */
export function Choice(props: {
  readonly label: ReactNode;
  readonly value: string;
  readonly options: readonly ChoiceOption[];
  readonly onChange: (value: string) => void;
  readonly help?: string | undefined;
  readonly errors?: readonly string[] | undefined;
  readonly isDisabled?: boolean;
  readonly isRequired?: boolean;
  readonly placeholder?: string;
  readonly className?: string | undefined;
}) {
  const invalid = props.errors !== undefined && props.errors.length > 0;
  // React Aria keys can't be "", so the empty choice travels as a marker.
  const NONE = "\u0000none";
  return (
    <Select
      className={`${styles.select} ${props.className ?? ""}`}
      value={props.value === "" ? NONE : props.value}
      onChange={(key) => {
        props.onChange(key === NONE || key === null ? "" : String(key));
      }}
      isDisabled={props.isDisabled ?? false}
      isRequired={props.isRequired ?? false}
      isInvalid={invalid}
      validationBehavior="aria"
      placeholder={props.placeholder ?? "Choose one"}
    >
      <Label className={ui.label}>{props.label}</Label>
      <AriaButton className={styles.selectButton}>
        <SelectValue />
        <span aria-hidden="true">▾</span>
      </AriaButton>
      {props.help === undefined ? null : (
        <Text slot="description" className={ui.help}>
          {props.help}
        </Text>
      )}
      <FieldError className={ui.error}>{invalid ? props.errors.join(" ") : null}</FieldError>
      <Popover className={styles.popover}>
        <ListBox className={styles.listbox}>
          {props.options.map((o) => (
            <ListBoxItem
              key={o.id === "" ? NONE : o.id}
              id={o.id === "" ? NONE : o.id}
              textValue={o.label}
              className={styles.option}
            >
              {o.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}

/** A workflow state as DESIGN.md's pill. */
export function StatePill(props: { readonly state: string }) {
  const known = isWorkflowState(props.state);
  const tone = known ? STATE_TONES[props.state] : "gray";
  return (
    <span className={`${styles.pill} ${styles[tone]}`}>
      {known ? STATE_LABELS[props.state] : props.state}
    </span>
  );
}

/**
 * A confirmation shown in the page, before something that can't be taken
 * back lightly. Focus moves to it when it opens (its heading is announced);
 * Tab reaches its buttons; Escape cancels. Not a modal: the rest of the page
 * stays as it is (a modal's overlay and focus trap hide the page's own
 * landmarks and skip link).
 */
export function ConfirmPanel(props: {
  readonly isOpen: boolean;
  readonly title: string;
  readonly children: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly danger?: boolean;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const id = useId();
  const ref = useRef<HTMLElement>(null);
  const { isOpen } = props;
  useEffect(() => {
    if (isOpen) ref.current?.focus();
  }, [isOpen]);
  if (!isOpen) return null;
  return (
    <section
      ref={ref}
      tabIndex={-1}
      className={styles.confirm}
      aria-labelledby={id}
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onCancel();
      }}
    >
      <h2 id={id} className={styles.sectionTitle}>
        {props.title}
      </h2>
      {props.children}
      <div className={styles.actions}>
        <AriaButton
          className={`${ui.button} ${props.danger === true ? styles.danger : ui.primary}`}
          isDisabled={props.busy ?? false}
          onPress={props.onConfirm}
        >
          {props.confirmLabel}
        </AriaButton>
        <AriaButton className={`${ui.button} ${ui.secondary}`} onPress={props.onCancel}>
          {props.cancelLabel ?? "Cancel"}
        </AriaButton>
      </div>
    </section>
  );
}
